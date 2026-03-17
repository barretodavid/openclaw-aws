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
  instanceType: new ec2.InstanceType('t3a.xlarge'),
  volumeGb: 30,
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

/** Find an IAM Role by a keyword in its Description. */
function findRole(keyword: string): [string, CfnResource] {
  return findResource('AWS::IAM::Role', (_id, r) =>
    (r.Properties?.Description as string)?.includes(keyword),
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

// --- Security Boundary Tests ---

describe('Security Boundaries', () => {
  test('Role allows kms:CreateKey only with wallet tag and correct key spec conditions', () => {
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

  test('Role allows kms:Sign, kms:GetPublicKey, kms:DescribeKey only with wallet tag condition', () => {
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

  test('Role allows tag:GetResources for wallet key discovery', () => {
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

  test('Role has SSM Session Manager access', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const ec2Roles = Object.values(roles).filter(
      (r) => r.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Principal?.Service === 'ec2.amazonaws.com',
    );

    expect(ec2Roles).toHaveLength(1);

    const role = ec2Roles[0];
    const managedPolicies: { 'Fn::Join': [string, string[]] }[] = role.Properties.ManagedPolicyArns;
    const policyArns = managedPolicies.map((p) => {
      if (typeof p === 'string') return p;
      if (p['Fn::Join']) return p['Fn::Join'][1].join('');
      return JSON.stringify(p);
    });
    const hasSsmPolicy = policyArns.some((arn) => arn.includes('AmazonSSMManagedInstanceCore'));
    expect(hasSsmPolicy).toBe(true);
  });

  test('Role has Secrets Manager access to LLM and web search secrets', () => {
    const [roleId] = findRole('Agent Server');
    const actions = getActionsForRole(roleId);
    const smActions = actions.filter((a) => a.startsWith('secretsmanager:'));
    expect(smActions.length).toBeGreaterThan(0);
  });

  test('Secret access is scoped to specific secrets, not wildcard', () => {
    const [roleId] = findRole('Agent Server');
    const policies = template.findResources('AWS::IAM::Policy');

    for (const [, policy] of Object.entries(policies)) {
      const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
      if (!roles.some((r) => r.Ref === roleId)) continue;

      const statements = (policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] })?.Statement ?? [];
      for (const stmt of statements) {
        const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (stmtActions.some((a: string) => a.startsWith('secretsmanager:'))) {
          const resource = stmt.Resource;
          expect(resource).toBeDefined();
          expect(resource).not.toBe('*');
        }
      }
    }
  });
});

// --- Resource Configuration Tests ---

describe('Resource Configuration', () => {
  test('EC2 instance requires IMDSv2 to prevent SSRF credential theft', () => {
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate');
    const imdsv2Templates = Object.values(launchTemplates).filter(
      (lt) => lt.Properties?.LaunchTemplateData?.MetadataOptions?.HttpTokens === 'required',
    );
    expect(imdsv2Templates).toHaveLength(1);
  });

  test('EC2 defaults to t3a.xlarge', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3a.xlarge',
    });
  });

  test('EC2 user data installs Docker, Node.js, signal-cli, and OpenClaw', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    const instance = Object.values(instances)[0];
    const userDataStr = JSON.stringify(instance.Properties?.UserData);

    expect(userDataStr).toContain('apt-get install -y docker.io unzip nodejs unattended-upgrades');
    expect(userDataStr).toContain('awscli-exe-linux-x86_64.zip');
    expect(userDataStr).toContain('systemctl enable docker');
    expect(userDataStr).toContain('systemctl start docker');
    expect(userDataStr).toContain('signal-cli');
    expect(userDataStr).toContain('openclaw');
  });

  test('EC2 user data does not set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    const instance = Object.values(instances)[0];
    const userDataStr = JSON.stringify(instance.Properties?.UserData);

    expect(userDataStr).not.toContain('OPENCLAW_ALLOW_INSECURE_PRIVATE_WS');
  });

  test('EC2 has 30 GB gp3 EBS volume', () => {
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
  test('exactly 1 EC2 instance', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  test('exactly 1 IAM role', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  test('exactly 1 security group', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });

  test('no CDK-managed KMS keys (agent creates them at runtime)', () => {
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('3 Secrets Manager secrets (LLM + RPC + Web, no gateway token)', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
  });

  test('no SSM parameters', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  test('no Route 53 hosted zones', () => {
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
  });

  test('no Route 53 record sets', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});

// --- Security Invariant Tests ---

describe('Security Invariants', () => {
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

  test('Security group only allows outbound HTTPS and HTTP', () => {
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const sgId = Object.keys(sgs)[0];
    const egressRules = getEgressRules(sgId);

    expect(egressRules).toHaveLength(2);

    const cidrPorts = egressRules.map((r) => r.FromPort as number).sort((a, b) => a - b);
    expect(cidrPorts).toEqual([80, 443]);
  });
});

// --- Cross-Resource Relationship Tests ---

describe('Cross-Resource Relationships', () => {
  test('Instance uses the correct IAM role', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    const instanceId = Object.keys(instances)[0];
    const instance = instances[instanceId];

    const profileRef = (instance.Properties?.IamInstanceProfile as { Ref: string })?.Ref;
    expect(profileRef).toBeDefined();

    const profiles = template.findResources('AWS::IAM::InstanceProfile');
    const profile = profiles[profileRef!];
    const roles = (profile.Properties?.Roles as { Ref: string }[]) ?? [];
    expect(roles).toHaveLength(1);

    const [roleId] = findRole('Agent Server');
    expect(roles[0].Ref).toBe(roleId);
  });

  test('Instance uses the correct security group', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    const instance = Object.values(instances)[0];
    const sgIds = instance.Properties?.SecurityGroupIds as { 'Fn::GetAtt': string[] }[];
    expect(sgIds).toHaveLength(1);
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

// --- LLM API Key Secret Tests ---

describe('LLM API Key Secret', () => {
  test('LLM API key secret exists with correct name', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${TEST_AGENT_NAME}/llm-api-key`,
    });
  });

  test('Role has scoped read access to the LLM secret', () => {
    const [roleId] = findRole('Agent Server');
    const policies = template.findResources('AWS::IAM::Policy');

    let foundLlmGrant = false;
    for (const [, policy] of Object.entries(policies)) {
      const roles = (policy.Properties?.Roles as { Ref: string }[]) ?? [];
      if (!roles.some((r) => r.Ref === roleId)) continue;

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
      // 2 secrets: LLM + Web (no RPC, no gateway token)
      tmpl.resourceCountIs('AWS::SecretsManager::Secret', 2);
    } finally {
      process.env.RPC_PROVIDER = saved.RPC_PROVIDER;
      process.env.RPC_API_KEY = saved.RPC_API_KEY;
    }
  });
});

// --- Telegram Bot Token Secret Tests ---

describe('Telegram Bot Token Secret', () => {
  test('Telegram secret exists when TELEGRAM_BOT_TOKEN is set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
    try {
      const tmpl = createStackWithConfig();

      tmpl.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `${TEST_AGENT_NAME}/telegram-token`,
        Description: Match.stringLikeRegexp('Telegram bot token'),
      });
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  test('No Telegram secret when TELEGRAM_BOT_TOKEN is not set', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const tmpl = createStackWithConfig();

    const secrets = tmpl.findResources('AWS::SecretsManager::Secret');
    const telegramSecrets = Object.values(secrets).filter(
      (s) => (s.Properties?.Name as string) === `${TEST_AGENT_NAME}/telegram-token`,
    );
    expect(telegramSecrets).toHaveLength(0);
  });

  test('Secret count is 4 when TELEGRAM_BOT_TOKEN is set (LLM + RPC + Web + telegram)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
    try {
      const tmpl = createStackWithConfig();
      tmpl.resourceCountIs('AWS::SecretsManager::Secret', 4);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});

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

function getInstanceUserData(tmpl: Template): string {
  const instances = tmpl.findResources('AWS::EC2::Instance');
  const instance = Object.values(instances)[0];
  return JSON.stringify(instance.Properties?.UserData);
}

describe('Agent Machine Configuration', () => {
  test('default config uses apt-get, Docker, and ubuntu user', () => {
    const tmpl = createStackWithConfig();
    const userData = getInstanceUserData(tmpl);

    expect(userData).toContain('apt-get update -y');
    expect(userData).toContain('deb.nodesource.com/setup_24.x');
    expect(userData).toContain('apt-get install -y docker.io unzip nodejs');
    expect(userData).toContain('awscli-exe-linux-x86_64.zip');
    expect(userData).toContain('usermod -aG docker ubuntu');
  });

  test('custom x86 instance type produces correct instance type in template', () => {
    const tmpl = createStackWithConfig({
      instanceType: new ec2.InstanceType('m5a.large'),
    });

    tmpl.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 'm5a.large',
    });
  });

  test('EC2 uses /dev/sda1 root device', () => {
    const tmpl = createStackWithConfig();

    tmpl.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: '/dev/sda1',
          Ebs: { VolumeSize: 30, VolumeType: 'gp3' },
        }),
      ]),
    });
  });

  test('ARM instance type throws an error', () => {
    expect(() => createStackWithConfig({
      instanceType: new ec2.InstanceType('t4g.large'),
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
});
