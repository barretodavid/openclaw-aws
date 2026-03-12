# Security Boundaries

## Purpose

The infrastructure SHALL enforce security boundaries through IAM role separation so that compromise of any single server cannot escalate to full system compromise.

## Requirements

### Requirement: IAM Role Isolation

Each EC2 instance SHALL have a dedicated IAM role with minimal permissions for its function.

#### Scenario: Agent role permissions

- **GIVEN** the Agent EC2 instance
- **WHEN** its IAM role is evaluated
- **THEN** it SHALL have KMS permissions (CreateKey, Sign, GetPublicKey, DescribeKey) restricted to wallet-tagged keys
- **AND** it SHALL have tag:GetResources for key discovery
- **AND** it SHALL have Secrets Manager read access scoped to the `openclaw/web-api-key`, `openclaw/gateway-token`, `openclaw/llm-api-key`, and `openclaw/rpc-api-key` secrets only
- **AND** it SHALL have SSM Session Manager access

#### Scenario: Gateway role permissions

- **GIVEN** the Gateway EC2 instance
- **WHEN** its IAM role is evaluated
- **THEN** it SHALL have only SSM Session Manager access
- **AND** it SHALL NOT have KMS or Secrets Manager permissions

### Requirement: No Public Inbound Traffic

No server SHALL accept traffic from the public internet.

#### Scenario: Security group ingress rules

- **WHEN** any security group's ingress rules are evaluated
- **THEN** no rule SHALL reference 0.0.0.0/0 or ::/0

### Requirement: IMDSv2 Enforcement

All EC2 instances SHALL require IMDSv2 to prevent SSRF-based credential theft.

#### Scenario: Metadata service protection

- **GIVEN** any EC2 instance in the stack
- **WHEN** its launch configuration is evaluated
- **THEN** HttpTokens SHALL be set to "required"

### Requirement: KMS Key Constraints

The Agent SHALL only create wallet keys with specific cryptographic parameters.

#### Scenario: Key creation constraints

- **WHEN** the Agent creates a KMS key
- **THEN** the key MUST use ECC_NIST_P256 key spec
- **AND** the key MUST use SIGN_VERIFY key usage
- **AND** the key MUST be tagged with openclaw:wallet
- **AND** the private key SHALL never leave the HSM

### Requirement: Network Segmentation

Each server SHALL have a dedicated security group restricting its network access.

#### Scenario: Agent network access

- **GIVEN** the Agent security group
- **THEN** it SHALL allow outbound HTTPS (443) and HTTP (80) to the internet
- **AND** it SHALL allow outbound to the Gateway on port 18789
- **AND** it SHALL have no inbound rules from the internet

#### Scenario: Gateway network access

- **GIVEN** the Gateway security group
- **THEN** it SHALL allow inbound from the Agent security group on port 18789 only
- **AND** it SHALL allow outbound HTTPS (443) and HTTP (80) to the internet
