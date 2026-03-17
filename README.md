# OpenClaw Safe Agent Infrastructure

Secure AWS infrastructure for running an OpenClaw agent using AWS CDK. Protects the Starknet wallet private key (via KMS), API keys and channel credentials (via Secrets Manager with per-server IAM scoping) so that even a compromised agent cannot extract the wallet key.

## Architecture

```mermaid
graph LR
    Laptop -->|"SSM Session Manager"| AgentEC2
    Laptop -->|"SSM Session Manager"| GatewayEC2
    subgraph VPC ["Default VPC -- public subnets"]
        DNS["Route 53<br/>Private Hosted Zone<br/>(gateway.&lt;AGENT_NAME&gt;.vpc)"]
        AgentEC2["Agent Server<br/>(EC2, configurable)"]
        GatewayEC2["Gateway Server<br/>(EC2 t3a.small)"]
        AgentEC2 -->|"WebSocket<br/>(ws://gateway.&lt;AGENT_NAME&gt;.vpc:18789)"| GatewayEC2
    end
    GatewayEC2 -->|"channel messages"| Channels["Telegram / WhatsApp<br/>/ Signal"]
    AgentEC2 -->|"reads API keys"| SM["Secrets Manager<br/>(LLM, RPC, Web, gateway token, Telegram token)"]
    GatewayEC2 -->|"reads Telegram token"| SM
    AgentEC2 -->|"HTTPS"| LLM["LLM Provider<br/>(Venice.ai)"]
    AgentEC2 -->|"HTTPS"| RPC["RPC Provider<br/>(Alchemy)"]
    AgentEC2 <-->|"Sign(tx hash) / signature"| KMS["KMS<br/>(ECC_NIST_P256)"]
    AgentEC2 -->|"signed tx"| Blockchain
```

## Packages

| Package | Description |
|---|---|
| [`packages/cdk`](packages/cdk/) | AWS CDK stack -- EC2 instances, IAM roles, KMS, Secrets Manager, Route 53, security groups |
| [`packages/shared`](packages/shared/) | Internal AWS utilities -- client creation, SSM commands, instance discovery, cloud-init readiness |
| [`packages/integration`](packages/integration/) | Integration test suite -- runs against deployed stack via SSM |

## Prerequisites

* [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with credentials
* [Node.js](https://nodejs.org/) (v18+)
* [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) (`npm install -g aws-cdk`)
* [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for connecting to EC2 instances

### Install AWS CLI

**macOS (Homebrew):**

```bash
brew install awscli
```

**Linux:**

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

**Verify installation and configure credentials:**

```bash
aws --version
aws configure
```

You'll need an IAM user Access Key ID and Secret Access Key -- generate these from the [IAM Console](https://console.aws.amazon.com/iam/) under **Users > Security credentials > Create access key**.

### Install Session Manager plugin

**macOS (Apple Silicon):**

```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac_arm64/session-manager-plugin.pkg" -o "session-manager-plugin.pkg"
sudo installer -pkg session-manager-plugin.pkg -target /
```

**macOS (Intel):**

```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac/session-manager-plugin.pkg" -o "session-manager-plugin.pkg"
sudo installer -pkg session-manager-plugin.pkg -target /
```

**Linux (Debian/Ubuntu):**

```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
sudo dpkg -i session-manager-plugin.deb
```

## Setup

```bash
git clone <repo-url>
cd safe-aws-agent-infra
npm install
cp .env.example .env
```

### Choose a messaging channel

Your agent needs a messaging channel so you can talk to it. OpenClaw supports Telegram, WhatsApp, and Signal. Choose one before deploying:

| Property | Telegram | WhatsApp | Signal |
|---|---|---|---|
| **Setup difficulty** | Low | Medium | High |
| **Setup cost** | Low | High | Medium |
| **Maintenance** | Low | Medium | Low |
| **Privacy** | Low | High | Very High |
| **User familiarity** | Medium | High | Low |
| **Survives redeploy** | Yes | No | No |

**Setup difficulty** -- what's involved in getting the channel running

- **Telegram: Low** -- Create a bot via @BotFather, copy the token, paste it into `.env`. No phone, no binary, no registration ceremony.
- **WhatsApp: Medium** -- Install WhatsApp on a dedicated phone, then scan a QR code from the Gateway Server terminal. Straightforward but requires a physical device nearby during setup.
- **Signal: High** -- Solve a CAPTCHA in a browser, register the phone number via signal-cli, wait for an SMS code, verify it. Multiple steps across multiple tools.

**Setup cost** -- hardware and services you need to acquire

- **Telegram: Low** -- Nothing beyond the AWS infrastructure you're already deploying.
- **WhatsApp: High** -- Dedicated phone + SIM card, and the phone must remain powered and connected permanently (it's ongoing infrastructure, not a one-time purchase).
- **Signal: Medium** -- Dedicated phone + SIM card for registration only. After verification the phone can be put away -- signal-cli runs independently on the Gateway Server.

**Maintenance** -- ongoing effort to keep the channel working

- **Telegram: Low** -- Bot token is stored in Secrets Manager. Nothing to maintain.
- **WhatsApp: Medium** -- The dedicated phone must connect to the internet at least once every 14 days or WhatsApp unlinks the session. If it drops, you must re-scan the QR code via SSM.
- **Signal: Low** -- signal-cli manages its own keys on the Gateway Server. No phone keepalive required.

**Privacy** -- what third parties can see

- **Telegram: Low** -- No E2E encryption. Telegram's servers can read all messages between you and the bot.
- **WhatsApp: High** -- E2E encrypted (messages are unreadable to WhatsApp/Meta). However, Meta collects metadata: who you message, when, and how often.
- **Signal: Very High** -- E2E encrypted and minimal metadata collection. Signal's servers know almost nothing about your usage patterns.

**User familiarity** -- how likely your audience already knows the app

- **Telegram: Medium** -- Popular in tech and crypto communities, less common with the general public.
- **WhatsApp: High** -- ~2 billion users worldwide. Most people already have it installed and use it daily.
- **Signal: Low** -- Niche adoption, mostly among privacy-conscious users. Most people would need to install it for the first time.

**Survives redeploy** -- whether destroying and redeploying the Gateway Server preserves the channel session

- **Telegram: Yes** -- The bot token is stored in AWS Secrets Manager, not on the instance. A fresh Gateway Server can retrieve it immediately.
- **WhatsApp: No** -- The Baileys session credentials are stored locally on the Gateway Server. Redeployment requires re-scanning the QR code.
- **Signal: No** -- signal-cli keys are stored locally on the Gateway Server. Redeployment requires re-registering the phone number.

**Recommendation:** **Telegram** to get started quickly with no hardware. **WhatsApp** for E2E encryption with easy setup (requires a dedicated phone). **Signal** for maximum privacy with no ongoing device maintenance.

### Choosing a SIM card (WhatsApp and Signal)

Both WhatsApp and Signal require a dedicated phone number. You need a SIM card that can receive SMS for the initial activation (WhatsApp) or registration (Signal). After that, SMS is only needed if re-verification is triggered (e.g., reinstalling the app or switching devices).

**Option 1: Long-term SIM (recommended)**

A monthly plan or long-term prepaid SIM that auto-renews.

- Number stays yours indefinitely
- Re-verification always works
- Higher cost, may require identity verification depending on country

**Option 2: Prepaid / travel SIM (budget option)**

A cheap prepaid or travel SIM card. Must support SMS -- some data-only or traveler SIMs do not.

- Cheap, easy to get, often no identity verification needed
- Works fine initially -- both WhatsApp and Signal only need SMS once for activation/registration
- After activation, WhatsApp only needs internet (Wi-Fi is fine) and Signal doesn't need the phone at all
- **Risk: the number expires and eventually gets recycled by the carrier.** The timeline depends on the carrier -- some recycle after 30 days of inactivity, some after 90. Your agent keeps working during this window (WhatsApp/Signal don't know the SIM expired), but you're vulnerable to number recycling at any time
- **Mitigation:** some prepaid carriers let you extend the number with a small top-up before expiry

**What happens if the number gets recycled?**

If your number gets reassigned to someone else and they register WhatsApp or Signal on it:

- **Your agent goes offline.** The old session (Baileys for WhatsApp, signal-cli for Signal) gets invalidated by the platform's servers.
- **No one gains control of your agent.** The new owner gets a fresh account with no chat history, no linked devices, and no access to your Gateway Server. Linking to the Gateway requires SSM access to scan a QR code (WhatsApp) or run registration commands (Signal).
- **Recovery:** get a new SIM, activate with the new number, re-link or re-register on the Gateway Server, and update the allowlist.

Number recycling is an availability risk (agent goes offline), not a security risk (no one gains control). If your agent going offline and needing a number change is acceptable, a prepaid SIM is fine. If you need reliability, use a long-term SIM.

**If using Telegram**, create a bot now:

1. Open Telegram on your phone or desktop
2. Search for `@BotFather` (verified Telegram system account)
3. Send `/newbot`
4. Follow the prompts -- choose a display name and a username (must end in `bot`)
5. BotFather replies with your bot token (a string like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
6. Copy the token -- you'll add it to `.env` below

**If using WhatsApp**, prepare a dedicated phone now:

1. Get a dedicated phone and SIM card (see [Choosing a SIM card](#choosing-a-sim-card-whatsapp-and-signal) above for options). The SIM must support SMS -- you need it to activate WhatsApp.
2. Install WhatsApp on the phone and activate it with the dedicated number (requires receiving an SMS verification code).
3. Keep the phone powered and connected to Wi-Fi -- it must stay online permanently. After activation, WhatsApp only needs internet (not SMS), so Wi-Fi is sufficient for day-to-day use. However, retain the ability to receive SMS on the registered number in case WhatsApp ever requires re-verification (e.g., after reinstalling the app).
4. No `.env` changes needed -- WhatsApp has no pre-deploy token.

**If using Signal**, skip this step -- Signal setup happens post-deploy on the Gateway Server.

### Configure .env

Edit `.env` and configure:

```
# Required: unique name for this agent (lowercase alphanumeric + hyphens, starts with letter, max 20 chars)
AGENT_NAME=alice

# Required: availability zone to deploy in
CDK_AZ=us-east-1a

# LLM Provider (required)
LLM_PROVIDER=venice
LLM_API_KEY=sk-...

# RPC Provider (optional, for Starknet on-chain access)
RPC_PROVIDER=alchemy
RPC_API_KEY=abc123...

# Web search provider (required)
# Supported: brave, gemini, grok, kimi, perplexity
WEB_SEARCH_PROVIDER=brave
WEB_SEARCH_API_KEY=...

# Telegram bot token (optional, only if using Telegram)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
```

`AGENT_NAME` scopes all AWS resources (secrets, DNS, KMS tags, SSM document) so multiple agents can coexist in the same account and region. The region is derived automatically from the AZ (e.g., `us-east-1a` becomes `us-east-1`).

## Deploy

Bootstrap CDK (first time only, per account/region):

```bash
npx cdk bootstrap
```

Deploy the stack:

```bash
npx cdk deploy
```

CDK will show the resources to be created and ask for confirmation. After deployment, the stack outputs will display:

* **AgentServerInstanceId** -- Agent Server EC2 instance ID
* **GatewayServerInstanceId** -- Gateway Server EC2 instance ID
* **GatewayServerPrivateIp** -- Gateway Server private IP (agent connects via `ws://gateway.<AGENT_NAME>.vpc:18789`)

## Connect to instances

Use SSM Session Manager (no SSH keys needed):

```bash
# Connect to the Agent Server EC2
aws ssm start-session --target <AgentServerInstanceId> --document-name <AGENT_NAME>

# Connect to the Gateway Server EC2
aws ssm start-session --target <GatewayServerInstanceId> --document-name <AGENT_NAME>
```

## Tear down

**WARNING:** Destroying the stack will permanently delete the KMS wallet key. Any Starknet funds controlled by that key will be permanently inaccessible. Make sure you have transferred all funds before destroying the stack.

```bash
npx cdk destroy
```

## OpenClaw Setup

After deployment, see [OPENCLAW.md](OPENCLAW.md) for Gateway and Agent server configuration.
