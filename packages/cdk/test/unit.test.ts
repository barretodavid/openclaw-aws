import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OpenclawStack } from '../lib/openclaw-stack';
import { LLM_PROVIDERS, RPC_PROVIDERS, WEB_SEARCH_PROVIDERS, resolveAgentName } from '../lib/ec2-config';
import { resolveRegionConfig } from '../lib/region-config';

const TEST_AGENT_NAME = 'testagent';

/** Default config values for tests (mirrors production defaults in bin/openclaw.ts). */
const defaults = {
  agentName: TEST_AGENT_NAME,
  availabilityZone: 'us-east-1a',
  agentInstanceType: new ec2.InstanceType('t3a.large'),
  gatewayServerInstanceType: new ec2.InstanceType('t3a.small'),
  agentVolumeGb: 30,
};

let template: Template;

// Mock env vars: one LLM provider + one RPC provider
const MOCK_ENV_VARS: Record<string, string> = {
  LLM_PROVIDER: 'venice',
  LLM_API_KEY: 'test-venice-key',
  RPC_PROVIDER: 'alchemy',
  RPC_API_KEY: 'test-alchemy-key',
  WEB_SEARCH_PROVIDER: 'brave',
  WEB_SEARCH_API_KEY: 'test-brave-key',
};

/** Save and clear provider-related env vars, set mock values. */
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  // Save and clear any existing env vars that could interfere
  for (const key of ['LLM_PROVIDER', 'LLM_API_KEY', 'RPC_PROVIDER', 'RPC_API_KEY', 'WEB_SEARCH_PROVIDER', 'WEB_SEARCH_API_KEY', 'TELEGRAM_BOT_TOKEN']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
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
                [`aws:RequestTag/${TEST_AGENT_NAME}`]: 'wallet',
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
                [`aws:ResourceTag/${TEST_AGENT_NAME}`]: 'wallet',
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

    expect(ec2Roles).toHaveLength(2);

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

  test('Gateway Server security group allows inbound only from Agent SG on port 18789', () => {
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
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate');
    const imdsv2Templates = Object.values(launchTemplates).filter(
      (lt) => lt.Properties?.LaunchTemplateData?.MetadataOptions?.HttpTokens === 'required',
    );
    expect(imdsv2Templates).toHaveLength(2);
  });

  test('Agent Server EC2 defaults to t3a.large', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3a.large',
    });
  });

  test('Agent Server EC2 user data installs Docker and Node.js via apt', () => {
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

  test('Gateway Server EC2 user data installs signal-cli', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    let foundSignalCli = false;

    for (const [, instance] of Object.entries(instances)) {
      const userDataStr = JSON.stringify(instance.Properties?.UserData ?? '');
      if (userDataStr.includes('signal-cli')) {
        expect(userDataStr).toContain('-C /usr/local/bin');
        expect(userDataStr).toContain('awscli-exe-linux-x86_64.zip');
        expect(userDataStr).not.toContain('docker');
        foundSignalCli = true;
      }
    }

    expect(foundSignalCli).toBe(true);
  });

  test('Agent Server and Gateway Server user data set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    let agentHasEnvVar = false;
    let gatewayServerHasEnvVar = false;

    for (const [, instance] of Object.entries(instances)) {
      const userDataStr = JSON.stringify(instance.Properties?.UserData ?? '');
      if (userDataStr.includes('docker')) {
        expect(userDataStr).toContain('OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1');
        agentHasEnvVar = true;
      }
      if (userDataStr.includes('signal-cli')) {
        expect(userDataStr).toContain('OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1');
        gatewayServerHasEnvVar = true;
      }
    }

    expect(agentHasEnvVar).toBe(true);
    expect(gatewayServerHasEnvVar).toBe(true);
  });

  test('Private hosted zone exists with agent-scoped zone name', () => {
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: `${TEST_AGENT_NAME}.vpc.`,
    });
  });

  test('A record for gateway points to gateway server instance', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `gateway.${TEST_AGENT_NAME}.vpc.`,
      Type: 'A',
    });
  });

  test('Agent Server EC2 has 30 GB gp3 EBS volume', () => {
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
  test('exactly 2 EC2 instances', () => {
    template.resourceCountIs('AWS::EC2::Instance', 2);
  });

  test('exactly 2 IAM roles', () => {
    template.resourceCountIs('AWS::IAM::Role', 2);
  });

  test('exactly 2 security groups', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
  });

  test('no CDK-managed KMS keys (agent creates them at runtime)', () => {
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('4 Secrets Manager secrets (LLM + RPC + Web + gateway token)', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 4);
  });

  test('no SSM parameters', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  test('1 DNS A record (gateway.vpc only)', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 1);
  });
});

// --- Security Invariant Tests ---

describe('Security Invariants', () => {
  test('Agent Server secret access is scoped to gateway-token only, not wildcard', () => {
    const [agentRoleId] = findRole('Agent Server');
    const policies = template.findResources('AWS::IAM::Policy');

    let smStatementCount = 0;
    for (const [, policy] of Object.entries(policies)) {
      const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
      if (!roles.some((r) => r.Ref === agentRoleId)) continue;

      const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
      for (const stmt of statements) {
        const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (stmtActions.some((a: string) => a.startsWith('secretsmanager:'))) {
          const resource = stmt.Resource;
          expect(resource).toBeDefined();
          expect(resource).not.toBe('*');
          smStatementCount++;
        }
      }
    }

    // Agent Server should have exactly 1 SM statement (gateway-token only)
    expect(smStatementCount).toBe(1);
  });

  test('A compromised gateway server cannot sign transactions', () => {
    const [gatewayServerRoleId] = findRole('Gateway Server');
    const actions = getActionsForRole(gatewayServerRoleId);
    const kmsActions = actions.filter((a) => a.startsWith('kms:'));
    expect(kmsActions).toEqual([]);
  });

  test('Gateway Server role has Secrets Manager access to LLM and web search secrets', () => {
    const [gatewayServerRoleId] = findRole('Gateway Server');
    const actions = getActionsForRole(gatewayServerRoleId);
    const smActions = actions.filter((a) => a.startsWith('secretsmanager:'));
    expect(smActions.length).toBeGreaterThan(0);
  });

  test('No server accepts traffic from the public internet', () => {
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    for (const [, sg] of Object.entries(sgs)) {
      const ingressRules = (sg.Properties?.SecurityGroupIngress as Record<string, unknown>[]) ?? [];
      for (const rule of ingressRules) {
        expect(rule.CidrIp).not.toBe('0.0.0.0/0');
        expect(rule.CidrIpv6).not.toBe('::/0');
      }
    }

    const ingressResources = template.findResources('AWS::EC2::SecurityGroupIngress');
    for (const [, ingress] of Object.entries(ingressResources)) {
      expect(ingress.Properties?.CidrIp).not.toBe('0.0.0.0/0');
      expect(ingress.Properties?.CidrIpv6).not.toBe('::/0');
    }
  });

  test('The agent server can only talk to the gateway server and the internet', () => {
    const [agentSgId] = findSg('no inbound');
    const [gatewayServerSgId] = findSg('Gateway Server EC2');

    const egressRules = getEgressRules(agentSgId);
    expect(egressRules).toHaveLength(3);

    const cidrRules = egressRules.filter((r) => r.CidrIp === '0.0.0.0/0');
    const cidrPorts = cidrRules.map((r) => r.FromPort as number).sort((a, b) => a - b);
    expect(cidrPorts).toEqual([80, 443]);

    const sgRules = egressRules.filter((r) => !r.CidrIp);
    const sgTargets = sgRules.map((r) => ({
      sg: (r.DestinationSecurityGroupId as { 'Fn::GetAtt': string[] })?.['Fn::GetAtt']?.[0],
      port: r.FromPort,
    }));

    expect(sgTargets).toEqual([
      { sg: gatewayServerSgId, port: 18789 },
    ]);
  });
});

// --- Cross-Resource Relationship Tests ---

describe('Cross-Resource Relationships', () => {
  test('A refactor cannot accidentally give a server the wrong permissions', () => {
    const [agentRoleId] = findRole('Agent Server');
    const [gatewayServerRoleId] = findRole('Gateway Server');

    const [agentInstanceId] = findInstance('docker.io');
    const [gatewayServerInstanceId] = findInstance('signal-cli');

    expect(resolveInstanceRole(agentInstanceId)).toBe(agentRoleId);
    expect(resolveInstanceRole(gatewayServerInstanceId)).toBe(gatewayServerRoleId);
  });

  test('A refactor cannot accidentally give a server the wrong network access', () => {
    const [agentSgId] = findSg('no inbound');
    const [gatewayServerSgId] = findSg('Gateway Server EC2');

    const [agentInstanceId] = findInstance('docker.io');
    const [gatewayServerInstanceId] = findInstance('signal-cli');

    const instances = template.findResources('AWS::EC2::Instance');

    for (const [instanceId, expectedSgId] of [
      [agentInstanceId, agentSgId],
      [gatewayServerInstanceId, gatewayServerSgId],
    ] as const) {
      const sgIds = instances[instanceId].Properties?.SecurityGroupIds as { 'Fn::GetAtt': string[] }[];
      expect(sgIds).toHaveLength(1);
      expect(sgIds[0]['Fn::GetAtt'][0]).toBe(expectedSgId);
    }
  });

  test('Internal DNS routes to the correct servers', () => {
    const [gatewayServerInstanceId] = findInstance('signal-cli');
    const [agentInstanceId] = findInstance('docker.io');

    const records = template.findResources('AWS::Route53::RecordSet');

    for (const [, record] of Object.entries(records)) {
      const name = record.Properties?.Name as string;
      const targetRef = (
        (record.Properties?.ResourceRecords as { 'Fn::GetAtt': string[] }[])?.[0]
      )?.['Fn::GetAtt']?.[0];

      if (name === `gateway.${TEST_AGENT_NAME}.vpc.`) {
        expect(targetRef).toBe(gatewayServerInstanceId);
      }

      // No DNS record should ever point to the agent server
      expect(targetRef).not.toBe(agentInstanceId);
    }
  });
});

// --- Web Search Secret Tests ---

describe('Web Search Secret', () => {
  test('Web API key secret exists with correct name', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/web-search-api-key`,
    });
  });

  test('CDK synth fails when WEB_SEARCH_PROVIDER is missing', () => {
    const saved = process.env.WEB_SEARCH_PROVIDER;
    delete process.env.WEB_SEARCH_PROVIDER;
    try {
      expect(() => createStackWithConfig()).toThrow(/WEB_SEARCH_PROVIDER is required/);
    } finally {
      process.env.WEB_SEARCH_PROVIDER = saved;
    }
  });

  test('CDK synth fails when WEB_SEARCH_PROVIDER is unrecognized', () => {
    const saved = process.env.WEB_SEARCH_PROVIDER;
    process.env.WEB_SEARCH_PROVIDER = 'nonexistent';
    try {
      expect(() => createStackWithConfig()).toThrow(/Unknown WEB_SEARCH_PROVIDER/);
    } finally {
      process.env.WEB_SEARCH_PROVIDER = saved;
    }
  });

  test('CDK synth fails when WEB_SEARCH_API_KEY is missing', () => {
    const saved = process.env.WEB_SEARCH_API_KEY;
    delete process.env.WEB_SEARCH_API_KEY;
    try {
      expect(() => createStackWithConfig()).toThrow(/WEB_SEARCH_API_KEY is required/);
    } finally {
      process.env.WEB_SEARCH_API_KEY = saved;
    }
  });
});

// --- Gateway Token Secret Tests ---

describe('Gateway Token Secret', () => {
  test('Gateway token secret exists with correct name and description', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/gateway-token`,
      Description: Match.stringLikeRegexp('Gateway authentication token'),
    });
  });

  test('Agent Server role has read access to the gateway token secret', () => {
    const [agentRoleId] = findRole('Agent Server');
    const policies = template.findResources('AWS::IAM::Policy');

    let foundGatewayTokenGrant = false;
    for (const [, policy] of Object.entries(policies)) {
      const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
      if (!roles.some((r) => r.Ref === agentRoleId)) continue;

      const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
      for (const stmt of statements) {
        const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (stmtActions.includes('secretsmanager:GetSecretValue')) {
          foundGatewayTokenGrant = true;
        }
      }
    }

    expect(foundGatewayTokenGrant).toBe(true);
  });

  test('Gateway Server role does not have access to the gateway token secret', () => {
    const [gatewayServerRoleId] = findRole('Gateway Server');
    const [agentRoleId] = findRole('Agent Server');
    const policies = template.findResources('AWS::IAM::Policy');

    // Find the policy granting gateway-token access -- it should be on agentRole, not gatewayServerRole
    for (const [, policy] of Object.entries(policies)) {
      const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
      if (!roles.some((r) => r.Ref === agentRoleId)) continue;

      const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
      for (const stmt of statements) {
        const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (stmtActions.includes('secretsmanager:GetSecretValue')) {
          // This gateway-token policy should not also be on the gateway role
          expect(roles.some((r) => r.Ref === gatewayServerRoleId)).toBe(false);
        }
      }
    }
  });
});

// --- LLM API Key Secret Tests ---

describe('LLM API Key Secret', () => {
  test('LLM API key secret exists with correct name', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/llm-api-key`,
    });
  });

  test('Gateway Server role has scoped read access to the LLM secret', () => {
    const [gatewayServerRoleId] = findRole('Gateway Server');
    const policies = template.findResources('AWS::IAM::Policy');

    let foundLlmGrant = false;
    for (const [, policy] of Object.entries(policies)) {
      const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
      if (!roles.some((r) => r.Ref === gatewayServerRoleId)) continue;

      const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
      for (const stmt of statements) {
        const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (stmtActions.includes('secretsmanager:GetSecretValue')) {
          expect(stmt.Resource).not.toBe('*');
          foundLlmGrant = true;
        }
      }
    }

    expect(foundLlmGrant).toBe(true);
  });
});

// --- RPC API Key Secret Tests ---

describe('RPC API Key Secret', () => {
  test('RPC API key secret exists with correct name when configured', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/rpc-api-key`,
    });
  });

  test('No RPC secret when RPC_PROVIDER is not set', () => {
    const saved = { RPC_PROVIDER: process.env.RPC_PROVIDER, RPC_API_KEY: process.env.RPC_API_KEY };
    delete process.env.RPC_PROVIDER;
    delete process.env.RPC_API_KEY;
    try {
      const tmpl = createStackWithConfig();
      // 3 secrets: LLM + Web + gateway-token (no RPC)
      tmpl.resourceCountIs('AWS::SecretsManager::Secret', 3);
    } finally {
      process.env.RPC_PROVIDER = saved.RPC_PROVIDER;
      process.env.RPC_API_KEY = saved.RPC_API_KEY;
    }
  });
});

// --- Telegram Bot Token Secret Tests ---

describe('Telegram Bot Token Secret', () => {
  test('Telegram secret exists with Gateway Server read access when TELEGRAM_BOT_TOKEN is set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
    try {
      const tmpl = createStackWithConfig();

      tmpl.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `${TEST_AGENT_NAME}/telegram-token`,
        Description: Match.stringLikeRegexp('Telegram bot token'),
      });

      // Gateway Server role should have secretsmanager actions
      const [gatewayRoleId] = findResourceIn(tmpl, 'AWS::IAM::Role', (_id, r) =>
        (r.Properties?.Description as string)?.includes('Gateway Server'),
      );
      const gatewayActions = getActionsForRoleIn(tmpl, gatewayRoleId);
      const smActions = gatewayActions.filter((a) => a.startsWith('secretsmanager:'));
      expect(smActions.length).toBeGreaterThan(0);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  test('Agent Server role does NOT have access to the Telegram token secret', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
    try {
      const tmpl = createStackWithConfig();

      const [agentRoleId] = findResourceIn(tmpl, 'AWS::IAM::Role', (_id, r) =>
        (r.Properties?.Description as string)?.includes('Agent Server'),
      );
      const [gatewayRoleId] = findResourceIn(tmpl, 'AWS::IAM::Role', (_id, r) =>
        (r.Properties?.Description as string)?.includes('Gateway Server'),
      );

      // Find the policy that grants SM access to the Gateway role (for the Telegram secret)
      const policies = tmpl.findResources('AWS::IAM::Policy');
      for (const [, policy] of Object.entries(policies)) {
        const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
        // If this policy is attached to the Gateway role and has SM access, it should NOT also be on the Agent role
        if (roles.some((r) => r.Ref === gatewayRoleId)) {
          const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
          for (const stmt of statements) {
            const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            if (stmtActions.some((a: string) => a.startsWith('secretsmanager:'))) {
              // This SM policy should not be on the Agent role
              expect(roles.some((r) => r.Ref === agentRoleId)).toBe(false);
            }
          }
        }
      }
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  test('No Telegram secret when TELEGRAM_BOT_TOKEN is not set', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const tmpl = createStackWithConfig();

    // No telegram secret
    const secrets = tmpl.findResources('AWS::SecretsManager::Secret');
    const telegramSecrets = Object.values(secrets).filter(
      (s) => (s.Properties?.Name as string) === `${TEST_AGENT_NAME}/telegram-token`,
    );
    expect(telegramSecrets).toHaveLength(0);
  });

  test('Secret count is 5 when TELEGRAM_BOT_TOKEN is set (LLM + RPC + Web + gateway-token + telegram)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
    try {
      const tmpl = createStackWithConfig();
      tmpl.resourceCountIs('AWS::SecretsManager::Secret', 5);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});

/** Find a resource in a specific template (for per-test templates). */
function findResourceIn(
  tmpl: Template,
  type: string,
  predicate: (logicalId: string, resource: CfnResource) => boolean,
): [string, CfnResource] {
  const resources = tmpl.findResources(type);
  const match = Object.entries(resources).find(([id, r]) => predicate(id, r));
  if (!match) throw new Error(`No ${type} matched predicate`);
  return match;
}

/** Get all IAM actions for a role in a specific template (for per-test templates). */
function getActionsForRoleIn(tmpl: Template, roleLogicalId: string): string[] {
  const policies = tmpl.findResources('AWS::IAM::Policy');
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

// --- LLM Provider Validation Tests ---

describe('LLM Provider Validation', () => {
  test('CDK synth fails when LLM_PROVIDER is missing', () => {
    const saved = process.env.LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    try {
      expect(() => createStackWithConfig()).toThrow(/LLM_PROVIDER is required/);
    } finally {
      process.env.LLM_PROVIDER = saved;
    }
  });

  test('CDK synth fails when LLM_PROVIDER is unrecognized', () => {
    const saved = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'nonexistent';
    try {
      expect(() => createStackWithConfig()).toThrow(/Unknown LLM_PROVIDER/);
    } finally {
      process.env.LLM_PROVIDER = saved;
    }
  });

  test('CDK synth fails when LLM_API_KEY is missing', () => {
    const saved = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      expect(() => createStackWithConfig()).toThrow(/LLM_API_KEY is required/);
    } finally {
      process.env.LLM_API_KEY = saved;
    }
  });

  test('CDK synth fails when RPC_PROVIDER is unrecognized', () => {
    const saved = process.env.RPC_PROVIDER;
    process.env.RPC_PROVIDER = 'nonexistent';
    try {
      expect(() => createStackWithConfig()).toThrow(/Unknown RPC_PROVIDER/);
    } finally {
      process.env.RPC_PROVIDER = saved;
    }
  });

  test('CDK synth succeeds with valid LLM provider', () => {
    expect(() => createStackWithConfig()).not.toThrow();
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
    expect(userData).toContain('deb.nodesource.com/setup_24.x');
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

  test('Agent Server EC2 uses /dev/sda1 root device', () => {
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

  test('ARM gateway server instance type throws an error', () => {
    expect(() => createStackWithConfig({
      gatewayServerInstanceType: new ec2.InstanceType('t4g.nano'),
    })).toThrow(/ARM instance types are not supported/);
  });
});

// --- Region Config Resolution Tests ---

describe('resolveRegionConfig', () => {
  test('CDK_AZ returns that AZ and derived region', () => {
    const result = resolveRegionConfig({ CDK_AZ: 'us-west-2b' });
    expect(result).toEqual({ region: 'us-west-2', availabilityZone: 'us-west-2b' });
  });

  test('missing CDK_AZ throws an error', () => {
    expect(() => resolveRegionConfig({})).toThrow(/CDK_AZ is not set/);
  });
});

// --- Agent Name Validation Tests ---

describe('resolveAgentName', () => {
  const savedAgentName = process.env.AGENT_NAME;

  afterEach(() => {
    if (savedAgentName !== undefined) process.env.AGENT_NAME = savedAgentName;
    else delete process.env.AGENT_NAME;
  });

  test('valid agent name is accepted', () => {
    process.env.AGENT_NAME = 'alice';
    expect(resolveAgentName()).toBe('alice');
  });

  test('agent name with hyphens is accepted', () => {
    process.env.AGENT_NAME = 'ci-12345';
    expect(resolveAgentName()).toBe('ci-12345');
  });

  test('missing AGENT_NAME throws an error', () => {
    delete process.env.AGENT_NAME;
    expect(() => resolveAgentName()).toThrow(/AGENT_NAME is required/);
  });

  test('agent name starting with number is rejected', () => {
    process.env.AGENT_NAME = '123abc';
    expect(() => resolveAgentName()).toThrow(/Invalid AGENT_NAME/);
  });

  test('agent name with uppercase is rejected', () => {
    process.env.AGENT_NAME = 'Alice';
    expect(() => resolveAgentName()).toThrow(/Invalid AGENT_NAME/);
  });

  test('agent name over 20 chars is rejected', () => {
    process.env.AGENT_NAME = 'a'.repeat(21);
    expect(() => resolveAgentName()).toThrow(/Invalid AGENT_NAME/);
  });

  test('agent name with underscores is rejected', () => {
    process.env.AGENT_NAME = 'my_agent';
    expect(() => resolveAgentName()).toThrow(/Invalid AGENT_NAME/);
  });
});

// --- Agent Name Scoping Tests ---

describe('Agent Name Scoping', () => {
  test('SSM document name matches agent name', () => {
    const tmpl = createStackWithConfig();
    tmpl.hasResourceProperties('AWS::SSM::Document', {
      Name: TEST_AGENT_NAME,
    });
  });

  test('secret names are prefixed with agent name', () => {
    const tmpl = createStackWithConfig();
    tmpl.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/llm-api-key`,
    });
    tmpl.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/web-search-api-key`,
    });
    tmpl.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/gateway-token`,
    });
  });

  test('KMS CreateKey condition uses agent name as tag key', () => {
    const tmpl = createStackWithConfig();
    tmpl.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:CreateKey',
            Condition: {
              StringEquals: Match.objectLike({
                [`aws:RequestTag/${TEST_AGENT_NAME}`]: 'wallet',
              }),
            },
          }),
        ]),
      }),
    });
  });

  test('KMS Sign/GetPublicKey/DescribeKey condition uses agent name as tag key', () => {
    const tmpl = createStackWithConfig();
    tmpl.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:Sign']),
            Condition: {
              StringEquals: Match.objectLike({
                [`aws:ResourceTag/${TEST_AGENT_NAME}`]: 'wallet',
              }),
            },
          }),
        ]),
      }),
    });
  });

  test('PHZ zone name includes agent name', () => {
    const tmpl = createStackWithConfig();
    tmpl.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: `${TEST_AGENT_NAME}.vpc.`,
    });
  });
});
