# Deployment

## Purpose

The infrastructure SHALL be deployable and destroyable via CDK with .env-driven provider configuration.

## Requirements

### Requirement: Environment-Driven Configuration

Provider deployment SHALL be controlled by .env file entries. Region SHALL always be derived from the resolved availability zone.

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

#### Scenario: Explicit AZ in .env

- **GIVEN** `CDK_AVAILABILITY_ZONE` is set in .env (e.g., `us-east-1a`)
- **WHEN** the stack is synthesized
- **THEN** the stack SHALL use that AZ for all EC2 instances
- **AND** the stack region SHALL be derived by stripping the trailing letter (e.g., `us-east-1`)

#### Scenario: No AZ in .env, AWS profile region available

- **GIVEN** `CDK_AVAILABILITY_ZONE` is not set in .env
- **AND** `CDK_DEFAULT_REGION` is available from the AWS profile (e.g., `eu-west-1`)
- **WHEN** the stack is synthesized
- **THEN** the AZ SHALL default to `{CDK_DEFAULT_REGION}a` (e.g., `eu-west-1a`)
- **AND** the stack region SHALL be derived from that AZ using the same logic (strip trailing letter)

#### Scenario: No AZ in .env, no AWS profile region

- **GIVEN** `CDK_AVAILABILITY_ZONE` is not set in .env
- **AND** `CDK_DEFAULT_REGION` is not available
- **WHEN** the stack is synthesized
- **THEN** synthesis SHALL fail with an error indicating that either `CDK_AVAILABILITY_ZONE` must be set in .env or an AWS profile region must be configured

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

The project SHALL use pnpm workspaces with three packages.

#### Scenario: Package layout

- **GIVEN** the project root
- **THEN** packages/cdk/ SHALL contain the CDK infrastructure package
- **AND** packages/proxy/ SHALL contain the LLM API proxy package (published to npm as openclaw-aws-proxy)
- **AND** packages/integration/ SHALL contain the integration test package (named `integration`)

#### Scenario: Root-level test scripts

- **GIVEN** the project root package.json
- **THEN** `test` SHALL run unit tests only
- **AND** `test:all` SHALL run unit tests then integration CI sequentially
- **AND** `test:integration:deploy` SHALL deploy the test stack
- **AND** `test:integration:run` SHALL run integration tests against an existing stack
- **AND** `test:integration:destroy` SHALL destroy the test stack
- **AND** `test:integration:ci` SHALL run deploy, tests, then destroy as a CI composite

#### Scenario: Sequential test:all execution

- **WHEN** `pnpm run test:all` is executed
- **AND** unit tests fail
- **THEN** integration tests SHALL NOT run

### Requirement: Integration Test Lifecycle

The integration test suite SHALL separate infrastructure lifecycle from test execution.

#### Scenario: Deploy test stack

- **WHEN** `pnpm run test:deploy` is executed from the integration package
- **THEN** it SHALL deploy the OpenclawStack to the configured test region (us-east-2)
- **AND** it SHALL use `CDK_DEFAULT_REGION`, `CDK_AVAILABILITY_ZONE` environment variables for region targeting

#### Scenario: Run tests against existing stack

- **WHEN** `pnpm run test:run` is executed from the integration package
- **THEN** Jest SHALL discover the deployed stack's instances via CloudFormation and EC2 tags
- **AND** it SHALL wait for SSM agent readiness on all 3 instances
- **AND** it SHALL wait for cloud-init completion (`/var/lib/cloud/instance/boot-finished`) on all 3 instances
- **AND** it SHALL run the test suite via SSM commands against the live instances

#### Scenario: Destroy test stack

- **WHEN** `pnpm run test:destroy` is executed from the integration package
- **THEN** it SHALL destroy the OpenclawStack in the test region

#### Scenario: CI composite command

- **WHEN** `pnpm run test:ci` is executed
- **THEN** it SHALL run deploy, test, and destroy in sequence
- **AND** the stack SHALL be destroyed even if tests fail

### Requirement: Cloud-Init Readiness Gate

Tests SHALL NOT execute until all user data provisioning is complete on all instances.

#### Scenario: Waiting for cloud-init

- **GIVEN** all 3 instances have SSM agent online
- **WHEN** global setup checks readiness
- **THEN** it SHALL poll each instance for `/var/lib/cloud/instance/boot-finished` via SSM
- **AND** it SHALL proceed only when all 3 instances report the file exists

#### Scenario: Cloud-init timeout

- **GIVEN** cloud-init has not completed within the timeout period
- **WHEN** the timeout is exceeded
- **THEN** global setup SHALL throw an error listing which instances are not ready

### Requirement: Base Instance Software

All EC2 instances (Agent, Proxy, Gateway) SHALL have AWS CLI v2 installed via shared base user data.

#### Scenario: AWS CLI availability

- **WHEN** any instance completes boot
- **THEN** `aws --version` SHALL return AWS CLI v2.x
- **AND** the CLI SHALL be installed from the official AWS installer (not the apt package)

### Requirement: SSM Session Manager Access

All instances SHALL be accessible via SSM Session Manager instead of SSH.

#### Scenario: No open SSH ports

- **WHEN** the stack is deployed
- **THEN** no security group SHALL allow inbound traffic on port 22
- **AND** all IAM roles SHALL include AmazonSSMManagedInstanceCore
