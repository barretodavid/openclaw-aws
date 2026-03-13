# Gateway Server

## Purpose

The Gateway SHALL provide Signal and Telegram channel integrations for the OpenClaw agent, accepting WebSocket connections on port 18789.

## Requirements

### Requirement: Channel Integration Support

The Gateway SHALL be provisioned with tools for messaging channel integrations and OpenClaw.

#### Scenario: Signal support

- **WHEN** the Gateway instance boots
- **THEN** it SHALL install signal-cli (native binary, no JRE) into `/usr/local/bin` as a single executable file
- **AND** it SHALL install Node.js 22 and unattended-upgrades
- **AND** OpenClaw SHALL be installed globally via npm as the ubuntu user (`sudo -u ubuntu npm install -g openclaw`)

#### Scenario: Telegram support

- **GIVEN** the Gateway instance
- **THEN** Telegram SHALL require no additional binary dependencies beyond Node.js and OpenClaw
- **AND** Telegram channel configuration SHALL be performed post-deployment via the OpenClaw CLI

#### Scenario: No unnecessary software

- **GIVEN** the Gateway instance
- **THEN** it SHALL NOT install Docker or the proxy application

### Requirement: WebSocket Endpoint

The Gateway SHALL accept authenticated WebSocket connections from the Agent on all network interfaces.

#### Scenario: Agent connectivity

- **GIVEN** the Agent connects via ws://gateway.vpc:18789
- **WHEN** the connection is established
- **THEN** the Gateway SHALL accept the connection on port 18789
- **AND** OPENCLAW_ALLOW_INSECURE_PRIVATE_WS SHALL be set to allow plain ws://
- **AND** the Gateway SHALL bind to all interfaces (LAN mode) so it is reachable from other EC2 instances
- **AND** the Gateway SHALL require token authentication for all connections

### Requirement: Isolation

The Gateway SHALL have no access to wallet signing. When Telegram is configured, the Gateway SHALL have scoped Secrets Manager read access for its bot token only.

#### Scenario: Minimal permissions

- **GIVEN** the Gateway IAM role
- **WHEN** evaluated
- **THEN** it SHALL have zero inline policy actions beyond SSM Session Manager and any conditional Secrets Manager access for the Telegram token
- **AND** it SHALL NOT have KMS permissions

#### Scenario: Telegram token access

- **GIVEN** the Gateway IAM role
- **WHEN** `TELEGRAM_BOT_TOKEN` is set in `.env`
- **THEN** it SHALL have Secrets Manager read access scoped to the `openclaw/telegram-token` secret only

#### Scenario: No Telegram token access when unconfigured

- **GIVEN** the Gateway IAM role
- **WHEN** `TELEGRAM_BOT_TOKEN` is not set in `.env`
- **THEN** it SHALL NOT have any Secrets Manager permissions

### Requirement: Default Instance Sizing

The Gateway instance SHALL default to t3a.small (2 GB RAM) to support npm package installation during cloud-init and concurrent operation of OpenClaw gateway and signal-cli.

#### Scenario: Default instance type

- **WHEN** no custom `gatewayServerInstanceType` is specified
- **THEN** the Gateway instance SHALL use t3a.small
