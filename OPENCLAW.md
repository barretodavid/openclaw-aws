# OpenClaw Configuration

Post-deployment steps to configure and start OpenClaw on the server.

## Login

```bash
pnpm run login
```

## Onboard

```bash
openclaw onboard --non-interactive --accept-risk \
  --flow quickstart \
  --auth-choice venice \
  --model "venice/zai-org-glm-5" \
  --skip-daemon
```

## Configure models

```bash
openclaw models set-image venice/kimi-k2-5
openclaw config set agents.defaults.model.fallbacks '["venice/minimax-m25"]'
```

## Configure secrets

All secrets follow the same `openclaw secrets configure` pattern: create an exec provider that fetches from Secrets Manager, then map it to a credential path.

**LLM API key** (full walkthrough):

Run `openclaw secrets configure` and follow the prompts:

1. **Provider setup** -- add a new provider:
   - Name: `llm`
   - Source: `exec`
   - Command: `/usr/local/bin/aws`
   - Args: `secretsmanager get-secret-value --secret-id <AGENT_NAME>/llm-api-key --query SecretString --output text`
   - passEnv: `HOME`
   - jsonOnly: `false`

2. **Credential mapping** -- select "Continue" from the provider menu, then:
   - Select `models.providers.venice.apiKey` from the credential list
   - Source: `exec`
   - Provider: `llm`
   - Secret ID: `value`

3. **Apply** the plan

**Remaining secrets** -- repeat the same `openclaw secrets configure` flow with these values:

| Secret | Provider name | Secret ID in args | Credential path |
|---|---|---|---|
| Web search API key | `web` | `<AGENT_NAME>/web-search-api-key` | `tools.web.search.apiKey` |

All providers use the same exec command (`/usr/local/bin/aws secretsmanager get-secret-value --secret-id <SECRET_ID> --query SecretString --output text`) with `passEnv: HOME` and `jsonOnly: false`.

> All secrets are stored in AWS Secrets Manager and fetched at runtime via the instance IAM role. They never touch disk.

## Configure your messaging channel

Choose **one** channel below based on your [pre-deploy choice](README.md#choose-a-messaging-channel).

### Option A: Telegram

Configure the Telegram bot token by running `openclaw secrets configure` and following the prompts:

1. **Provider setup** -- add a new provider:
   - Name: `telegram`
   - Source: `exec`
   - Command: `/usr/local/bin/aws`
   - Args: `secretsmanager get-secret-value --secret-id <AGENT_NAME>/telegram-token --query SecretString --output text`
   - passEnv: `HOME`
   - jsonOnly: `false`

2. **Credential mapping** -- select "Continue" from the provider menu, then:
   - Select `channels.telegram.botToken` from the credential list
   - Source: `exec`
   - Provider: `telegram`
   - Secret ID: `value`

3. **Apply** the plan

Add the channel:

```bash
openclaw channels add --channel telegram
```

### Option B: WhatsApp (E2E encrypted, easy setup)

Link WhatsApp by scanning a QR code:

```bash
openclaw channels login --channel whatsapp --verbose
```

A QR code renders as ASCII in the terminal. Scan it with WhatsApp on the dedicated phone (WhatsApp > Linked Devices > Link a Device).

Add the channel:

```bash
openclaw channels add --channel whatsapp
```

> **Why a dedicated phone number?** WhatsApp uses a "linked device" model. The server connects as a companion device with full protocol-level read/write access to the WhatsApp account. OpenClaw's `dmPolicy` restricts this at the application level, but the protection is software-based, not protocol-based. Using a dedicated phone number means that even if the policy is misconfigured or bypassed, the agent can only reach contacts of the dedicated number (which should have none), not your personal contacts.

### Option C: Signal (maximum privacy)

Signal requires a **dedicated phone number** -- you cannot reuse your personal Signal number.

Open this [link](https://signalcaptchas.org/registration/generate.html) in your browser to resolve Signal's CAPTCHA, copy the token and register:

```bash
signal-cli -u <PHONE_NUMBER> register --captcha "<CAPTCHA_TOKEN>"
signal-cli -u <PHONE_NUMBER> verify <SMS_CODE>
```

Add the channel:

```bash
openclaw channels add --channel signal --account <PHONE_NUMBER>
```

## Configure access control

Choose **one** access mode. Replace `<CHANNEL>` with `telegram`, `whatsapp`, or `signal` to match the channel you configured above.

### Single user

Restrict the bot to a single sender. Use this for personal agents.

Find your sender ID:

- **Telegram**: search for `@userinfobot` in Telegram -- it replies with your numeric user ID (e.g., `123456789`)
- **WhatsApp**: your phone number in E.164 format (e.g., `+33612345678`)
- **Signal**: your phone number in E.164 format (e.g., `+33612345678`)

```bash
openclaw config set channels.<CHANNEL>.dmPolicy allowlist
openclaw config set channels.<CHANNEL>.allowFrom '["<SENDER_ID>"]'
openclaw config set session.dmScope per-channel-peer
```

### Multi user (open)

Allow anyone to message the bot. **Intended for demos and presentations only.**

> **Warning:** Anyone who can reach the bot can interact with it. Do not configure wallet or crypto operations in this mode.

```bash
openclaw config set channels.<CHANNEL>.dmPolicy open
openclaw config set channels.<CHANNEL>.allowFrom '["*"]'
openclaw config set session.dmScope per-channel-peer
```

Each person gets their own conversation session via `per-channel-peer` scoping.

## Start the gateway service

```bash
openclaw gateway install
openclaw gateway start
systemctl --user enable openclaw-gateway.service
```

## Placeholders

| Placeholder | Description |
|---|---|
| `<AGENT_NAME>` | Unique name for this agent (from `.env`, e.g. `alice`) |
| `<CHANNEL>` | Messaging channel: `telegram`, `whatsapp`, or `signal` |
| `<SENDER_ID>` | Your sender identifier -- Telegram numeric user ID or phone number in E.164 format |
| `<PHONE_NUMBER>` | Dedicated bot phone number in E.164 format, e.g. `+33612345678` (Signal only) |
| `<CAPTCHA_TOKEN>` | Token from the Signal captcha page (Signal only) |
| `<SMS_CODE>` | Verification code received via SMS (Signal only) |
