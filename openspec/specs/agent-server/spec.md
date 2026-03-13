# Agent Server

## Purpose

The Agent server SHALL run the OpenClaw agent with Docker support and hardware-backed wallet signing via KMS.

## Requirements

### Requirement: Instance Configuration

The Agent EC2 instance SHALL be provisioned with Docker, Node.js, AWS CLI, and OpenClaw.

#### Scenario: Software provisioning

- **WHEN** the Agent instance boots
- **THEN** it SHALL install Docker, Node.js 22, unzip, AWS CLI v2, and unattended-upgrades via user data
- **AND** AWS CLI v2 and unzip SHALL be provisioned by the shared base user data (not agent-specific config)
- **AND** Docker SHALL be enabled and started via systemd
- **AND** the ubuntu user SHALL be added to the docker group
- **AND** OpenClaw SHALL be installed globally via npm as the ubuntu user (`sudo -u ubuntu npm install -g openclaw`)

#### Scenario: Instance type validation

- **WHEN** an ARM instance type (e.g., t4g, m7g) is specified for the Agent
- **THEN** the stack SHALL throw an error requiring an x86_64 type

#### Scenario: EBS volume configuration

- **GIVEN** the Agent instance
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

### Requirement: Internal Connectivity

The Agent Server SHALL connect to the Gateway Server via WebSocket and reach LLM/RPC providers directly via HTTPS.

#### Scenario: Gateway Server connection

- **WHEN** the Agent connects to the Gateway Server
- **THEN** it SHALL use `ws://gateway.${agentName}.vpc:18789`
- **AND** the OPENCLAW_ALLOW_INSECURE_PRIVATE_WS environment variable SHALL be set

#### Scenario: LLM and RPC API access

- **WHEN** the Agent makes an LLM or RPC API request
- **THEN** it SHALL connect directly to the provider via HTTPS
- **AND** it SHALL retrieve API keys from Secrets Manager (`${agentName}/llm-api-key`, `${agentName}/rpc-api-key`)
