# Networking

## Purpose

The infrastructure SHALL use security groups and the default VPC to provide network access without exposing services to the internet.

## Requirements

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
- **THEN** the instance SHALL use the server IAM role

#### Scenario: Security group binding integrity

- **WHEN** the stack is deployed
- **THEN** the instance SHALL have exactly one security group
