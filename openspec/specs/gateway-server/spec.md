# Gateway Server

## Purpose

The Gateway SHALL provide Signal, Telegram, and WhatsApp channel integrations for the OpenClaw agent, accepting WebSocket connections on port 18789.

## Requirements

### Requirement: Channel Integration Support

The Gateway SHALL be provisioned with tools for messaging channel integrations and OpenClaw.

#### Scenario: Signal support

- **WHEN** the Gateway instance boots
- **THEN** it SHALL install signal-cli (native binary, no JRE) into `/usr/local/bin` as a single executable file
- **AND** it SHALL install Node.js 24 and unattended-upgrades
- **AND** OpenClaw SHALL be installed globally via npm as the ubuntu user (`sudo -u ubuntu npm install -g openclaw`)

#### Scenario: Telegram support

- **GIVEN** the Gateway instance
- **THEN** Telegram SHALL require no additional binary dependencies beyond Node.js and OpenClaw
- **AND** Telegram channel configuration SHALL be performed post-deployment via the OpenClaw CLI

#### Scenario: WhatsApp support

- **GIVEN** the Gateway instance
- **THEN** WhatsApp SHALL require no additional binary dependencies beyond Node.js and OpenClaw
- **AND** WhatsApp channel configuration SHALL be performed post-deployment via the OpenClaw CLI
- **AND** WhatsApp session credentials (Baileys auth) SHALL be stored locally on the Gateway Server at `~/.openclaw/credentials/whatsapp/`
- **AND** WhatsApp session credentials SHALL NOT survive instance replacement (redeployment requires re-scanning the QR code)

#### Scenario: No unnecessary software

- **GIVEN** the Gateway instance
- **THEN** it SHALL NOT install Docker or the proxy application

### Requirement: WebSocket Endpoint

The Gateway SHALL accept authenticated WebSocket connections from the Agent on all network interfaces.

#### Scenario: Agent connectivity

- **GIVEN** the Agent connects via `ws://gateway.${agentName}.vpc:18789`
- **WHEN** the connection is established
- **THEN** the Gateway SHALL accept the connection on port 18789
- **AND** OPENCLAW_ALLOW_INSECURE_PRIVATE_WS SHALL be set to allow plain ws://
- **AND** the Gateway SHALL bind to all interfaces (LAN mode) so it is reachable from other EC2 instances
- **AND** the Gateway SHALL require token authentication for all connections

### Requirement: Isolation

The Gateway SHALL have no access to wallet signing. The Gateway SHALL have Secrets Manager read access for LLM, web search, and optionally RPC and Telegram secrets to run agent logic and manage channels.

#### Scenario: Agent logic permissions

- **GIVEN** the Gateway IAM role
- **WHEN** evaluated
- **THEN** it SHALL have Secrets Manager read access to the `${agentName}/llm-api-key` and `${agentName}/web-search-api-key` secrets
- **AND** it SHALL NOT have KMS permissions

#### Scenario: RPC access when configured

- **GIVEN** the Gateway IAM role
- **WHEN** `RPC_API_KEY` is set in `.env`
- **THEN** it SHALL have Secrets Manager read access to the `${agentName}/rpc-api-key` secret

#### Scenario: Telegram token access

- **GIVEN** the Gateway IAM role
- **WHEN** `TELEGRAM_BOT_TOKEN` is set in `.env`
- **THEN** it SHALL have Secrets Manager read access scoped to the `${agentName}/telegram-token` secret

#### Scenario: No Telegram token access when unconfigured

- **GIVEN** the Gateway IAM role
- **WHEN** `TELEGRAM_BOT_TOKEN` is not set in `.env`
- **THEN** it SHALL NOT have Secrets Manager access to the `${agentName}/telegram-token` secret

#### Scenario: WhatsApp requires no Secrets Manager access

- **GIVEN** the Gateway IAM role
- **WHEN** WhatsApp is configured as a channel
- **THEN** no additional Secrets Manager permissions SHALL be required beyond those already granted for agent logic (LLM, web search)

### Requirement: Agent Logic Execution

The Gateway SHALL run OpenClaw agent logic, including LLM API calls, web search, and tool dispatch. It retrieves API credentials from Secrets Manager at runtime.

#### Scenario: LLM API access

- **WHEN** the Gateway processes an incoming message
- **THEN** it SHALL call the configured LLM provider using the API key from Secrets Manager (`${agentName}/llm-api-key`)

#### Scenario: Web search access

- **WHEN** the Gateway agent invokes web search
- **THEN** it SHALL use the web search API key from Secrets Manager (`${agentName}/web-search-api-key`)

#### Scenario: RPC API access

- **WHEN** `RPC_API_KEY` is set and the Gateway agent needs on-chain data
- **THEN** it SHALL use the RPC API key from Secrets Manager (`${agentName}/rpc-api-key`)

### Requirement: Default Instance Sizing

The Gateway instance SHALL default to t3a.small (2 GB RAM) to support npm package installation during cloud-init and concurrent operation of OpenClaw gateway and signal-cli.

#### Scenario: Default instance type

- **WHEN** no custom `gatewayServerInstanceType` is specified
- **THEN** the Gateway instance SHALL use t3a.small
