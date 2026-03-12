# Deployment

## Purpose

The infrastructure SHALL be deployable and destroyable via CDK with .env-driven configuration.

## Requirements

### Requirement: Brave Search API Key

The Brave Search API key SHALL be stored in Secrets Manager and accessible only to the Agent Server.

#### Scenario: Required API key in .env

- **GIVEN** `BRAVE_API_KEY` is not set or empty in `.env`
- **WHEN** CDK synth is executed
- **THEN** it SHALL fail with an error indicating that `BRAVE_API_KEY` is required

#### Scenario: Secret creation

- **GIVEN** `BRAVE_API_KEY` is set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `openclaw/brave-api-key` SHALL be created
- **AND** only the Agent Server IAM role SHALL have read access to this secret
- **AND** the Gateway Server role SHALL NOT have access to this secret

#### Scenario: .env.example entry

- **GIVEN** the `.env.example` file
- **THEN** it SHALL include a `BRAVE_API_KEY` entry

### Requirement: LLM API Key Required

An LLM API key SHALL be set in `.env` for CDK synth to succeed.

#### Scenario: No LLM API key set

- **GIVEN** `LLM_API_KEY` is not set or empty in `.env`
- **WHEN** CDK synth is executed
- **THEN** it SHALL fail with an error indicating that `LLM_API_KEY` is required

#### Scenario: LLM API key set

- **GIVEN** `LLM_API_KEY` is set in `.env`
- **WHEN** CDK synth is executed
- **THEN** the LLM API key validation SHALL pass
- **AND** a Secrets Manager secret named `openclaw/llm-api-key` SHALL be created
- **AND** only the Agent Server IAM role SHALL have read access to this secret

### Requirement: RPC API Key

An RPC API key MAY be set in `.env` for blockchain RPC access.

#### Scenario: RPC API key set

- **GIVEN** `RPC_API_KEY` is set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `openclaw/rpc-api-key` SHALL be created
- **AND** only the Agent Server IAM role SHALL have read access to this secret

### Requirement: Environment-Driven Configuration

Deployment SHALL be controlled by .env file entries. Region SHALL always be derived from the resolved availability zone. Production and test deployments SHALL use separate, explicitly configured availability zones.

#### Scenario: .env configuration keys

- **GIVEN** the `.env` file
- **THEN** it SHALL use `LLM_PROVIDER` and `LLM_API_KEY` for the LLM provider configuration
- **AND** it SHALL use `RPC_PROVIDER` and `RPC_API_KEY` for the RPC provider configuration
- **AND** it SHALL use `BRAVE_API_KEY` for the Brave Search API key

#### Scenario: CDK availability zone input

- **GIVEN** `CDK_AZ` is set in the process environment
- **WHEN** the stack is synthesized
- **THEN** the stack SHALL use that AZ for all EC2 instances
- **AND** the stack region SHALL be derived by stripping the trailing letter (e.g., `us-east-1a` becomes `us-east-1`)

#### Scenario: Missing CDK availability zone

- **GIVEN** `CDK_AZ` is not set in the process environment
- **WHEN** the stack is synthesized
- **THEN** synthesis SHALL fail with an error indicating that `CDK_AZ` must be set

#### Scenario: Explicit test AZ in .env

- **GIVEN** `CDK_AZ_TEST` is set in .env (e.g., `us-east-2a`)
- **WHEN** integration test config is loaded
- **THEN** the test region SHALL be derived by stripping the trailing letter (e.g., `us-east-2`)

#### Scenario: Missing test AZ

- **GIVEN** `CDK_AZ_TEST` is not set in .env
- **WHEN** integration test config is loaded
- **THEN** loading SHALL fail with an error indicating that `CDK_AZ_TEST` must be set in .env

#### Scenario: Test and prod AZs in the same region

- **GIVEN** `CDK_AZ_PROD` and `CDK_AZ_TEST` are set to AZs in the same region (e.g., `us-east-1a` and `us-east-1b`)
- **WHEN** integration test config is loaded
- **THEN** loading SHALL fail with an error indicating that prod and test AZs must be in different regions to avoid resource collisions

### Requirement: CDK Stack Structure

The infrastructure SHALL be defined as a single CDK stack.

#### Scenario: Resource counts

- **WHEN** the stack is deployed
- **THEN** it SHALL create exactly 2 EC2 instances
- **AND** exactly 2 IAM roles
- **AND** exactly 2 security groups
- **AND** 0 CDK-managed KMS keys (agent creates them at runtime)

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
- **THEN** packages/cdk/ SHALL contain the CDK infrastructure package (named `cdk`)
- **AND** packages/integration/ SHALL contain the integration test package (named `integration`)
- **AND** packages/shared/ SHALL contain internal AWS utilities (private, not published)

#### Scenario: Root-level deploy and destroy scripts

- **GIVEN** the project root package.json
- **THEN** `deploy:prod` SHALL deploy the prod stack and wait for cloud-init
- **AND** `deploy:test` SHALL deploy the test stack and wait for cloud-init
- **AND** `destroy:prod` SHALL destroy the prod stack
- **AND** `destroy:test` SHALL destroy the test stack
- **AND** there SHALL be no shortcut aliases for `deploy` or `destroy` without an explicit environment suffix

#### Scenario: Root-level login scripts

- **GIVEN** the project root package.json
- **THEN** `login:agent` SHALL start an interactive SSM session to the Agent Server in the prod environment
- **AND** `login:gateway` SHALL start an interactive SSM session to the Gateway Server in the prod environment
- **AND** `login:agent:prod`, `login:gateway:prod` SHALL be explicit aliases for the prod variants
- **AND** `login:agent:test`, `login:gateway:test` SHALL start sessions to the respective servers in the test environment

#### Scenario: Root-level test scripts

- **GIVEN** the project root package.json
- **THEN** `test` SHALL run unit tests only
- **AND** `test:unit` SHALL run unit tests across all workspaces that define a `test:unit` script (using `pnpm -r run test:unit`)
- **AND** `test:all` SHALL run unit tests then CI sequentially
- **AND** `test:integration` SHALL run integration tests against an existing test stack
- **AND** `ci` SHALL deploy the test stack, run integration tests, then destroy the test stack (destroying even if tests fail)

### Requirement: Deploy Commands With Cloud-Init Wait

All deploy commands SHALL wait for cloud-init completion on all 2 EC2 instances before returning, and SHALL print instance IDs with SSM connect instructions.

#### Scenario: Deploy prod stack

- **WHEN** `pnpm run deploy:prod` is executed
- **THEN** it SHALL deploy the CDK stack using the AZ from `CDK_AZ_PROD` in `.env`
- **AND** it SHALL wait for SSM agent readiness on all 2 instances
- **AND** it SHALL wait for cloud-init completion on all 2 instances
- **AND** it SHALL print instance IDs with `aws ssm start-session` commands

#### Scenario: Deploy test stack

- **WHEN** `pnpm run deploy:test` is executed
- **THEN** it SHALL deploy the CDK stack using the AZ from `CDK_AZ_TEST` in `.env`
- **AND** it SHALL wait for SSM agent readiness on all 2 instances
- **AND** it SHALL wait for cloud-init completion on all 2 instances
- **AND** it SHALL print instance IDs with `aws ssm start-session` commands

### Requirement: Destroy Commands

Destroy commands SHALL use explicit `:prod` and `:test` variants with no shortcut aliases.

#### Scenario: Destroy prod stack

- **WHEN** `pnpm run destroy:prod` is executed
- **THEN** it SHALL destroy the CDK stack in the region derived from `CDK_AZ_PROD`

#### Scenario: Destroy test stack

- **WHEN** `pnpm run destroy:test` is executed
- **THEN** it SHALL destroy the CDK stack in the region derived from `CDK_AZ_TEST`

### Requirement: Shared AWS Utilities Package

The project SHALL include a `packages/shared/` internal workspace package providing reusable AWS client creation, SSM command execution, instance discovery, and cloud-init readiness polling.

#### Scenario: Package structure

- **GIVEN** the project root
- **THEN** `packages/shared/` SHALL be a private pnpm workspace package
- **AND** it SHALL NOT be published to npm
- **AND** it SHALL export AWS client creation, SSM command execution, instance discovery, SSM readiness polling, and cloud-init readiness polling functions

#### Scenario: Client creation

- **GIVEN** a region string
- **WHEN** client creation is invoked
- **THEN** it SHALL return pre-configured CloudFormation, EC2, and SSM clients
- **AND** it SHALL use `fromIni()` credential provider
- **AND** consumers SHALL NOT need to import AWS SDK packages directly

#### Scenario: Instance discovery

- **GIVEN** a deployed CDK stack
- **WHEN** instance discovery is invoked with the stack name
- **THEN** it SHALL identify all 2 instances (Agent, Gateway) by their IAM role profile
- **AND** it SHALL return instance IDs and private IPs

#### Scenario: Cloud-init readiness polling

- **GIVEN** SSM agent is online on all instances
- **WHEN** cloud-init readiness polling is invoked
- **THEN** it SHALL poll each instance for `/var/lib/cloud/instance/boot-finished` via SSM
- **AND** it SHALL timeout with an error listing unready instances if the wait exceeds the timeout period

### Requirement: Integration Test Lifecycle

The integration test suite SHALL separate infrastructure lifecycle from test execution, using root-level deploy and destroy commands.

#### Scenario: Run tests against existing stack

- **WHEN** `pnpm run test:integration` is executed
- **THEN** Jest SHALL discover the deployed stack's instances via CloudFormation and EC2 tags
- **AND** it SHALL wait for SSM agent readiness on all 2 instances (using shared utilities)
- **AND** it SHALL wait for cloud-init completion on all 2 instances (using shared utilities)
- **AND** it SHALL run the test suite via SSM commands against the live instances

#### Scenario: CI composite command

- **WHEN** `pnpm run ci` is executed
- **THEN** it SHALL run `deploy:test`, then integration tests, then `destroy:test` in sequence
- **AND** the stack SHALL be destroyed even if tests fail

### Requirement: Cloud-Init Readiness Gate

Tests SHALL NOT execute until all user data provisioning is complete on all instances.

#### Scenario: Waiting for cloud-init

- **GIVEN** all 2 instances have SSM agent online
- **WHEN** global setup checks readiness
- **THEN** it SHALL poll each instance for `/var/lib/cloud/instance/boot-finished` via SSM (using shared utilities)
- **AND** it SHALL proceed only when all 2 instances report the file exists

#### Scenario: Cloud-init timeout

- **GIVEN** cloud-init has not completed within the timeout period
- **WHEN** the timeout is exceeded
- **THEN** global setup SHALL throw an error listing which instances are not ready

### Requirement: Base Instance Software

All EC2 instances (Agent, Gateway) SHALL have AWS CLI v2 installed via shared base user data.

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

### Requirement: Default Instance Sizing

Each EC2 instance SHALL have a default instance type sized for its workload.

#### Scenario: Instance type defaults

- **WHEN** the stack is deployed with default props
- **THEN** the Agent instance SHALL default to t3a.large (8 GB RAM)
- **AND** the Gateway instance SHALL default to t3a.small (2 GB RAM)

#### Scenario: Custom instance type override

- **WHEN** a custom instance type is specified via stack props
- **THEN** the specified type SHALL be used instead of the default

### Requirement: Software Provisioning Verification

The integration test suite SHALL verify that each EC2 instance has its expected software installed and on `$PATH` after cloud-init completes. System binaries (node, docker, aws) SHALL be checked as root. Non-system binaries installed via npm globals or manual extraction (openclaw, signal-cli) SHALL be checked as the ubuntu user.

#### Scenario: Agent Server provisioning

- **WHEN** the Agent Server has completed cloud-init
- **THEN** `which node` SHALL exit 0
- **AND** `which docker` SHALL exit 0
- **AND** `which aws` SHALL exit 0
- **AND** `which openclaw` SHALL exit 0 (as the ubuntu user)

#### Scenario: Gateway Server provisioning

- **WHEN** the Gateway Server has completed cloud-init
- **THEN** `which node` SHALL exit 0
- **AND** `which aws` SHALL exit 0
- **AND** `which signal-cli` SHALL exit 0 (as the ubuntu user)
- **AND** `which openclaw` SHALL exit 0 (as the ubuntu user)

### Requirement: Login Commands

The project SHALL provide login commands that start interactive SSM sessions to deployed EC2 instances without requiring the user to know instance IDs.

#### Scenario: Login to agent server (prod)

- **WHEN** `pnpm run login:agent` is executed
- **THEN** it SHALL resolve the region from `CDK_AZ_PROD` in `.env`
- **AND** it SHALL discover the Agent Server instance ID using `discoverInstances` from the shared package
- **AND** it SHALL start an interactive SSM session with `--document-name ubuntu`

#### Scenario: Login to gateway server (prod)

- **WHEN** `pnpm run login:gateway:prod` is executed
- **THEN** it SHALL resolve the region from `CDK_AZ_PROD` in `.env`
- **AND** it SHALL discover the Gateway Server instance ID using `discoverInstances` from the shared package
- **AND** it SHALL start an interactive SSM session with `--document-name ubuntu`

#### Scenario: Invalid server name

- **WHEN** `login.ts` is invoked with an unrecognized server name
- **THEN** it SHALL exit with an error listing valid server names (agent, gateway)

#### Scenario: Stack not deployed

- **WHEN** `login.ts` is invoked and the target stack does not exist
- **THEN** it SHALL exit with an error indicating the stack was not found

### Requirement: Post-Deployment Setup Documentation

The root README.md SHALL include an "OpenClaw Setup" section at the end documenting the CLI-only steps to configure and start OpenClaw after deployment. The section SHALL use Venice.ai as the concrete LLM provider. Both the Gateway Server and Agent Server use the `openclaw onboard` wizard.

#### Scenario: Gateway Server login

- **WHEN** a user begins Gateway Server setup
- **THEN** the documentation SHALL instruct logging in with `pnpm run login:gateway`

#### Scenario: Gateway Server Signal registration

- **WHEN** a user configures Signal on the Gateway Server
- **THEN** it SHALL document obtaining a captcha token from a laptop browser
- **AND** it SHALL document registering a dedicated phone number with `signal-cli -u <PHONE_NUMBER> register --captcha "<CAPTCHA_TOKEN>"`
- **AND** it SHALL document verifying the registration with `signal-cli -u <PHONE_NUMBER> verify <SMS_CODE>`

#### Scenario: Gateway Server onboard via wizard

- **WHEN** a user configures the Gateway Server
- **THEN** the documentation SHALL instruct running `openclaw onboard --non-interactive --accept-risk --flow quickstart --gateway-bind lan --skip-daemon` on the Gateway Server
- **AND** it SHALL instruct adding the Signal channel with `openclaw channels add --channel signal --account <PHONE_NUMBER>`
- **AND** it SHALL instruct configuring the DM policy to allowlist with `openclaw config set channels.signal.dmPolicy allowlist`
- **AND** it SHALL instruct adding the owner's phone number to the allowlist with `openclaw config set channels.signal.allowFrom '["<OWNER_PHONE_NUMBER>"]'`
- **AND** it SHALL instruct setting session isolation with `openclaw config set session.dmScope per-channel-peer`

#### Scenario: Gateway Server token export

- **WHEN** a user has completed Gateway Server onboard
- **THEN** it SHALL instruct reading the auto-generated token with `openclaw config get gateway.auth.token`
- **AND** it SHALL instruct storing the token in Secrets Manager with `aws secretsmanager put-secret-value --secret-id openclaw/gateway-token --secret-string "<GATEWAY_TOKEN>"`

#### Scenario: Gateway Server service management

- **WHEN** a user starts the gateway service
- **THEN** it SHALL document installing and starting the gateway service with `openclaw gateway install` and `openclaw gateway start`
- **AND** it SHALL document enabling the gateway service on boot with `systemctl --user enable openclaw-gateway.service`

#### Scenario: Agent Server login

- **WHEN** a user begins Agent Server setup
- **THEN** the documentation SHALL instruct logging in with `pnpm run login:agent`

#### Scenario: Agent Server setup via wizard

- **WHEN** a user configures OpenClaw on the Agent Server
- **THEN** the documentation SHALL instruct running `openclaw onboard` with appropriate flags for remote mode connecting to `ws://gateway.vpc:18789`, using the LLM provider API key from Secrets Manager

#### Scenario: Agent Server gateway token configuration

- **WHEN** a user configures the gateway token on the Agent Server
- **THEN** it SHALL document running `openclaw secrets configure` to set up an exec SecretRef provider named `gateway-token` with source `exec`, command `/usr/local/bin/aws`, args `secretsmanager get-secret-value --secret-id openclaw/gateway-token --query SecretString --output text`, passEnv `HOME`, jsonOnly `false`
- **AND** it SHALL instruct mapping `gateway.remote.token` to provider `gateway-token` with ID `value`

#### Scenario: Agent Server model configuration

- **WHEN** a user configures models on the Agent Server
- **THEN** it SHALL instruct setting the image model with `openclaw models set-image venice/kimi-k2-5`
- **AND** it SHALL instruct setting the fallback model with `openclaw config set agents.defaults.model.fallbacks '["venice/minimax-m25"]'`

#### Scenario: Agent Server Brave Search configuration

- **WHEN** a user configures Brave Search on the Agent Server
- **THEN** it SHALL document running `openclaw secrets configure` to set up the exec SecretRef provider
- **AND** it SHALL provide step-by-step wizard guidance: provider name `brave`, source `exec`, command `/usr/local/bin/aws`, args `secretsmanager get-secret-value --secret-id openclaw/brave-api-key --query SecretString --output text`, passEnv `HOME`, jsonOnly `false`
- **AND** it SHALL instruct mapping `tools.web.search.apiKey` to provider `brave` with ID `value`

#### Scenario: Agent Server start

- **WHEN** a user starts the agent
- **THEN** it SHALL document starting the agent with `openclaw agent`

#### Scenario: Variable placeholders

- **WHEN** a command contains user-specific values
- **THEN** the documentation SHALL use angle bracket placeholders (e.g. `<PHONE_NUMBER>`, `<OWNER_PHONE_NUMBER>`, `<CAPTCHA_TOKEN>`, `<SMS_CODE>`, `<GATEWAY_TOKEN>`)
- **AND** it SHALL define each placeholder with a brief description
- **AND** it SHALL NOT use placeholders for LLM provider, model, or API key values (these SHALL use concrete Venice values)

### Requirement: Gateway Token Secret

The CDK stack SHALL create a Secrets Manager secret for the gateway authentication token, readable only by the Agent Server.

#### Scenario: Secret creation

- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `openclaw/gateway-token` SHALL be created with a placeholder value
- **AND** the secret description SHALL indicate it is for gateway authentication and is populated post-deploy

#### Scenario: Agent Server access

- **WHEN** the Agent Server IAM role is evaluated
- **THEN** it SHALL have read access to the `openclaw/gateway-token` secret

#### Scenario: Gateway Server access

- **WHEN** the Gateway Server IAM role is evaluated
- **THEN** it SHALL NOT have access to the `openclaw/gateway-token` secret
