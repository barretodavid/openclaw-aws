# openclaw-cdk

AWS CDK stack that provisions all infrastructure for the OpenClaw agent: EC2 instances, IAM roles, KMS wallet key, per-provider Secrets Manager secrets, SSM proxy config, Route 53 private DNS, and security groups. See the [root README](../../README.md) for setup, deployment, and teardown instructions.

## Components

| Component | AWS Service | Purpose | Why this service |
|---|---|---|---|
| Agent Server | EC2 (configurable, default t3a.large, 30 GB EBS) | Runs OpenClaw + agents | Long-running process needs a persistent server; instance type is configurable in `bin/openclaw.ts` |
| API Proxy | EC2 (t3a.nano, Ubuntu 24.04 LTS) | Routes requests by subdomain, injects real API keys, streams responses back to agent | Dedicated instance provides hard IAM boundary from agent; supports streaming (SSE) which Lambda cannot; ~$1.50/month; runs the [`openclaw-aws-proxy`](../proxy/) npm package as a systemd service |
| Remote Access | SSM Session Manager | Shell access to both EC2 instances without open ports | No inbound ports, no SSH keys to manage, IAM-based access control, full session audit via CloudTrail |
| Wallet Key | KMS (ECC_NIST_P256) | Starknet secp256r1 signing -- private key never leaves HSM | Hardware-backed key that supports `Sign` API; key material is non-extractable by design |
| Provider API Keys | Secrets Manager (one secret per provider) | Stores the real API key for each configured provider (e.g. `openclaw/anthropic-api-key`) | Encrypted at rest, fine-grained IAM access, supports rotation; only the Proxy EC2 can read them |
| Proxy Config | SSM Parameter Store (String) | JSON mapping of provider subdomains to backend domains, secret names, and key injection methods | Free, not a secret, readable by the proxy at startup; stored at `/openclaw/proxy-config` |
| Private DNS | Route 53 Private Hosted Zone (`vpc`) | Per-provider DNS records (e.g. `anthropic.proxy.vpc`, `openai.proxy.vpc`) pointing to the proxy private IP | Agent addresses the proxy by subdomain; the proxy uses the subdomain to look up the right provider config |
| Network | Default VPC, public subnets | Hosts both EC2 instances | No custom VPC or NAT Gateway needed; security comes from IAM/KMS boundaries and security groups (no inbound rules), not network isolation |

## Security Boundaries

* Agent never sees real API keys -- it sends requests to provider subdomains (e.g. `anthropic.proxy.vpc:8080`) and the proxy injects the real key before forwarding
* Agent never sees private key material -- signs via KMS `Sign` API only
* **Agent EC2 IAM role** grants: `kms:Sign` on the wallet key + `AmazonSSMManagedInstanceCore` managed policy
* **Proxy EC2 IAM role** grants: `secretsmanager:GetSecretValue` on each provider's API key secret + `ssm:GetParameter` on the proxy config parameter + `AmazonSSMManagedInstanceCore` managed policy
* Proxy only forwards requests to providers present in the SSM proxy config -- rejects unknown subdomains
* Separate EC2 instances = separate IAM roles -- even a fully compromised agent cannot call Secrets Manager
* Proxy security group: inbound only from Agent EC2 security group on the proxy port; outbound HTTPS (443) for reaching providers
* Agent security group: no inbound from internet; outbound HTTPS (443), HTTP (80 for package repos), and port 8080 to proxy -- secrets are protected by IAM/KMS boundaries, not network restrictions

## Design Decisions

* **EC2 proxy instead of Lambda** -- OpenClaw hardcodes `stream: true` for LLM requests (SSE). Lambda cannot stream responses back to the caller in a standard invocation. A dedicated EC2 instance supports streaming natively and provides a hard IAM-level security boundary without requiring Docker on the agent host.
* **Subdomain-based routing** -- The agent addresses each provider via its own subdomain (e.g. `anthropic.proxy.vpc:8080`). The proxy extracts the subdomain from the `Host` header, looks up the provider config, fetches the correct secret, and injects the API key using the provider-specific method (header or URL path). This lets one proxy instance serve all providers with no agent-side configuration.
* **SSM instead of SSH** -- No inbound ports, no key management, IAM-controlled access, CloudTrail audit trail.
* **KMS key instead of Secrets Manager for the wallet** -- KMS `Sign` API lets the agent sign transactions without ever accessing key material. A Secrets Manager secret would require fetching the raw private key into the agent's memory.
* **Broad HTTPS egress for Agent EC2** -- Restricting the agent to specific IPs would limit its usefulness. The security model relies on IAM and KMS boundaries to protect secrets, not on network egress filtering. The agent has no IAM access to Secrets Manager, and the private key never leaves KMS.
* **Transaction guardrails on-chain, not in AWS** -- KMS signs whatever hash is sent to it and cannot judge transaction intent. Instead of CloudTrail alerting (which only detects after the fact), spending limits, whitelisted addresses, rate limits, and time locks are enforced at the Starknet account contract level. This prevents malicious transactions at the protocol level even if the agent and KMS are fully compromised.
* **Default VPC with public subnets, no NAT Gateway** -- Private subnets + NAT Gateway add ~$32/month and complexity for minimal security benefit. Our security model relies on IAM roles and KMS, not network isolation. Security groups with no inbound rules make the instances unreachable from the internet. Outbound internet works directly without a NAT Gateway.

## Customize the Agent Instance

Edit `bin/openclaw.ts` to change the agent's instance type:

```typescript
agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.XLARGE),
```

Only x86_64 instance types are supported (e.g. t3a, t3, m5a, m7i). ARM/Graviton instance types (t4g, m7g, etc.) are not supported. Both instances run Ubuntu 24.04 LTS with Node.js 22, Docker, and SSM Agent installed automatically.

Both EC2 instances run `unattended-upgrades` for automatic daily security updates. If a kernel update requires a reboot, instances reboot automatically at 03:00 UTC.

## Supported providers

The proxy supports the following providers. Only providers with an API key set in `.env` are deployed (secret + DNS record + proxy config entry):

**LLM Providers**

| Provider | Domain | Subdomain | Key Injection |
|---|---|---|---|
| Anthropic | `api.anthropic.com` | `anthropic.proxy.vpc` | `x-api-key` header |
| OpenAI | `api.openai.com` | `openai.proxy.vpc` | `Authorization: Bearer` header |
| Google Gemini | `generativelanguage.googleapis.com` | `google.proxy.vpc` | `x-goog-api-key` header |
| Mistral | `api.mistral.ai` | `mistral.proxy.vpc` | `Authorization: Bearer` header |
| Groq | `api.groq.com` | `groq.proxy.vpc` | `Authorization: Bearer` header |
| xAI | `api.x.ai` | `xai.proxy.vpc` | `Authorization: Bearer` header |
| OpenRouter | `openrouter.ai` | `openrouter.proxy.vpc` | `Authorization: Bearer` header |
| Venice | `api.venice.ai` | `venice.proxy.vpc` | `Authorization: Bearer` header |
| Cerebras | `api.cerebras.ai` | `cerebras.proxy.vpc` | `Authorization: Bearer` header |

**Search**

| Provider | Domain | Subdomain | Key Injection |
|---|---|---|---|
| Brave Search | `api.search.brave.com` | `brave.proxy.vpc` | `X-Subscription-Token` header |

**Starknet RPC Providers**

| Provider | Domain | Subdomain | Key Injection |
|---|---|---|---|
| Alchemy | `starknet-mainnet.g.alchemy.com` | `alchemy.proxy.vpc` | URL path segment |
| Infura | `starknet-mainnet.infura.io` | `infura.proxy.vpc` | URL path segment |
| Cartridge | `api.cartridge.gg` | `cartridge.proxy.vpc` | `Authorization: Bearer` header |
| Voyager | `data.voyager.online` | `voyager.proxy.vpc` | `x-apikey` header |

**Add a new provider after deployment:** create a Secrets Manager secret, update the SSM proxy config JSON at `/openclaw/proxy-config`, add a Route 53 A record, and restart the proxy. Or add the env var to `.env` and run `npx cdk deploy`.

## Rotate an API key

Each provider has its own secret. The secret name follows the pattern `openclaw/<env-var-in-lowercase-with-hyphens>` (e.g. `openclaw/anthropic-api-key` for `ANTHROPIC_API_KEY`).

```bash
aws secretsmanager put-secret-value \
  --secret-id openclaw/anthropic-api-key \
  --secret-string "new-api-key-here"
```

Then restart the proxy process to pick up the new key.

Alternatively, update `.env` and run `npx cdk deploy` to update the key via CDK.
