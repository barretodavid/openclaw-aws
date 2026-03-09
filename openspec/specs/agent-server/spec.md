# Agent Server

## Purpose

The Agent server SHALL run the OpenClaw agent with Docker support and hardware-backed wallet signing via KMS.

## Requirements

### Requirement: Instance Configuration

The Agent EC2 instance SHALL be provisioned with Docker, Node.js, and AWS CLI.

#### Scenario: Software provisioning

- **WHEN** the Agent instance boots
- **THEN** it SHALL install Docker, Node.js 22, unzip, AWS CLI v2, and unattended-upgrades via user data
- **AND** AWS CLI v2 and unzip SHALL be provisioned by the shared base user data (not agent-specific config)
- **AND** Docker SHALL be enabled and started via systemd
- **AND** the ubuntu user SHALL be added to the docker group

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
- **AND** the key SHALL be tagged with openclaw:wallet

#### Scenario: Wallet key discovery

- **WHEN** the Agent needs to find existing wallet keys
- **THEN** it SHALL use the Resource Groups Tagging API (tag:GetResources)

### Requirement: Internal Connectivity

The Agent SHALL connect to the Gateway via WebSocket and to the Proxy via HTTP.

#### Scenario: Gateway connection

- **WHEN** the Agent connects to the Gateway
- **THEN** it SHALL use ws://gateway.vpc:18789
- **AND** the OPENCLAW_ALLOW_INSECURE_PRIVATE_WS environment variable SHALL be set

#### Scenario: Proxy connection

- **WHEN** the Agent makes an LLM API request
- **THEN** it SHALL route through http://<provider>.proxy.vpc:8080
