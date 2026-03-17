# Security Boundaries

## Purpose

The infrastructure SHALL enforce security boundaries through IAM roles and security groups so that the server has minimal permissions for its function.

## Requirements

### Requirement: IAM Role Isolation

The EC2 instance SHALL have a single IAM role with permissions for KMS wallet management, Secrets Manager access, and SSM Session Manager.

#### Scenario: Server role permissions

- **GIVEN** the EC2 instance
- **WHEN** its IAM role is evaluated
- **THEN** it SHALL have KMS permissions (CreateKey, Sign, GetPublicKey, DescribeKey) restricted to keys tagged `${agentName}:wallet`
- **AND** it SHALL have tag:GetResources for key discovery
- **AND** it SHALL have Secrets Manager read access scoped to the `${agentName}/llm-api-key` and `${agentName}/web-search-api-key` secrets
- **AND** when `RPC_API_KEY` is set in `.env`, it SHALL also have Secrets Manager read access to the `${agentName}/rpc-api-key` secret
- **AND** when `TELEGRAM_BOT_TOKEN` is set in `.env`, it SHALL also have Secrets Manager read access to the `${agentName}/telegram-token` secret
- **AND** it SHALL have SSM Session Manager access

### Requirement: No Public Inbound Traffic

No server SHALL accept traffic from the public internet.

#### Scenario: Security group ingress rules

- **WHEN** any security group's ingress rules are evaluated
- **THEN** no rule SHALL reference 0.0.0.0/0 or ::/0

### Requirement: IMDSv2 Enforcement

All EC2 instances SHALL require IMDSv2 to prevent SSRF-based credential theft.

#### Scenario: Metadata service protection

- **GIVEN** the EC2 instance in the stack
- **WHEN** its launch configuration is evaluated
- **THEN** HttpTokens SHALL be set to "required"

### Requirement: KMS Key Constraints

The Agent SHALL only create wallet keys with specific cryptographic parameters.

#### Scenario: Key creation constraints

- **WHEN** the Agent creates a KMS key
- **THEN** the key MUST use ECC_NIST_P256 key spec
- **AND** the key MUST use SIGN_VERIFY key usage
- **AND** the key MUST be tagged with `${agentName}:wallet` (tag key is the agent name, tag value is `wallet`)
- **AND** the private key SHALL never leave the HSM

### Requirement: Network Segmentation

The server SHALL have a dedicated security group restricting its network access.

#### Scenario: Server network access

- **GIVEN** the server security group
- **THEN** it SHALL allow outbound HTTPS (443) and HTTP (80) to the internet
- **AND** it SHALL have no inbound rules from the internet
