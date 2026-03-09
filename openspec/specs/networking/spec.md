# Networking

## Purpose

The infrastructure SHALL use Route 53 private DNS and security groups to provide internal service discovery without exposing services to the internet.

## Requirements

### Requirement: Private DNS Zone

A Route 53 private hosted zone SHALL provide internal DNS for service discovery.

#### Scenario: Zone configuration

- **WHEN** the stack is deployed
- **THEN** a private hosted zone with name "vpc" SHALL be created
- **AND** it SHALL be associated with the default VPC

### Requirement: Service DNS Records

DNS A records SHALL map service names to instance private IPs.

#### Scenario: Base service records

- **WHEN** the stack is deployed
- **THEN** proxy.vpc SHALL resolve to the Proxy instance private IP
- **AND** gateway.vpc SHALL resolve to the Gateway instance private IP
- **AND** no DNS record SHALL point to the Agent instance

#### Scenario: Per-provider subdomain records

- **GIVEN** a provider with an API key set in .env
- **WHEN** the stack is deployed
- **THEN** <subdomain>.proxy.vpc SHALL resolve to the Proxy instance private IP
- **AND** DNS records SHALL exist only for configured providers

### Requirement: Default VPC Usage

The infrastructure SHALL use the default VPC without custom networking.

#### Scenario: No custom VPC or NAT

- **WHEN** the stack is deployed
- **THEN** it SHALL use the default VPC and public subnets
- **AND** security comes from IAM/KMS boundaries, not network isolation

### Requirement: Cross-Resource Consistency

Instance-to-role and instance-to-security-group bindings SHALL be correct.

#### Scenario: Role binding integrity

- **WHEN** the stack is deployed
- **THEN** the Agent instance SHALL use the Agent IAM role
- **AND** the Proxy instance SHALL use the Proxy IAM role
- **AND** the Gateway instance SHALL use the Gateway IAM role

#### Scenario: Security group binding integrity

- **WHEN** the stack is deployed
- **THEN** each instance SHALL have exactly one security group
- **AND** each instance SHALL use its dedicated security group
