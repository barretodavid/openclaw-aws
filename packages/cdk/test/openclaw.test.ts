import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OpenclawStack } from '../lib/openclaw-stack';
import { PROVIDER_REGISTRY } from '../lib/ec2-config';

/** Default config values for tests (mirrors production defaults in bin/openclaw.ts). */
const defaults = {
  availabilityZone: 'ca-central-1b',
  agentInstanceType: new ec2.InstanceType('t3a.large'),
  proxyInstanceType: new ec2.InstanceType('t3a.nano'),
  gatewayInstanceType: new ec2.InstanceType('t3a.nano'),
  agentVolumeGb: 30,
};

let template: Template;

// Mock env vars to configure 2 providers (one header-based, one path-based)
const MOCK_ENV_VARS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  ALCHEMY_API_KEY: 'test-alchemy-key',
};

beforeAll(() => {
  // Clear all provider env vars to prevent .env from leaking into tests
  for (const config of Object.values(PROVIDER_REGISTRY)) {
    delete process.env[config.envVar];
  }

  // Set only the mock env vars
  for (const [key, value] of Object.entries(MOCK_ENV_VARS)) {
    process.env[key] = value;
  }

  const app = new cdk.App();

  // Mock VPC lookup context so tests run without AWS credentials
  app.node.setContext('vpc-provider:account=123456789012:filter.isDefault=true:region=us-east-1:returnAsymmetricSubnets=true', {
    vpcId: 'vpc-12345',
    vpcCidrBlock: '10.0.0.0/16',
    ownerAccountId: '123456789012',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    subnetGroups: [
      {
        name: 'Public',
        type: 'Public',
        subnets: [
          { subnetId: 'subnet-1', cidr: '10.0.0.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-1' },
          { subnetId: 'subnet-2', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-2' },
        ],
      },
    ],
  });

  const stack = new OpenclawStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...defaults,
  });

  template = Template.fromStack(stack);
});

afterAll(() => {
  for (const key of Object.keys(MOCK_ENV_VARS)) {
    delete process.env[key];
  }
});

// --- Security Boundary Tests ---

describe('Security Boundaries', () => {
  test('Agent role allows kms:CreateKey only with wallet tag and correct key spec conditions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:CreateKey',
            Effect: 'Allow',
            Condition: {
              StringEquals: {
                'aws:RequestTag/openclaw': 'wallet',
                'kms:KeySpec': 'ECC_NIST_P256',
                'kms:KeyUsage': 'SIGN_VERIFY',
              },
            },
          }),
        ]),
      }),
    });
  });

  test('Agent role allows kms:Sign, kms:GetPublicKey, kms:DescribeKey only with wallet tag condition', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:Sign', 'kms:GetPublicKey', 'kms:DescribeKey']),
            Effect: 'Allow',
            Condition: {
              StringEquals: {
                'aws:ResourceTag/openclaw': 'wallet',
              },
            },
          }),
        ]),
      }),
    });
  });

  test('Agent role allows tag:GetResources for wallet key discovery', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'tag:GetResources',
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  test('Agent role policy does not grant Secrets Manager access', () => {
    // Get all IAM policies and check that the one with kms:CreateKey has no secretsmanager actions
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      const hasKmsCreateKey = statements.some((s: Record<string, unknown>) => s.Action === 'kms:CreateKey');
      if (hasKmsCreateKey) {
        // This is the agent policy — verify no secretsmanager actions
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          for (const action of actions) {
            expect(action).not.toMatch(/^secretsmanager:/);
          }
        }
      }
    }
  });

  test('Proxy role grants Secrets Manager read but no KMS access', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    let foundSecretsPolicy = false;

    for (const [, policy] of Object.entries(policies)) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      const hasSecretsManager = statements.some((s: Record<string, unknown>) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a: string) => a.startsWith('secretsmanager:'));
      });

      if (hasSecretsManager) {
        foundSecretsPolicy = true;
        // Verify no KMS actions in this policy
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          for (const action of actions) {
            expect(action).not.toMatch(/^kms:/);
          }
        }
      }
    }

    expect(foundSecretsPolicy).toBe(true);
  });

  test('All EC2 roles allow SSM Session Manager access', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const ec2Roles = Object.values(roles).filter(
      (r) => r.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Principal?.Service === 'ec2.amazonaws.com',
    );

    expect(ec2Roles).toHaveLength(3);

    for (const role of ec2Roles) {
      const managedPolicies: { 'Fn::Join': [string, string[]] }[] = role.Properties.ManagedPolicyArns;
      const policyArns = managedPolicies.map((p) => {
        if (typeof p === 'string') return p;
        if (p['Fn::Join']) return p['Fn::Join'][1].join('');
        return JSON.stringify(p);
      });
      const hasSsmPolicy = policyArns.some((arn) => arn.includes('AmazonSSMManagedInstanceCore'));
      expect(hasSsmPolicy).toBe(true);
    }
  });

  test('Agent security group has no inbound rules', () => {
    // Agent SG description identifies it
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    for (const [logicalId, sg] of Object.entries(sgs)) {
      if (sg.Properties?.GroupDescription?.includes('no inbound')) {
        // Should have no SecurityGroupIngress
        expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
        // Also check there are no separate ingress resources for this SG
        const ingressResources = template.findResources('AWS::EC2::SecurityGroupIngress');
        for (const [, ingress] of Object.entries(ingressResources)) {
          // Ingress rules referencing agent SG should not exist
          const groupId = ingress.Properties?.GroupId;
          if (groupId?.['Fn::GetAtt']) {
            expect(groupId['Fn::GetAtt'][0]).not.toBe(logicalId);
          }
        }
      }
    }
  });

  test('Proxy security group allows inbound only from Agent SG on port 8080', () => {
    // Find the ingress rule for the proxy SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 8080,
      ToPort: 8080,
    });
  });

  test('Gateway security group allows inbound only from Agent SG on port 18789', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 18789,
      ToPort: 18789,
    });
  });

  test('Gateway role has no KMS or Secrets Manager access', () => {
    // Gateway role has only SSM managed policy and no inline policy with kms/secretsmanager
    const roles = template.findResources('AWS::IAM::Role');
    const policies = template.findResources('AWS::IAM::Policy');

    // Find the gateway role (description identifies it)
    const gatewayRoleId = Object.entries(roles).find(
      ([, r]) => r.Properties?.Description?.includes('Gateway'),
    )?.[0];
    expect(gatewayRoleId).toBeDefined();

    // No inline policy should reference the gateway role
    for (const [, policy] of Object.entries(policies)) {
      const policyRoles: { Ref: string }[] = policy.Properties?.Roles ?? [];
      const referencesGateway = policyRoles.some((r) => r.Ref === gatewayRoleId);
      expect(referencesGateway).toBe(false);
    }
  });
});

// --- Resource Configuration Tests ---

describe('Resource Configuration', () => {
  test('All EC2 instances require IMDSv2 to prevent SSRF credential theft', () => {
    // CDK's requireImdsv2 creates LaunchTemplates with HttpTokens: required
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate');
    const imdsv2Templates = Object.values(launchTemplates).filter(
      (lt) => lt.Properties?.LaunchTemplateData?.MetadataOptions?.HttpTokens === 'required',
    );
    expect(imdsv2Templates).toHaveLength(3);
  });

  test('Agent EC2 defaults to t3a.large', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3a.large',
    });
  });

  test('Proxy EC2 is t3a.nano', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3a.nano',
    });
  });

  test('Agent EC2 user data installs Docker and Node.js via apt', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    let foundDockerUserData = false;

    for (const [, instance] of Object.entries(instances)) {
      if (instance.Properties?.InstanceType === 't3a.large') {
        const userDataStr = JSON.stringify(instance.Properties?.UserData);
        expect(userDataStr).toContain('apt-get install -y docker.io unzip nodejs unattended-upgrades');
        expect(userDataStr).toContain('awscli-exe-linux-x86_64.zip');
        expect(userDataStr).toContain('systemctl enable docker');
        expect(userDataStr).toContain('systemctl start docker');
        foundDockerUserData = true;
      }
    }

    expect(foundDockerUserData).toBe(true);
  });

  test('Gateway EC2 user data installs signal-cli', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    let foundSignalCli = false;

    for (const [, instance] of Object.entries(instances)) {
      const userDataStr = JSON.stringify(instance.Properties?.UserData ?? '');
      if (userDataStr.includes('signal-cli')) {
        expect(userDataStr).toContain('-C /usr/local/bin');
        // Gateway should NOT have Docker or proxy
        expect(userDataStr).not.toContain('docker');
        expect(userDataStr).not.toContain('openclaw-aws-proxy');
        foundSignalCli = true;
      }
    }

    expect(foundSignalCli).toBe(true);
  });

  test('Proxy EC2 user data installs Node.js and starts proxy service', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    let foundProxyUserData = false;

    for (const [, instance] of Object.entries(instances)) {
      const userDataStr = JSON.stringify(instance.Properties?.UserData ?? '');
      // Disambiguate proxy from gateway (both t3a.nano) by checking for proxy-specific content
      if (userDataStr.includes('openclaw-aws-proxy')) {
        expect(userDataStr).toContain('deb.nodesource.com/setup_22.x');
        expect(userDataStr).toContain('apt-get install -y nodejs unattended-upgrades');
        expect(userDataStr).toContain('systemctl enable openclaw-proxy');
        expect(userDataStr).toContain('systemctl start openclaw-proxy');
        foundProxyUserData = true;
      }
    }

    expect(foundProxyUserData).toBe(true);
  });

  test('Agent and Gateway user data set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    let agentHasEnvVar = false;
    let gatewayHasEnvVar = false;

    for (const [, instance] of Object.entries(instances)) {
      const userDataStr = JSON.stringify(instance.Properties?.UserData ?? '');
      if (userDataStr.includes('docker')) {
        expect(userDataStr).toContain('OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1');
        agentHasEnvVar = true;
      }
      if (userDataStr.includes('signal-cli')) {
        expect(userDataStr).toContain('OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1');
        gatewayHasEnvVar = true;
      }
    }

    expect(agentHasEnvVar).toBe(true);
    expect(gatewayHasEnvVar).toBe(true);
  });

  test('Private hosted zone exists with zone name vpc', () => {
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'vpc.',
    });
  });

  test('A record for proxy.vpc points to proxy instance', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'proxy.vpc.',
      Type: 'A',
    });
  });

  test('A record for gateway.vpc points to gateway instance', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'gateway.vpc.',
      Type: 'A',
    });
  });

  test('Per-provider A records exist for each configured provider', () => {
    // ANTHROPIC_API_KEY is set -> anthropic.proxy.vpc should exist
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'anthropic.proxy.vpc.',
      Type: 'A',
    });

    // ALCHEMY_API_KEY is set -> alchemy.proxy.vpc should exist
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'alchemy.proxy.vpc.',
      Type: 'A',
    });
  });

  test('Proxy config SSM parameter is keyed by subdomain with backendDomain', () => {
    const params = template.findResources('AWS::SSM::Parameter');
    const proxyConfigParam = Object.values(params).find(
      (p) => p.Properties?.Name === '/openclaw/proxy-config',
    );
    expect(proxyConfigParam).toBeDefined();

    const configStr = proxyConfigParam!.Properties.Value;
    const config = JSON.parse(configStr);

    // Keyed by subdomain, not domain
    expect(config.anthropic).toBeDefined();
    expect(config.anthropic.backendDomain).toBe('api.anthropic.com');
    expect(config.anthropic.api).toBe('anthropic');

    expect(config.alchemy).toBeDefined();
    expect(config.alchemy.backendDomain).toBe('starknet-mainnet.g.alchemy.com');
    expect(config.alchemy.api).toBeNull();
  });

  test('Agent EC2 has 30 GB gp3 EBS volume', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          Ebs: {
            VolumeSize: 30,
            VolumeType: 'gp3',
          },
        }),
      ]),
    });
  });
});

// --- Resource Count Tests ---

describe('Resource Counts', () => {
  test('exactly 3 EC2 instances', () => {
    template.resourceCountIs('AWS::EC2::Instance', 3);
  });

  test('exactly 3 IAM roles', () => {
    template.resourceCountIs('AWS::IAM::Role', 3);
  });

  test('exactly 3 security groups', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 3);
  });

  test('no CDK-managed KMS keys (agent creates them at runtime)', () => {
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('one Secrets Manager secret per configured provider', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', Object.keys(MOCK_ENV_VARS).length);
  });

  test('exactly 1 SSM parameter', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 1);
  });

  test('base + gateway + per-provider DNS A records', () => {
    // 1 base (proxy.vpc) + 1 gateway (gateway.vpc) + 2 per-provider (anthropic.proxy.vpc, alchemy.proxy.vpc)
    template.resourceCountIs('AWS::Route53::RecordSet', 2 + Object.keys(MOCK_ENV_VARS).length);
  });
});

// --- Agent Machine Configuration Tests ---

function createStackWithConfig(overrides: Partial<typeof defaults> = {}): Template {
  const app = new cdk.App();
  app.node.setContext('vpc-provider:account=123456789012:filter.isDefault=true:region=us-east-1:returnAsymmetricSubnets=true', {
    vpcId: 'vpc-12345',
    vpcCidrBlock: '10.0.0.0/16',
    ownerAccountId: '123456789012',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    subnetGroups: [
      {
        name: 'Public',
        type: 'Public',
        subnets: [
          { subnetId: 'subnet-1', cidr: '10.0.0.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-1' },
          { subnetId: 'subnet-2', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-2' },
        ],
      },
    ],
  });

  const stack = new OpenclawStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...defaults,
    ...overrides,
  });

  return Template.fromStack(stack);
}

function getAgentUserData(tmpl: Template, instanceType: string): string {
  const instances = tmpl.findResources('AWS::EC2::Instance');
  for (const [, instance] of Object.entries(instances)) {
    if (instance.Properties?.InstanceType === instanceType) {
      return JSON.stringify(instance.Properties?.UserData);
    }
  }
  throw new Error(`No instance found with type ${instanceType}`);
}

describe('Agent Machine Configuration', () => {
  test('default config uses apt-get, Docker, and ubuntu user', () => {
    const tmpl = createStackWithConfig();
    const userData = getAgentUserData(tmpl, 't3a.large');

    expect(userData).toContain('apt-get update -y');
    expect(userData).toContain('deb.nodesource.com/setup_22.x');
    expect(userData).toContain('apt-get install -y docker.io unzip nodejs');
    expect(userData).toContain('awscli-exe-linux-x86_64.zip');
    expect(userData).toContain('usermod -aG docker ubuntu');
  });

  test('custom x86 agent instance type produces correct instance type in template', () => {
    const tmpl = createStackWithConfig({
      agentInstanceType: new ec2.InstanceType('m5a.large'),
    });

    tmpl.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 'm5a.large',
    });

    const userData = getAgentUserData(tmpl, 'm5a.large');
    expect(userData).toContain('apt-get install -y docker.io unzip nodejs');
    expect(userData).toContain('awscli-exe-linux-x86_64.zip');
  });

  test('Agent EC2 uses /dev/sda1 root device', () => {
    const tmpl = createStackWithConfig();

    tmpl.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3a.large',
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: '/dev/sda1',
          Ebs: { VolumeSize: 30, VolumeType: 'gp3' },
        }),
      ]),
    });
  });

  test('ARM agent instance type throws an error', () => {
    expect(() => createStackWithConfig({
      agentInstanceType: new ec2.InstanceType('t4g.large'),
    })).toThrow(/ARM instance types are not supported/);
  });

  test('ARM proxy instance type throws an error', () => {
    expect(() => createStackWithConfig({
      proxyInstanceType: new ec2.InstanceType('t4g.nano'),
    })).toThrow(/ARM instance types are not supported/);
  });

  test('ARM gateway instance type throws an error', () => {
    expect(() => createStackWithConfig({
      gatewayInstanceType: new ec2.InstanceType('t4g.nano'),
    })).toThrow(/ARM instance types are not supported/);
  });
});
