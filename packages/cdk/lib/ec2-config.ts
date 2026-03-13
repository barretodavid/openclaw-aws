import * as ec2 from 'aws-cdk-lib/aws-ec2';

// --- Provider Registries (validation-only, OpenClaw handles routing natively) ---

export const LLM_PROVIDERS: Record<string, { domain: string }> = {
  venice:     { domain: 'api.venice.ai' },
  anthropic:  { domain: 'api.anthropic.com' },
  openai:     { domain: 'api.openai.com' },
  google:     { domain: 'generativelanguage.googleapis.com' },
  mistral:    { domain: 'api.mistral.ai' },
  groq:       { domain: 'api.groq.com' },
  xai:        { domain: 'api.x.ai' },
  openrouter: { domain: 'openrouter.ai' },
  cerebras:   { domain: 'api.cerebras.ai' },
};

export const RPC_PROVIDERS: Record<string, { domain: string }> = {
  alchemy:   { domain: 'starknet-mainnet.g.alchemy.com' },
  infura:    { domain: 'starknet-mainnet.infura.io' },
  cartridge: { domain: 'api.cartridge.gg' },
  voyager:   { domain: 'data.voyager.online' },
};

export const WEB_SEARCH_PROVIDERS: Record<string, { domain: string }> = {
  brave:      { domain: 'api.search.brave.com' },
  gemini:     { domain: 'generativelanguage.googleapis.com' },
  grok:       { domain: 'api.x.ai' },
  kimi:       { domain: 'api.moonshot.cn' },
  perplexity: { domain: 'api.perplexity.ai' },
};

// --- Ubuntu User Data ---

/** Shared Ubuntu 24.04 user data: Node.js 22, AWS CLI v2, unattended-upgrades with auto-reboot. */
export function ubuntuBaseUserData(extraAptPackages: string[] = []): string[] {
  const aptPackages = [...extraAptPackages, 'unzip', 'nodejs', 'unattended-upgrades'].join(' ');
  return [
    'apt-get update -y',
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    `apt-get install -y ${aptPackages}`,
    // AWS CLI v2 (official installer)
    'curl -fsSL -o /tmp/awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip',
    'unzip -q /tmp/awscliv2.zip -d /tmp',
    '/tmp/aws/install',
    'rm -rf /tmp/awscliv2.zip /tmp/aws',
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
  ];
}

// --- Required Keys ---

/** Validates that WEB_SEARCH_PROVIDER and WEB_SEARCH_API_KEY are set in .env. Returns the API key. */
export function requireWebProvider(): string {
  const provider = process.env.WEB_SEARCH_PROVIDER;
  if (!provider) {
    throw new Error(
      `WEB_SEARCH_PROVIDER is required in .env. Set one of: ${Object.keys(WEB_SEARCH_PROVIDERS).join(', ')}`,
    );
  }
  if (!WEB_SEARCH_PROVIDERS[provider]) {
    throw new Error(
      `Unknown WEB_SEARCH_PROVIDER "${provider}". Must be one of: ${Object.keys(WEB_SEARCH_PROVIDERS).join(', ')}`,
    );
  }
  const apiKey = process.env.WEB_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('WEB_SEARCH_API_KEY is required in .env when WEB_SEARCH_PROVIDER is set.');
  }
  return apiKey;
}

/** Validates that LLM_PROVIDER and LLM_API_KEY are set in .env. Returns the API key. */
export function requireLlmProvider(): string {
  const provider = process.env.LLM_PROVIDER;
  if (!provider) {
    throw new Error(
      `LLM_PROVIDER is required in .env. Set one of: ${Object.keys(LLM_PROVIDERS).join(', ')}`,
    );
  }
  if (!LLM_PROVIDERS[provider]) {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}". Must be one of: ${Object.keys(LLM_PROVIDERS).join(', ')}`,
    );
  }
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is required in .env when LLM_PROVIDER is set.');
  }
  return apiKey;
}

/** Optionally resolves RPC_PROVIDER + RPC_API_KEY from .env. Returns the API key or null. */
export function resolveRpcProvider(): string | null {
  const provider = process.env.RPC_PROVIDER;
  const apiKey = process.env.RPC_API_KEY;
  if (!provider && !apiKey) return null;
  if (!provider) {
    throw new Error(
      `RPC_PROVIDER is required in .env when RPC_API_KEY is set. Set one of: ${Object.keys(RPC_PROVIDERS).join(', ')}`,
    );
  }
  if (!RPC_PROVIDERS[provider]) {
    throw new Error(
      `Unknown RPC_PROVIDER "${provider}". Must be one of: ${Object.keys(RPC_PROVIDERS).join(', ')}`,
    );
  }
  if (!apiKey) {
    throw new Error('RPC_API_KEY is required in .env when RPC_PROVIDER is set.');
  }
  return apiKey;
}

/** Optionally resolves TELEGRAM_BOT_TOKEN from .env. Returns the token or null. */
export function resolveTelegramToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token || null;
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
      ...ubuntuBaseUserData(['docker.io']),
      'systemctl enable docker',
      'systemctl start docker',
      // npm global prefix for ubuntu user (avoids sudo for npm install -g)
      'sudo -u ubuntu mkdir -p /home/ubuntu/.npm-global',
      'sudo -u ubuntu npm config set prefix /home/ubuntu/.npm-global',
      'echo \'export PATH="/home/ubuntu/.npm-global/bin:$PATH"\' > /etc/profile.d/npm-global.sh',
      'echo \'export PATH="/home/ubuntu/.npm-global/bin:$PATH"\' >> /home/ubuntu/.bashrc',
      // OpenClaw needs this to use plain ws:// over non-loopback (VPC-internal, SG-protected)
      'echo \'export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1\' > /etc/profile.d/openclaw.sh',
      // Enable systemd user instance for ubuntu (persists user services without login)
      'loginctl enable-linger ubuntu',
      // Pre-install OpenClaw (no auto-start -- gateway server depends on manual signal-cli setup, agent depends on gateway server)
      'sudo -u ubuntu npm install -g openclaw',
    ],
    defaultUser: 'ubuntu',
    rootDeviceName: '/dev/sda1',
  };
}
