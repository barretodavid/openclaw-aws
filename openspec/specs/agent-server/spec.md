# Agent Server

## Purpose

The Agent server SHALL run the OpenClaw gateway with Docker support, all channel integrations, and hardware-backed wallet signing via KMS.

## Requirements

### Requirement: Instance Configuration

The EC2 instance SHALL be provisioned with Docker, Node.js, signal-cli, AWS CLI, and OpenClaw to run the OpenClaw gateway with all channel integrations and Docker sandboxing support.

#### Scenario: Software provisioning

- **WHEN** the instance boots
- **THEN** it SHALL install Docker, Node.js 24, unzip, AWS CLI v2, and unattended-upgrades via user data
- **AND** AWS CLI v2 and unzip SHALL be provisioned by the shared base user data
- **AND** Docker SHALL be enabled and started via systemd
- **AND** the ubuntu user SHALL be added to the docker group
- **AND** signal-cli (native binary, no JRE) SHALL be installed into `/usr/local/bin`
- **AND** OpenClaw SHALL be installed globally via npm as the ubuntu user (`sudo -u ubuntu npm install -g openclaw`)
- **AND** systemd user linger SHALL be enabled for the ubuntu user

#### Scenario: Instance type validation

- **WHEN** an ARM instance type (e.g., t4g, m7g) is specified
- **THEN** the stack SHALL throw an error requiring an x86_64 type

#### Scenario: EBS volume configuration

- **GIVEN** the instance
- **WHEN** its block device mapping is evaluated
- **THEN** the root volume SHALL be 30 GB gp3
- **AND** the root device SHALL be /dev/sda1

### Requirement: KMS Wallet Operations

The Agent SHALL create and use KMS-backed wallet keys for Starknet transaction signing.

#### Scenario: Wallet key creation

- **WHEN** the Agent creates a wallet key
- **THEN** it SHALL use KMS CreateKey with ECC_NIST_P256 and SIGN_VERIFY
- **AND** the key SHALL be tagged with `${agentName}:wallet` (tag key is the agent name, tag value is `wallet`)

#### Scenario: Wallet key discovery

- **WHEN** the Agent needs to find existing wallet keys
- **THEN** it SHALL use the Resource Groups Tagging API (tag:GetResources) filtering by tag key `${agentName}` with value `wallet`

### Requirement: Agent Logic Execution

The server SHALL run the OpenClaw gateway in local mode, executing agent logic including LLM API calls, web search, tool dispatch, and channel management.

#### Scenario: LLM API access

- **WHEN** the server processes an incoming message
- **THEN** it SHALL call the configured LLM provider using the API key from Secrets Manager (`${agentName}/llm-api-key`)

#### Scenario: Web search access

- **WHEN** the agent invokes web search
- **THEN** it SHALL use the web search API key from Secrets Manager (`${agentName}/web-search-api-key`)

#### Scenario: RPC API access

- **WHEN** `RPC_API_KEY` is set and the agent needs on-chain data
- **THEN** it SHALL use the RPC API key from Secrets Manager (`${agentName}/rpc-api-key`)

### Requirement: Channel Integration Support

The server SHALL be provisioned with tools for all messaging channel integrations.

#### Scenario: Signal support

- **WHEN** the instance boots
- **THEN** signal-cli SHALL be available at `/usr/local/bin/signal-cli`

#### Scenario: Telegram support

- **GIVEN** the instance
- **THEN** Telegram SHALL require no additional binary dependencies beyond Node.js and OpenClaw

#### Scenario: WhatsApp support

- **GIVEN** the instance
- **THEN** WhatsApp SHALL require no additional binary dependencies beyond Node.js and OpenClaw
- **AND** WhatsApp session credentials SHALL be stored locally at `~/.openclaw/credentials/whatsapp/`
