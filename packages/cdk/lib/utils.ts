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
export function ubuntuBaseUserData(extraAptPackages: string[] = []): string[] {
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
  ];
}
