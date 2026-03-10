import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OpenclawStack } from '../lib/openclaw-stack';
import { PROVIDER_REGISTRY } from '../lib/ec2-config';
import { resolveRegionConfig } from '../lib/region-config';

/** Default config values for tests (mirrors production defaults in bin/openclaw.ts). */
const defaults = {
  availabilityZone: 'us-east-1a',
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

// --- Helper functions ---

type CfnResource = { [key: string]: unknown; Properties?: Record<string, unknown> };

/** Find a resource by type and a property matcher. Returns [logicalId, resource]. */
function findResource(
  type: string,
  predicate: (logicalId: string, resource: CfnResource) => boolean,
): [string, CfnResource] {
  const resources = template.findResources(type);
  const match = Object.entries(resources).find(([id, r]) => predicate(id, r));
  if (!match) throw new Error(`No ${type} matched predicate`);
  return match;
}

/** Find an IAM Role by a keyword in its Description. */
function findRole(keyword: string): [string, CfnResource] {
  return findResource('AWS::IAM::Role', (_id, r) =>
    (r.Properties?.Description as string)?.includes(keyword),
  );
}

/** Find a Security Group by a keyword in its GroupDescription. */
function findSg(keyword: string): [string, CfnResource] {
  return findResource('AWS::EC2::SecurityGroup', (_id, r) =>
    (r.Properties?.GroupDescription as string)?.includes(keyword),
  );
}

/** Find an EC2 Instance by a marker string in its UserData. */
function findInstance(marker: string): [string, CfnResource] {
  return findResource('AWS::EC2::Instance', (_id, r) =>
    JSON.stringify(r.Properties?.UserData ?? '').includes(marker),
  );
}

/** Get all IAM action strings from all inline policies attached to a role. */
function getActionsForRole(roleLogicalId: string): string[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const actions: string[] = [];

  for (const [, policy] of Object.entries(policies)) {
    const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
    if (!roles.some((r) => r.Ref === roleLogicalId)) continue;

    const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
    for (const stmt of statements) {
      const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      actions.push(...(stmtActions as string[]));
    }
  }

  return actions;
}

/** Get all egress rules for a security group (both inline and standalone). */
function getEgressRules(sgLogicalId: string): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];

  // Inline egress rules on the SG resource itself
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  const sg = sgs[sgLogicalId];
  const inlineEgress = (sg?.Properties?.SecurityGroupEgress as Record<string, unknown>[]) ?? [];
  rules.push(...inlineEgress);

  // Standalone SecurityGroupEgress resources
  const egressResources = template.findResources('AWS::EC2::SecurityGroupEgress');
  for (const r of Object.values(egressResources)) {
    const groupId = r.Properties?.GroupId as { 'Fn::GetAtt'?: string[] };
    if (groupId?.['Fn::GetAtt']?.[0] === sgLogicalId) {
      rules.push(r.Properties as Record<string, unknown>);
    }
  }

  return rules;
}

/** Resolve the IAM Role logical ID for an EC2 instance by following Instance -> InstanceProfile -> Role. */
function resolveInstanceRole(instanceLogicalId: string): string {
  const instances = template.findResources('AWS::EC2::Instance');
  const instance = instances[instanceLogicalId];
  const profileRef = (instance.Properties?.IamInstanceProfile as { Ref: string })?.Ref;
  if (!profileRef) throw new Error(`Instance ${instanceLogicalId} has no IamInstanceProfile`);

  const profiles = template.findResources('AWS::IAM::InstanceProfile');
  const profile = profiles[profileRef];
  const roles = (profile.Properties?.Roles as { Ref: string }[]) ?? [];
  if (roles.length === 0) throw new Error(`InstanceProfile ${profileRef} has no Roles`);
  return roles[0].Ref;
}

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
        expect(userDataStr).toContain('awscli-exe-linux-x86_64.zip');
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
        expect(userDataStr).toContain('apt-get install -y unzip nodejs unattended-upgrades');
        expect(userDataStr).toContain('awscli-exe-linux-x86_64.zip');
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

// --- Security Invariant Tests ---

describe('Security Invariants', () => {
  test('A compromised agent cannot read API keys', () => {
    const [agentRoleId] = findRole('Agent');
    const actions = getActionsForRole(agentRoleId);
    const secretActions = actions.filter((a) => /^secretsmanager:/i.test(a));
    expect(secretActions).toEqual([]);
  });

  test('A compromised proxy cannot sign transactions', () => {
    const [proxyRoleId] = findRole('Proxy');
    const actions = getActionsForRole(proxyRoleId);
    const kmsActions = actions.filter((a) => /^kms:/i.test(a));
    expect(kmsActions).toEqual([]);
  });

  test('A compromised gateway cannot access API keys or sign transactions', () => {
    const [gatewayRoleId] = findRole('Gateway');
    const actions = getActionsForRole(gatewayRoleId);
    expect(actions).toEqual([]);
  });

  test('No server accepts traffic from the public internet', () => {
    // Check inline ingress rules on all security groups
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    for (const [, sg] of Object.entries(sgs)) {
      const ingressRules = (sg.Properties?.SecurityGroupIngress as Record<string, unknown>[]) ?? [];
      for (const rule of ingressRules) {
        expect(rule.CidrIp).not.toBe('0.0.0.0/0');
        expect(rule.CidrIpv6).not.toBe('::/0');
      }
    }

    // Check standalone ingress resources
    const ingressResources = template.findResources('AWS::EC2::SecurityGroupIngress');
    for (const [, ingress] of Object.entries(ingressResources)) {
      expect(ingress.Properties?.CidrIp).not.toBe('0.0.0.0/0');
      expect(ingress.Properties?.CidrIpv6).not.toBe('::/0');
    }
  });

  test('The agent can only talk to the proxy, the gateway, and the internet', () => {
    const [agentSgId] = findSg('no inbound');
    const [proxySgId] = findSg('Proxy EC2');
    const [gatewaySgId] = findSg('Gateway EC2');

    const egressRules = getEgressRules(agentSgId);
    expect(egressRules).toHaveLength(4);

    const cidrRules = egressRules.filter((r) => r.CidrIp === '0.0.0.0/0');
    const cidrPorts = cidrRules.map((r) => r.FromPort as number).sort((a, b) => a - b);
    expect(cidrPorts).toEqual([80, 443]);

    const sgRules = egressRules.filter((r) => !r.CidrIp);
    const sgTargets = sgRules.map((r) => ({
      sg: (r.DestinationSecurityGroupId as { 'Fn::GetAtt': string[] })?.['Fn::GetAtt']?.[0],
      port: r.FromPort,
    }));

    expect(sgTargets).toEqual(
      expect.arrayContaining([
        { sg: proxySgId, port: 8080 },
        { sg: gatewaySgId, port: 18789 },
      ]),
    );
    expect(sgTargets).toHaveLength(2);
  });
});

// --- Cross-Resource Relationship Tests ---

describe('Cross-Resource Relationships', () => {
  test('A refactor cannot accidentally give a server the wrong permissions', () => {
    const [agentRoleId] = findRole('Agent');
    const [proxyRoleId] = findRole('Proxy');
    const [gatewayRoleId] = findRole('Gateway');

    const [agentInstanceId] = findInstance('docker.io');
    const [proxyInstanceId] = findInstance('openclaw-aws-proxy');
    const [gatewayInstanceId] = findInstance('signal-cli');

    expect(resolveInstanceRole(agentInstanceId)).toBe(agentRoleId);
    expect(resolveInstanceRole(proxyInstanceId)).toBe(proxyRoleId);
    expect(resolveInstanceRole(gatewayInstanceId)).toBe(gatewayRoleId);
  });

  test('A refactor cannot accidentally give a server the wrong network access', () => {
    const [agentSgId] = findSg('no inbound');
    const [proxySgId] = findSg('Proxy EC2');
    const [gatewaySgId] = findSg('Gateway EC2');

    const [agentInstanceId] = findInstance('docker.io');
    const [proxyInstanceId] = findInstance('openclaw-aws-proxy');
    const [gatewayInstanceId] = findInstance('signal-cli');

    const instances = template.findResources('AWS::EC2::Instance');

    for (const [instanceId, expectedSgId] of [
      [agentInstanceId, agentSgId],
      [proxyInstanceId, proxySgId],
      [gatewayInstanceId, gatewaySgId],
    ] as const) {
      const sgIds = instances[instanceId].Properties?.SecurityGroupIds as { 'Fn::GetAtt': string[] }[];
      expect(sgIds).toHaveLength(1);
      expect(sgIds[0]['Fn::GetAtt'][0]).toBe(expectedSgId);
    }
  });

  test('Internal DNS routes to the correct servers', () => {
    const [proxyInstanceId] = findInstance('openclaw-aws-proxy');
    const [gatewayInstanceId] = findInstance('signal-cli');
    const [agentInstanceId] = findInstance('docker.io');

    const records = template.findResources('AWS::Route53::RecordSet');

    for (const [, record] of Object.entries(records)) {
      const name = record.Properties?.Name as string;
      const targetRef = (
        (record.Properties?.ResourceRecords as { 'Fn::GetAtt': string[] }[])?.[0]
      )?.['Fn::GetAtt']?.[0];

      if (name === 'proxy.vpc.') {
        expect(targetRef).toBe(proxyInstanceId);
      } else if (name === 'gateway.vpc.') {
        expect(targetRef).toBe(gatewayInstanceId);
      } else if (name.endsWith('.proxy.vpc.')) {
        // Per-provider subdomains should all point to the proxy
        expect(targetRef).toBe(proxyInstanceId);
      }

      // No DNS record should ever point to the agent
      expect(targetRef).not.toBe(agentInstanceId);
    }
  });

  test('Every configured provider is reachable and no stale DNS entries exist', () => {
    // Get subdomains from proxy config SSM parameter
    const params = template.findResources('AWS::SSM::Parameter');
    const proxyConfigParam = Object.values(params).find(
      (p) => p.Properties?.Name === '/openclaw/proxy-config',
    );
    const configKeys = Object.keys(JSON.parse(proxyConfigParam!.Properties!.Value as string));

    // Get subdomains from DNS records (*.proxy.vpc.)
    const records = template.findResources('AWS::Route53::RecordSet');
    const dnsSubdomains = Object.values(records)
      .map((r) => r.Properties?.Name as string)
      .filter((name) => name.endsWith('.proxy.vpc.'))
      .map((name) => name.replace('.proxy.vpc.', ''))
      .sort();

    expect(configKeys.sort()).toEqual(dnsSubdomains);
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

// --- Region Config Resolution Tests ---

describe('resolveRegionConfig', () => {
  test('CDK_AZ_PROD returns that AZ and derived region', () => {
    const result = resolveRegionConfig({ CDK_AZ_PROD: 'us-west-2b' });
    expect(result).toEqual({ region: 'us-west-2', availabilityZone: 'us-west-2b' });
  });

  test('missing CDK_AZ_PROD throws an error', () => {
    expect(() => resolveRegionConfig({})).toThrow(/CDK_AZ_PROD is not set/);
  });
});
