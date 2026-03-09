# Deployment

## Purpose

The infrastructure SHALL be deployable and destroyable via CDK with .env-driven provider configuration.

## Requirements

### Requirement: Environment-Driven Configuration

Provider deployment SHALL be controlled by .env file entries.

#### Scenario: Selective provider deployment

- **GIVEN** the .env file contains API keys for N providers
- **WHEN** the stack is synthesized
- **THEN** exactly N Secrets Manager secrets SHALL be created
- **AND** exactly N per-provider DNS records SHALL be created
- **AND** the SSM proxy config SHALL contain exactly those N providers

#### Scenario: Empty provider key

- **GIVEN** a provider key is set to an empty string in .env
- **WHEN** the stack is synthesized
- **THEN** that provider SHALL NOT be deployed

### Requirement: CDK Stack Structure

The infrastructure SHALL be defined as a single CDK stack.

#### Scenario: Resource counts

- **WHEN** the stack is deployed
- **THEN** it SHALL create exactly 3 EC2 instances
- **AND** exactly 3 IAM roles
- **AND** exactly 3 security groups
- **AND** 0 CDK-managed KMS keys (agent creates them at runtime)
- **AND** 1 SSM parameter for proxy configuration

### Requirement: Tear-Down Safety

Destroying the stack SHALL permanently delete the KMS wallet key.

#### Scenario: KMS key removal policy

- **GIVEN** the KMS wallet key has removalPolicy: DESTROY
- **WHEN** the stack is destroyed
- **THEN** the wallet key SHALL be permanently deleted
- **AND** any Starknet funds controlled by that key SHALL become permanently inaccessible

### Requirement: Instance Type Validation

All EC2 instance types SHALL be x86_64 architecture.

#### Scenario: ARM rejection

- **WHEN** an ARM instance type (e.g., t4g, m7g) is specified
- **THEN** the stack SHALL throw an error with guidance to use x86_64 types

### Requirement: Monorepo Structure

The project SHALL use pnpm workspaces with two packages.

#### Scenario: Package layout

- **GIVEN** the project root
- **THEN** packages/cdk/ SHALL contain the CDK infrastructure package
- **AND** packages/proxy/ SHALL contain the LLM API proxy package (published to npm as openclaw-aws-proxy)

### Requirement: SSM Session Manager Access

All instances SHALL be accessible via SSM Session Manager instead of SSH.

#### Scenario: No open SSH ports

- **WHEN** the stack is deployed
- **THEN** no security group SHALL allow inbound traffic on port 22
- **AND** all IAM roles SHALL include AmazonSSMManagedInstanceCore
