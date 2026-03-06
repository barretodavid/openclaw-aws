import * as ec2 from 'aws-cdk-lib/aws-ec2';

// --- Provider Registry ---

export type InjectConfig =
  | { type: 'header'; name: string; prefix?: string }
  | { type: 'path' };

// api: matches OpenClaw's --custom-compatibility flag (anthropic | openai | null for non-LLM services)
export type ProviderConfig = { envVar: string; inject: InjectConfig; subdomain: string; api: string | null };

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // LLM providers
  'api.anthropic.com':                 { envVar: 'ANTHROPIC_API_KEY',  inject: { type: 'header', name: 'x-api-key' },                          subdomain: 'anthropic',  api: 'anthropic' },
  'api.openai.com':                    { envVar: 'OPENAI_API_KEY',     inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'openai',     api: 'openai' },
  'generativelanguage.googleapis.com': { envVar: 'GOOGLE_API_KEY',     inject: { type: 'header', name: 'x-goog-api-key' },                    subdomain: 'google',     api: 'openai' },
  'api.mistral.ai':                    { envVar: 'MISTRAL_API_KEY',    inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'mistral',    api: 'openai' },
  'api.groq.com':                      { envVar: 'GROQ_API_KEY',       inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'groq',       api: 'openai' },
  'api.x.ai':                          { envVar: 'XAI_API_KEY',        inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'xai',        api: 'openai' },
  'openrouter.ai':                     { envVar: 'OPENROUTER_API_KEY', inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'openrouter', api: 'openai' },
  'api.venice.ai':                     { envVar: 'VENICE_API_KEY',     inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'venice',     api: 'openai' },
  'api.cerebras.ai':                   { envVar: 'CEREBRAS_API_KEY',   inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'cerebras',   api: 'openai' },
  // Search
  'api.search.brave.com':              { envVar: 'BRAVE_SEARCH_KEY',   inject: { type: 'header', name: 'X-Subscription-Token' },               subdomain: 'brave',      api: null },
  // Starknet RPC providers (Alchemy, Infura use API key in URL path -- industry convention)
  'starknet-mainnet.g.alchemy.com':    { envVar: 'ALCHEMY_API_KEY',    inject: { type: 'path' },                                               subdomain: 'alchemy',    api: null },
  'starknet-mainnet.infura.io':        { envVar: 'INFURA_API_KEY',     inject: { type: 'path' },                                               subdomain: 'infura',     api: null },
  'api.cartridge.gg':                  { envVar: 'CARTRIDGE_API_KEY',  inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'cartridge',  api: null },
  'data.voyager.online':               { envVar: 'VOYAGER_API_KEY',    inject: { type: 'header', name: 'x-apikey' },                           subdomain: 'voyager',    api: null },
};

// --- Ubuntu User Data ---

/** Shared Ubuntu 24.04 user data: Node.js 22, unattended-upgrades with auto-reboot. */
export function ubuntuBaseUserData(defaultUser: string, extraAptPackages: string[] = []): string[] {
  const aptPackages = [...extraAptPackages, 'nodejs', 'unattended-upgrades'].join(' ');
  return [
    'apt-get update -y',
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    `apt-get install -y ${aptPackages}`,
    // Automatic daily security upgrades with reboot at 03:00 UTC when needed
    [
      "cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'",
      'APT::Periodic::Update-Package-Lists "1";',
      'APT::Periodic::Unattended-Upgrade "1";',
      'EOF',
    ].join('\n'),
    [
      "cat > /etc/apt/apt.conf.d/52unattended-upgrades-local << 'EOF'",
      'Unattended-Upgrade::Automatic-Reboot "true";',
      'Unattended-Upgrade::Automatic-Reboot-Time "03:00";',
      'EOF',
    ].join('\n'),
    'systemctl enable unattended-upgrades',
    // SSM Session Manager: login as the default user with bash
    [
      'mkdir -p /etc/amazon/ssm',
      "cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'EOF'",
      '{',
      '  "Profile": {',
      '    "ShareCreds": true,',
      '    "ShareProfile": ""',
      '  },',
      '  "Ssm": {',
      '    "SessionManager": {',
      `      "RunAs": "${defaultUser}",`,
      '      "ShellProfile": {',
      '        "Linux": "/bin/bash -l"',
      '      }',
      '    }',
      '  }',
      '}',
      'EOF',
    ].join('\n'),
    'systemctl restart amazon-ssm-agent',
  ];
}

// --- Agent Machine Configuration ---

/** Configuration for the agent EC2 instance. */
export interface AgentMachineConfig {
  /**
   * EC2 instance type for the agent. Must be an x86_64 instance type.
   * @default t3a.large
   */
  readonly instanceType?: ec2.InstanceType;
}

/** Resolved machine configuration ready for use in a CDK construct. */
export interface ResolvedAgentMachine {
  readonly machineImage: ec2.IMachineImage;
  readonly userDataCommands: readonly string[];
  readonly defaultUser: string;
  readonly rootDeviceName: string;
}

/**
 * Resolves the agent machine configuration (x86_64 only).
 * Returns the Ubuntu 24.04 machine image, user data commands, default user, and root device name.
 */
export function resolveAgentMachine(
  instanceType: ec2.InstanceType,
): ResolvedAgentMachine {
  if (instanceType.architecture === ec2.InstanceArchitecture.ARM_64) {
    throw new Error(
      `ARM instance types are not supported. Got ${instanceType.toString()} - use an x86_64 type like t3a, m5a, or m7i instead.`,
    );
  }

  return {
    machineImage: ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
      { os: ec2.OperatingSystemType.LINUX },
    ),
    userDataCommands: [
      ...ubuntuBaseUserData('ubuntu', ['docker.io', 'unzip']),
      'systemctl enable docker',
      'systemctl start docker',
      // AWS CLI v2 (official installer)
      'curl -fsSL -o /tmp/awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip',
      'unzip -q /tmp/awscliv2.zip -d /tmp',
      '/tmp/aws/install',
      'rm -rf /tmp/awscliv2.zip /tmp/aws',
      // signal-cli (native binary, no JRE needed)
      'curl -fsSL -o /tmp/signal-cli.tar.gz https://github.com/AsamK/signal-cli/releases/download/v0.14.0/signal-cli-0.14.0-Linux-native.tar.gz',
      'tar xf /tmp/signal-cli.tar.gz -C /usr/local/bin',
      'rm /tmp/signal-cli.tar.gz',
    ],
    defaultUser: 'ubuntu',
    rootDeviceName: '/dev/sda1',
  };
}
