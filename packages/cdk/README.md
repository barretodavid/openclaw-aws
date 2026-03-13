# openclaw-cdk

AWS CDK stack that provisions all infrastructure for the OpenClaw agent: EC2 instances, IAM roles, KMS wallet key, Secrets Manager secrets, Route 53 private DNS, and security groups. See the [root README](../../README.md) for setup, deployment, and teardown instructions.

## Components

| Component | AWS Service | Purpose | Why this service |
|---|---|---|---|
| Agent Server | EC2 (configurable, default t3a.large, 30 GB EBS) | Runs OpenClaw agent (no gateway) | Long-running process needs a persistent server; instance type is configurable in `bin/openclaw.ts` |
| Gateway Server | EC2 (t3a.small, Ubuntu 24.04 LTS) | Runs OpenClaw gateway for channel integrations (Signal, Telegram) | Separate instance isolates channel credentials from agent; agent connects via WebSocket on port 18789; ~$14/month |
| Remote Access | SSM Session Manager | Shell access to all EC2 instances without open ports | No inbound ports, no SSH keys to manage, IAM-based access control, full session audit via CloudTrail |
| Wallet Key | KMS (ECC_NIST_P256) | Starknet secp256r1 signing -- private key never leaves HSM | Hardware-backed key that supports `Sign` API; key material is non-extractable by design |
| API Key Secrets | Secrets Manager | Stores LLM, RPC, web search, and gateway token secrets (Agent Server) + Telegram token (Gateway Server) | Encrypted at rest, fine-grained IAM access; each server fetches only its own secrets at runtime via OpenClaw's exec provider |
| Private DNS | Route 53 Private Hosted Zone (`<AGENT_NAME>.vpc`) | `gateway.<AGENT_NAME>.vpc` for gateway server | Agent addresses gateway by hostname |
| Network | Default VPC, public subnets | Hosts all EC2 instances | No custom VPC or NAT Gateway needed; security comes from IAM/KMS boundaries and security groups (no inbound rules), not network isolation |

## Security Boundaries

* Agent never sees private key material -- signs via KMS `Sign` API only
* Agent never sees channel credentials -- they are stored on the Gateway Server EC2 which has its own IAM role
* **Agent Server EC2 IAM role** grants: KMS wallet operations (`CreateKey`, `Sign`, `GetPublicKey`, `DescribeKey`, `TagResource` scoped to `<AGENT_NAME>:wallet` tag) + `secretsmanager:GetSecretValue` on the four API key secrets + `AmazonSSMManagedInstanceCore` managed policy
* **Gateway Server EC2 IAM role** grants: `AmazonSSMManagedInstanceCore` managed policy + conditional `secretsmanager:GetSecretValue` on `<AGENT_NAME>/telegram-token` when `TELEGRAM_BOT_TOKEN` is set in `.env` (no KMS)
* Two separate EC2 instances = two separate IAM roles -- a compromised gateway server cannot access the wallet key or Agent Server API key secrets
* Gateway Server security group: inbound only from Agent Server EC2 security group on port 18789 (WebSocket); outbound HTTPS (443) for channel APIs (Signal, Telegram), HTTP (80) for apt
* Agent Server security group: no inbound from internet; outbound HTTPS (443), HTTP (80 for package repos), port 18789 to gateway server

## Design Decisions

* **SSM instead of SSH** -- No inbound ports, no key management, IAM-controlled access, CloudTrail audit trail.
* **KMS key instead of Secrets Manager for the wallet** -- KMS `Sign` API lets the agent sign transactions without ever accessing key material. A Secrets Manager secret would require fetching the raw private key into the agent's memory.
* **Broad HTTPS egress for Agent EC2** -- Restricting the agent to specific IPs would limit its usefulness. The security model relies on IAM and KMS boundaries to protect secrets, not on network egress filtering. The private key never leaves KMS, and API key secrets are scoped to the agent's IAM role.
* **Transaction guardrails on-chain, not in AWS** -- KMS signs whatever hash is sent to it and cannot judge transaction intent. Instead of CloudTrail alerting (which only detects after the fact), spending limits, whitelisted addresses, rate limits, and time locks are enforced at the Starknet account contract level. This prevents malicious transactions at the protocol level even if the agent and KMS are fully compromised.
* **Default VPC with public subnets, no NAT Gateway** -- Private subnets + NAT Gateway add ~$32/month and complexity for minimal security benefit. Our security model relies on IAM roles and KMS, not network isolation. Security groups with no inbound rules make the instances unreachable from the internet. Outbound internet works directly without a NAT Gateway.
* **Separate gateway server instance for channel credential isolation** -- Channel credentials (Signal phone registration, Telegram bot tokens) are high-value targets. Running the gateway on a separate EC2 instance with its own IAM role means a compromised agent cannot exfiltrate them. The agent communicates with the gateway server over a plain WebSocket (`ws://gateway.<AGENT_NAME>.vpc:18789`) within the VPC -- TLS is unnecessary since the threat model is software compromise (credential exfiltration), not network sniffing within the VPC.
* **`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS` set by default** -- OpenClaw requires this env var to use plain `ws://` over non-loopback interfaces. Both the Agent Server and Gateway Server instances set it via `/etc/profile.d/openclaw.sh` in user data. This is safe because the gateway server security group restricts inbound to the Agent SG on port 18789 only -- the SG is the access control layer, not WebSocket auth.

## Configuration

Edit `bin/openclaw.ts` to customize deployment settings:

```typescript
new OpenclawStack(app, agentName, {
  // ...
  agentName,
  availabilityZone: 'ca-central-1b',
  agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
  gatewayServerInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.SMALL),
  agentVolumeGb: 30,
});
```

Only x86_64 instance types are supported (e.g. t3a, t3, m5a, m7i). ARM/Graviton instance types (t4g, m7g, etc.) are not supported. All instances run Ubuntu 24.04 LTS with Node.js 22 and SSM Agent. The agent server instance also has Docker and AWS CLI; the gateway server instance has signal-cli.

All EC2 instances run `unattended-upgrades` for automatic daily security updates. If a kernel update requires a reboot, instances reboot automatically at 03:00 UTC.

## Supported providers

Providers are configured in `.env` (see `.env.example` for the full list). The supported provider names are validated at synth time against the registries in `lib/ec2-config.ts`:

* **LLM:** venice, anthropic, openai, google, mistral, groq, xai, openrouter, cerebras
* **RPC (Starknet):** alchemy, infura, cartridge, voyager (optional)
* **Web search:** brave, gemini, grok, kimi, perplexity

## Rotate an API key

The stack creates up to five Secrets Manager secrets:

| Secret name | `.env` variable | Required | Readable by |
|---|---|---|---|
| `<AGENT_NAME>/llm-api-key` | `LLM_API_KEY` | Yes | Agent Server |
| `<AGENT_NAME>/rpc-api-key` | `RPC_API_KEY` | No | Agent Server |
| `<AGENT_NAME>/web-search-api-key` | `WEB_SEARCH_API_KEY` | Yes | Agent Server |
| `<AGENT_NAME>/gateway-token` | (populated post-deploy) | Yes | Agent Server |
| `<AGENT_NAME>/telegram-token` | `TELEGRAM_BOT_TOKEN` | No | Gateway Server |

To rotate a key:

```bash
aws secretsmanager put-secret-value \
  --secret-id <AGENT_NAME>/llm-api-key \
  --secret-string "new-api-key-here"
```

**No restart needed.** The agent uses OpenClaw's `exec` provider, which fetches the secret fresh from Secrets Manager on every use. The new value is picked up immediately on the next request.

**Important:** Also update `.env` with the new key value. CDK manages the secret value from `.env` at deploy time -- if `.env` still has the old key, the next `cdk deploy` will silently revert the rotation.
