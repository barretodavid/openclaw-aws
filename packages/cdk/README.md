# openclaw-cdk

AWS CDK stack that provisions all infrastructure for the OpenClaw agent: EC2 instances, IAM roles, KMS wallet key, per-provider Secrets Manager secrets, SSM proxy config, Route 53 private DNS, and security groups. See the [root README](../../README.md) for setup, deployment, and teardown instructions.

## Components

| Component | AWS Service | Purpose | Why this service |
|---|---|---|---|
| Agent Server | EC2 (configurable, default t3a.large, 30 GB EBS) | Runs OpenClaw agent (no gateway) | Long-running process needs a persistent server; instance type is configurable in `bin/openclaw.ts` |
| Gateway Server | EC2 (t3a.nano, Ubuntu 24.04 LTS) | Runs OpenClaw gateway for channel integrations (Signal, Telegram) | Separate instance isolates channel credentials from agent; agent connects via WebSocket on port 18789; ~$1.50/month |
| API Proxy | EC2 (t3a.nano, Ubuntu 24.04 LTS) | Routes requests by subdomain, injects real API keys, streams responses back to agent | Dedicated instance provides hard IAM boundary from agent; supports streaming (SSE) which Lambda cannot; ~$1.50/month; runs the [`openclaw-aws-proxy`](../proxy/) npm package as a systemd service |
| Remote Access | SSM Session Manager | Shell access to all EC2 instances without open ports | No inbound ports, no SSH keys to manage, IAM-based access control, full session audit via CloudTrail |
| Wallet Key | KMS (ECC_NIST_P256) | Starknet secp256r1 signing -- private key never leaves HSM | Hardware-backed key that supports `Sign` API; key material is non-extractable by design |
| Provider API Keys | Secrets Manager (one secret per provider) | Stores the real API key for each configured provider (e.g. `openclaw/anthropic-api-key`) | Encrypted at rest, fine-grained IAM access, supports rotation; only the Proxy EC2 can read them |
| Proxy Config | SSM Parameter Store (String) | JSON mapping of provider subdomains to backend domains, secret names, and key injection methods | Free, not a secret, readable by the proxy at startup; stored at `/openclaw/proxy-config` |
| Private DNS | Route 53 Private Hosted Zone (`vpc`) | `gateway.vpc` for gateway, per-provider records (e.g. `anthropic.proxy.vpc`) for proxy | Agent addresses services by hostname; proxy uses subdomain to look up provider config |
| Network | Default VPC, public subnets | Hosts all EC2 instances | No custom VPC or NAT Gateway needed; security comes from IAM/KMS boundaries and security groups (no inbound rules), not network isolation |

## Security Boundaries

* Agent never sees real API keys -- it sends requests to provider subdomains (e.g. `anthropic.proxy.vpc:8080`) and the proxy injects the real key before forwarding
* Agent never sees private key material -- signs via KMS `Sign` API only
* Agent never sees channel credentials -- they are stored on the Gateway EC2 which has its own IAM role
* **Agent EC2 IAM role** grants: `kms:Sign` on the wallet key + `AmazonSSMManagedInstanceCore` managed policy
* **Gateway EC2 IAM role** grants: `AmazonSSMManagedInstanceCore` managed policy only (no KMS, no Secrets Manager)
* **Proxy EC2 IAM role** grants: `secretsmanager:GetSecretValue` on each provider's API key secret + `ssm:GetParameter` on the proxy config parameter + `AmazonSSMManagedInstanceCore` managed policy
* Proxy only forwards requests to providers present in the SSM proxy config -- rejects unknown subdomains
* Three separate EC2 instances = three separate IAM roles -- a compromised agent cannot access Secrets Manager or channel credentials
* Gateway security group: inbound only from Agent EC2 security group on port 18789 (WebSocket); outbound HTTPS (443) for channel APIs (Signal, Telegram), HTTP (80) for apt
* Proxy security group: inbound only from Agent EC2 security group on the proxy port; outbound HTTPS (443) for reaching providers
* Agent security group: no inbound from internet; outbound HTTPS (443), HTTP (80 for package repos), port 8080 to proxy, port 18789 to gateway -- secrets are protected by IAM/KMS boundaries, not network restrictions

## Design Decisions

* **EC2 proxy instead of Lambda** -- OpenClaw hardcodes `stream: true` for LLM requests (SSE). Lambda cannot stream responses back to the caller in a standard invocation. A dedicated EC2 instance supports streaming natively and provides a hard IAM-level security boundary without requiring Docker on the agent host.
* **Subdomain-based routing** -- The agent addresses each provider via its own subdomain (e.g. `anthropic.proxy.vpc:8080`). The proxy extracts the subdomain from the `Host` header, looks up the provider config, fetches the correct secret, and injects the API key using the provider-specific method (header or URL path). This lets one proxy instance serve all providers with no agent-side configuration.
* **SSM instead of SSH** -- No inbound ports, no key management, IAM-controlled access, CloudTrail audit trail.
* **KMS key instead of Secrets Manager for the wallet** -- KMS `Sign` API lets the agent sign transactions without ever accessing key material. A Secrets Manager secret would require fetching the raw private key into the agent's memory.
* **Broad HTTPS egress for Agent EC2** -- Restricting the agent to specific IPs would limit its usefulness. The security model relies on IAM and KMS boundaries to protect secrets, not on network egress filtering. The agent has no IAM access to Secrets Manager, and the private key never leaves KMS.
* **Transaction guardrails on-chain, not in AWS** -- KMS signs whatever hash is sent to it and cannot judge transaction intent. Instead of CloudTrail alerting (which only detects after the fact), spending limits, whitelisted addresses, rate limits, and time locks are enforced at the Starknet account contract level. This prevents malicious transactions at the protocol level even if the agent and KMS are fully compromised.
* **Default VPC with public subnets, no NAT Gateway** -- Private subnets + NAT Gateway add ~$32/month and complexity for minimal security benefit. Our security model relies on IAM roles and KMS, not network isolation. Security groups with no inbound rules make the instances unreachable from the internet. Outbound internet works directly without a NAT Gateway.
* **Separate gateway instance for channel credential isolation** -- Channel credentials (Signal phone registration, Telegram bot tokens) are high-value targets. Running the gateway on a separate EC2 instance with its own IAM role means a compromised agent cannot exfiltrate them. The agent communicates with the gateway over a plain WebSocket (`ws://gateway.vpc:18789`) within the VPC -- TLS is unnecessary since the threat model is software compromise (credential exfiltration), not network sniffing within the VPC.
* **`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS` set by default** -- OpenClaw requires this env var to use plain `ws://` over non-loopback interfaces. Both the Agent and Gateway instances set it via `/etc/profile.d/openclaw.sh` in user data. This is safe because the gateway security group restricts inbound to the Agent SG on port 18789 only -- the SG is the access control layer, not WebSocket auth.
* **Brave Search key is not proxied** -- OpenClaw hardcodes the Brave Search endpoint URL (`https://api.search.brave.com`) with no configuration override. Routing it through the proxy would require TLS termination with a private CA issuing certificates for third-party domains, adding significant complexity. Since the Brave key only grants read access to web search results (no financial risk, no write operations), the risk of exposing it directly to the agent is acceptable. Set `BRAVE_API_KEY` as an environment variable on the agent server.

## Configuration

Edit `bin/openclaw.ts` to customize deployment settings:

```typescript
new OpenclawStack(app, 'OpenclawStack', {
  // ...
  availabilityZone: 'ca-central-1b',
  agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
  proxyInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.NANO),
  gatewayInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.NANO),
  agentVolumeGb: 30,
});
```

Only x86_64 instance types are supported (e.g. t3a, t3, m5a, m7i). ARM/Graviton instance types (t4g, m7g, etc.) are not supported. All instances run Ubuntu 24.04 LTS with Node.js 22 and SSM Agent. The agent instance also has Docker and AWS CLI; the gateway instance has signal-cli.

All EC2 instances run `unattended-upgrades` for automatic daily security updates. If a kernel update requires a reboot, instances reboot automatically at 03:00 UTC.

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
