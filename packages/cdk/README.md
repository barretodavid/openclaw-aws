# openclaw-cdk

AWS CDK stack that provisions all infrastructure for the OpenClaw agent: EC2 instance, IAM role, KMS wallet key, Secrets Manager secrets, and security group. See the [root README](../../README.md) for setup, deployment, and teardown instructions.

## Components

| Component | AWS Service | Purpose | Why this service |
|---|---|---|---|
| Agent Server | EC2 (configurable, default t3a.xlarge, 30 GB EBS) | Runs OpenClaw gateway with agent logic, channels, and Docker sandboxing | Long-running process needs a persistent server; instance type is configurable in `bin/openclaw.ts` |
| Remote Access | SSM Session Manager | Shell access to the EC2 instance without open ports | No inbound ports, no SSH keys to manage, IAM-based access control, full session audit via CloudTrail |
| Wallet Key | KMS (ECC_NIST_P256) | Starknet secp256r1 signing -- private key never leaves HSM | Hardware-backed key that supports `Sign` API; key material is non-extractable by design |
| API Key Secrets | Secrets Manager | Stores LLM, RPC, web search, and Telegram token secrets | Encrypted at rest, fine-grained IAM access; the server fetches secrets at runtime via OpenClaw's exec provider |
| Network | Default VPC, public subnet | Hosts the EC2 instance | No custom VPC or NAT Gateway needed; security comes from IAM/KMS boundaries and security group (no inbound rules), not network isolation |

## Security Boundaries

* Agent never sees private key material -- signs via KMS `Sign` API only
* **IAM role** grants: KMS wallet operations (`CreateKey`, `Sign`, `GetPublicKey`, `DescribeKey`, `TagResource` scoped to `<AGENT_NAME>:wallet` tag) + `secretsmanager:GetSecretValue` on all API key secrets + `AmazonSSMManagedInstanceCore` managed policy
* Security group: no inbound from internet; outbound HTTPS (443) and HTTP (80 for package repos)

## Design Decisions

* **SSM instead of SSH** -- No inbound ports, no key management, IAM-controlled access, CloudTrail audit trail.
* **KMS key instead of Secrets Manager for the wallet** -- KMS `Sign` API lets the agent sign transactions without ever accessing key material. A Secrets Manager secret would require fetching the raw private key into the agent's memory.
* **Broad HTTPS egress** -- Restricting to specific IPs would limit usefulness. The security model relies on IAM and KMS boundaries to protect secrets, not on network egress filtering. The private key never leaves KMS, and API key secrets are scoped to the IAM role.
* **Transaction guardrails on-chain, not in AWS** -- KMS signs whatever hash is sent to it and cannot judge transaction intent. Instead of CloudTrail alerting (which only detects after the fact), spending limits, whitelisted addresses, rate limits, and time locks are enforced at the Starknet account contract level. This prevents malicious transactions at the protocol level even if the agent and KMS are fully compromised.
* **Default VPC with public subnets, no NAT Gateway** -- Private subnets + NAT Gateway add ~$32/month and complexity for minimal security benefit. Our security model relies on IAM roles and KMS, not network isolation. Security groups with no inbound rules make the instance unreachable from the internet. Outbound internet works directly without a NAT Gateway.
* **Single server** -- OpenClaw's gateway-centric architecture runs all agent logic, channels, and tool execution on the gateway process. A second server would only add cost and complexity without meaningful security separation. KMS protects the wallet key regardless -- the private key never leaves the HSM.

## Configuration

Edit `bin/openclaw.ts` to customize deployment settings:

```typescript
new OpenclawStack(app, agentName, {
  // ...
  agentName,
  availabilityZone: 'ca-central-1b',
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.XLARGE),
  volumeGb: 30,
});
```

Only x86_64 instance types are supported (e.g. t3a, t3, m5a, m7i). ARM/Graviton instance types (t4g, m7g, etc.) are not supported. The instance runs Ubuntu 24.04 LTS with Node.js 24, Docker, signal-cli, OpenClaw, and AWS CLI.

The instance runs `unattended-upgrades` for automatic daily security updates. If a kernel update requires a reboot, the instance reboots automatically at 03:00 UTC.

## Supported providers

Providers are configured in `.env` (see `.env.example` for the full list). The supported provider names are validated at synth time against the registries in `lib/ec2-config.ts`:

* **LLM:** venice, anthropic, openai, google, mistral, groq, xai, openrouter, cerebras
* **RPC (Starknet):** alchemy, infura, cartridge, voyager (optional)
* **Web search:** brave, gemini, grok, kimi, perplexity

## Rotate an API key

The stack creates up to four Secrets Manager secrets:

| Secret name | `.env` variable | Required |
|---|---|---|
| `<AGENT_NAME>/llm-api-key` | `LLM_API_KEY` | Yes |
| `<AGENT_NAME>/rpc-api-key` | `RPC_API_KEY` | No |
| `<AGENT_NAME>/web-search-api-key` | `WEB_SEARCH_API_KEY` | Yes |
| `<AGENT_NAME>/telegram-token` | `TELEGRAM_BOT_TOKEN` | No |

To rotate a key:

```bash
aws secretsmanager put-secret-value \
  --secret-id <AGENT_NAME>/llm-api-key \
  --secret-string "new-api-key-here"
```

**No restart needed.** The agent uses OpenClaw's `exec` provider, which fetches the secret fresh from Secrets Manager on every use. The new value is picked up immediately on the next request.

**Important:** Also update `.env` with the new key value. CDK manages the secret value from `.env` at deploy time -- if `.env` still has the old key, the next `cdk deploy` will silently revert the rotation.
