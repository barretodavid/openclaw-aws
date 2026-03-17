# Deployment

## Purpose

The infrastructure SHALL be deployable and destroyable via CDK with .env-driven configuration.

## Requirements

### Requirement: Agent Name Configuration

All deployments SHALL be scoped by a required `AGENT_NAME` environment variable that uniquely identifies the agent within the AWS region.

#### Scenario: AGENT_NAME in .env

- **GIVEN** the `.env` file
- **THEN** it SHALL include an `AGENT_NAME` entry
- **AND** it SHALL be documented as required for all deploys

#### Scenario: AGENT_NAME validation at synth time

- **WHEN** the CDK stack is synthesized
- **THEN** `AGENT_NAME` SHALL be validated: lowercase alphanumeric and hyphens only, must start with a letter, max 20 characters
- **AND** synth SHALL fail with a descriptive error if validation fails

#### Scenario: Missing AGENT_NAME

- **WHEN** `AGENT_NAME` is not set in the process environment
- **THEN** CDK synth SHALL fail with an error indicating that `AGENT_NAME` must be set

#### Scenario: Stack ID derived from agent name

- **WHEN** the stack is synthesized
- **THEN** the CloudFormation stack name SHALL be `${agentName}`

### Requirement: Web Search API Key

The web search API key SHALL be stored in Secrets Manager and accessible only to the Gateway Server. The provider SHALL be configurable via `WEB_SEARCH_PROVIDER` in `.env`.

#### Scenario: Secret creation

- **GIVEN** `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_API_KEY` are set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `${agentName}/web-search-api-key` SHALL be created
- **AND** only the Gateway Server IAM role SHALL have read access to this secret
- **AND** the Agent Server role SHALL NOT have access to this secret

#### Scenario: Required provider and API key in .env

- **WHEN** `WEB_SEARCH_PROVIDER` is not set or empty in `.env`
- **THEN** CDK synth SHALL fail with an error indicating that `WEB_SEARCH_PROVIDER` is required and listing the supported providers (brave, gemini, grok, kimi, perplexity)

#### Scenario: Unknown provider

- **WHEN** `WEB_SEARCH_PROVIDER` is set to an unrecognized value
- **THEN** CDK synth SHALL fail with an error indicating the provider is unknown and listing the supported providers

#### Scenario: Missing API key

- **WHEN** `WEB_SEARCH_PROVIDER` is set but `WEB_SEARCH_API_KEY` is not set or empty
- **THEN** CDK synth SHALL fail with an error indicating that `WEB_SEARCH_API_KEY` is required when `WEB_SEARCH_PROVIDER` is set

### Requirement: LLM API Key Required

An LLM API key SHALL be set in `.env` for CDK synth to succeed.

#### Scenario: LLM API key set

- **GIVEN** `LLM_API_KEY` is set in `.env`
- **WHEN** CDK synth is executed
- **THEN** the LLM API key validation SHALL pass
- **AND** a Secrets Manager secret named `${agentName}/llm-api-key` SHALL be created
- **AND** only the Gateway Server IAM role SHALL have read access to this secret

#### Scenario: No LLM API key set

- **GIVEN** `LLM_API_KEY` is not set or empty in `.env`
- **WHEN** CDK synth is executed
- **THEN** it SHALL fail with an error indicating that `LLM_API_KEY` is required

### Requirement: RPC API Key

An RPC API key MAY be set in `.env` for blockchain RPC access.

#### Scenario: RPC API key set

- **GIVEN** `RPC_API_KEY` is set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `${agentName}/rpc-api-key` SHALL be created
- **AND** only the Gateway Server IAM role SHALL have read access to this secret

### Requirement: Telegram Bot Token Secret

The CDK stack SHALL optionally create a Secrets Manager secret for the Telegram bot token when `TELEGRAM_BOT_TOKEN` is set in `.env`, readable only by the Gateway Server.

#### Scenario: Secret creation when token is set

- **GIVEN** `TELEGRAM_BOT_TOKEN` is set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `${agentName}/telegram-token` SHALL be created with the token value
- **AND** only the Gateway Server IAM role SHALL have read access to this secret
- **AND** the Agent Server role SHALL NOT have access to this secret

#### Scenario: No secret when token is not set

- **GIVEN** `TELEGRAM_BOT_TOKEN` is not set in `.env`
- **WHEN** the stack is deployed
- **THEN** no `${agentName}/telegram-token` secret SHALL be created
- **AND** the Gateway Server IAM role SHALL NOT have any Secrets Manager permissions

#### Scenario: .env.example entry

- **GIVEN** the `.env.example` file
- **THEN** it SHALL include a `TELEGRAM_BOT_TOKEN` entry with a comment indicating it is optional and only needed for Telegram channel support

### Requirement: Environment-Driven Configuration

Deployment SHALL be controlled by .env file entries. Region SHALL always be derived from the resolved availability zone.

#### Scenario: .env configuration keys

- **GIVEN** the `.env` file
- **THEN** it SHALL use `AGENT_NAME` for scoping all AWS resources
- **AND** it SHALL use `CDK_AZ` for the availability zone (region derived by stripping trailing letter)
- **AND** it SHALL use `LLM_PROVIDER` and `LLM_API_KEY` for the LLM provider configuration
- **AND** it SHALL use `RPC_PROVIDER` and `RPC_API_KEY` for the RPC provider configuration
- **AND** it SHALL use `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_API_KEY` for the web search provider configuration
- **AND** it SHALL use `TELEGRAM_BOT_TOKEN` for the optional Telegram bot token

#### Scenario: CDK availability zone input

- **GIVEN** `CDK_AZ` is set in the process environment
- **WHEN** the stack is synthesized
- **THEN** the stack SHALL use that AZ for all EC2 instances
- **AND** the stack region SHALL be derived by stripping the trailing letter (e.g., `us-east-1a` becomes `us-east-1`)

#### Scenario: Missing CDK availability zone

- **GIVEN** `CDK_AZ` is not set in the process environment
- **WHEN** the stack is synthesized
- **THEN** synthesis SHALL fail with an error indicating that `CDK_AZ` must be set

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
- **THEN** `deploy` SHALL be the canonical deploy script, deploying the stack using `AGENT_NAME` and `CDK_AZ` from `.env` and waiting for cloud-init
- **AND** `destroy` SHALL be the canonical destroy script, destroying the stack using `AGENT_NAME` and `CDK_AZ` from `.env`

#### Scenario: Root-level integration scripts

- **GIVEN** the project root package.json
- **THEN** `integration:deploy` SHALL deploy a stack with hardcoded `AGENT_NAME=test`, reading `CDK_AZ` from `.env`
- **AND** `integration:destroy` SHALL destroy the stack with hardcoded `AGENT_NAME=test`, reading `CDK_AZ` from `.env`
- **AND** `integration:run` SHALL run integration tests against the persistent test stack with hardcoded `AGENT_NAME=test`
- **AND** `integration:login:agent` SHALL start an interactive SSM session to the Agent Server of the test stack with hardcoded `AGENT_NAME=test`
- **AND** `integration:login:gateway` SHALL start an interactive SSM session to the Gateway Server of the test stack with hardcoded `AGENT_NAME=test`

#### Scenario: Root-level login scripts

- **GIVEN** the project root package.json
- **THEN** `login:agent` SHALL start an interactive SSM session to the Agent Server using `AGENT_NAME` and `CDK_AZ` from `.env`
- **AND** `login:gateway` SHALL start an interactive SSM session to the Gateway Server using `AGENT_NAME` and `CDK_AZ` from `.env`

#### Scenario: Root-level test scripts

- **GIVEN** the project root package.json
- **THEN** `test` SHALL run unit tests across all workspaces that define a `test:unit` script (using `pnpm -r run test:unit`)
- **AND** `test:all` SHALL run unit tests then CI sequentially
- **AND** `ci` SHALL deploy a stack with an ephemeral agent name, run integration tests, then destroy the stack (destroying even if tests fail)

### Requirement: Deploy Commands With Cloud-Init Wait

All deploy commands SHALL wait for cloud-init completion on all 2 EC2 instances before returning, and SHALL print instance IDs with SSM connect instructions.

#### Scenario: Deploy stack

- **WHEN** `pnpm run deploy` is executed
- **THEN** it SHALL deploy the CDK stack using `AGENT_NAME` and `CDK_AZ` from `.env`
- **AND** it SHALL wait for SSM agent readiness on all 2 instances
- **AND** it SHALL wait for cloud-init completion on all 2 instances
- **AND** it SHALL print instance IDs with `aws ssm start-session` commands

### Requirement: Destroy Commands

Destroy commands SHALL clean up KMS wallet keys and the CDK stack.

#### Scenario: Destroy stack

- **WHEN** `pnpm run destroy` is executed
- **THEN** it SHALL clean up KMS keys tagged `${agentName}:wallet` in the region
- **AND** it SHALL destroy the CDK stack named `${agentName}` in the region derived from `CDK_AZ`

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
- **THEN** Jest SHALL discover the deployed stack's instances via CloudFormation using the stack name derived from `AGENT_NAME`
- **AND** it SHALL wait for SSM agent readiness on all 2 instances (using shared utilities)
- **AND** it SHALL wait for cloud-init completion on all 2 instances (using shared utilities)
- **AND** it SHALL run the test suite via SSM commands against the live instances

#### Scenario: CI composite command

- **WHEN** `pnpm run ci` is executed
- **THEN** it SHALL generate an ephemeral `AGENT_NAME` (e.g., `ci-${timestamp}`)
- **AND** it SHALL deploy, run integration tests, then destroy in sequence
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

#### Scenario: Login to agent server

- **WHEN** `pnpm run login:agent` is executed
- **THEN** it SHALL resolve the region from `CDK_AZ` in `.env`
- **AND** it SHALL discover the Agent Server instance ID using `discoverInstances` with stack name `${agentName}`
- **AND** it SHALL start an interactive SSM session with `--document-name ${agentName}`

#### Scenario: Login to gateway server

- **WHEN** `pnpm run login:gateway` is executed
- **THEN** it SHALL resolve the region from `CDK_AZ` in `.env`
- **AND** it SHALL discover the Gateway Server instance ID using `discoverInstances` with stack name `${agentName}`
- **AND** it SHALL start an interactive SSM session with `--document-name ${agentName}`

#### Scenario: Invalid server name

- **WHEN** `login.ts` is invoked with an unrecognized server name
- **THEN** it SHALL exit with an error listing valid server names (agent, gateway)

#### Scenario: Stack not deployed

- **WHEN** `login.ts` is invoked and the target stack does not exist
- **THEN** it SHALL exit with an error indicating the stack was not found

### Requirement: Post-Deployment Setup Documentation

The project SHALL include an OPENCLAW.md file at the root documenting the CLI-only steps to configure and start OpenClaw after deployment. The root README.md SHALL link to OPENCLAW.md instead of inlining the setup steps. Secret IDs in all commands SHALL use `${agentName}/` prefix. Gateway WebSocket URL SHALL use `gateway.${agentName}.vpc`. OPENCLAW.md SHALL document two access modes: single user (allowlist) and multi user (open).

#### Scenario: README.md links to OPENCLAW.md

- **WHEN** a user reads the root README.md
- **THEN** the "OpenClaw Setup" section SHALL contain only a link to OPENCLAW.md for post-deployment configuration
- **AND** it SHALL NOT inline any `openclaw` CLI commands

#### Scenario: Pre-deploy channel choice remains in README.md

- **WHEN** a user reads the pre-deploy prerequisites in README.md
- **THEN** the documentation SHALL still include the channel comparison table (Telegram / WhatsApp / Signal) with ratings for setup difficulty, setup cost, maintenance, privacy, user familiarity, and survives redeploy
- **AND** it SHALL still include pre-deploy channel preparation steps (BotFather for Telegram, dedicated phone for WhatsApp, skip for Signal)
- **AND** the SIM card guidance section SHALL remain in README.md

#### Scenario: OPENCLAW.md Gateway Server login and onboard

- **WHEN** a user reads OPENCLAW.md
- **THEN** it SHALL instruct logging in with `pnpm run login:gateway`
- **AND** it SHALL instruct running `openclaw onboard` with quickstart flow, LAN bind, Venice auth, and the desired model on the Gateway Server

#### Scenario: OPENCLAW.md channel setup (Telegram)

- **WHEN** a user configures Telegram in OPENCLAW.md
- **THEN** it SHALL document configuring an exec SecretRef provider fetching from `${agentName}/telegram-token`
- **AND** it SHALL instruct adding the channel with `openclaw channels add --channel telegram`
- **AND** it SHALL NOT include `dmPolicy` or `allowFrom` configuration (access control is a separate section)

#### Scenario: OPENCLAW.md channel setup (WhatsApp)

- **WHEN** a user configures WhatsApp in OPENCLAW.md
- **THEN** it SHALL document running `openclaw channels login --channel whatsapp --verbose` to display the QR code
- **AND** it SHALL instruct adding the channel with `openclaw channels add --channel whatsapp`
- **AND** it SHALL include the "Why a dedicated phone number?" explanation
- **AND** it SHALL NOT include `dmPolicy` or `allowFrom` configuration

#### Scenario: OPENCLAW.md channel setup (Signal)

- **WHEN** a user configures Signal in OPENCLAW.md
- **THEN** it SHALL document the captcha, registration, and verification steps
- **AND** it SHALL instruct adding the channel with `openclaw channels add --channel signal --account <PHONE_NUMBER>`
- **AND** it SHALL NOT include `dmPolicy` or `allowFrom` configuration

#### Scenario: OPENCLAW.md access mode -- single user

- **WHEN** a user configures single user access in OPENCLAW.md
- **THEN** it SHALL instruct setting `dmPolicy` to `allowlist` for the configured channel
- **AND** it SHALL instruct setting `allowFrom` to a JSON array with the single sender ID
- **AND** it SHALL instruct setting `session.dmScope` to `per-channel-peer`
- **AND** it SHALL explain how to find the sender ID (e.g., @userinfobot for Telegram, phone number for WhatsApp/Signal)

#### Scenario: OPENCLAW.md access mode -- multi user open

- **WHEN** a user configures multi user open access in OPENCLAW.md
- **THEN** it SHALL instruct setting `dmPolicy` to `open` for the configured channel
- **AND** it SHALL instruct setting `allowFrom` to `["*"]`
- **AND** it SHALL instruct setting `session.dmScope` to `per-channel-peer`
- **AND** it SHALL note that this mode is intended for demos and presentations
- **AND** it SHALL warn that anyone who can reach the bot can interact with it
- **AND** it SHALL recommend not configuring wallet or crypto operations in this mode

#### Scenario: OPENCLAW.md Gateway Server secrets configuration

- **WHEN** a user configures secrets on the Gateway Server in OPENCLAW.md
- **THEN** it SHALL document configuring LLM API key, web search API key, and optionally RPC API key using exec SecretRef providers fetching from Secrets Manager
- **AND** it SHALL provide one fully expanded example showing the complete wizard flow (provider setup, credential mapping, apply)
- **AND** the remaining secrets SHALL use a condensed format (table or summary) showing: provider name, AWS CLI args, and credential path
- **AND** each secret SHALL specify the exec command as `/usr/local/bin/aws` with `passEnv: HOME`

#### Scenario: OPENCLAW.md Gateway Server model configuration

- **WHEN** a user configures models on the Gateway Server in OPENCLAW.md
- **THEN** it SHALL instruct setting the image model and fallback model on the Gateway Server

#### Scenario: OPENCLAW.md gateway token and service

- **WHEN** a user completes Gateway Server channel and secrets setup in OPENCLAW.md
- **THEN** it SHALL instruct storing the gateway token in Secrets Manager with `aws secretsmanager put-secret-value --secret-id ${agentName}/gateway-token --secret-string "<GATEWAY_TOKEN>"`
- **AND** it SHALL document installing, starting, and enabling the gateway service

#### Scenario: OPENCLAW.md Agent Server setup

- **WHEN** a user reads the Agent Server section in OPENCLAW.md
- **THEN** it SHALL instruct logging in with `pnpm run login:agent`
- **AND** it SHALL instruct running `openclaw onboard` with remote mode connecting to `ws://gateway.${agentName}.vpc:18789` (without auth-choice or model flags, which are ignored in remote mode)
- **AND** it SHALL instruct configuring the gateway token secret using an exec SecretRef provider fetching from `${agentName}/gateway-token`
- **AND** it SHALL instruct installing and running the OpenClaw node to maintain the WebSocket connection to the Gateway

#### Scenario: OPENCLAW.md variable placeholders

- **WHEN** a command in OPENCLAW.md contains user-specific values
- **THEN** it SHALL use angle bracket placeholders (e.g. `<PHONE_NUMBER>`, `<OWNER_PHONE_NUMBER>`, `<CAPTCHA_TOKEN>`, `<SMS_CODE>`, `<GATEWAY_TOKEN>`, `<TELEGRAM_USER_ID>`)
- **AND** it SHALL define each placeholder with a brief description
- **AND** it SHALL NOT use placeholders for LLM provider, model, or API key values (these SHALL use concrete Venice values)
- **AND** it SHALL NOT use placeholders for web search provider values (these SHALL use concrete Brave values)

### Requirement: Gateway Token Secret

The CDK stack SHALL create a Secrets Manager secret for the gateway authentication token, readable only by the Agent Server.

#### Scenario: Secret creation

- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `${agentName}/gateway-token` SHALL be created with a placeholder value
- **AND** the secret description SHALL indicate it is for gateway authentication and is populated post-deploy

#### Scenario: Agent Server access

- **WHEN** the Agent Server IAM role is evaluated
- **THEN** it SHALL have read access to the `${agentName}/gateway-token` secret

#### Scenario: Gateway Server access

- **WHEN** the Gateway Server IAM role is evaluated
- **THEN** it SHALL NOT have access to the `${agentName}/gateway-token` secret

### Requirement: CDK README Accurately Describes Current Architecture

The `packages/cdk/README.md` SHALL document only the components that exist in the current CDK stack. It MUST NOT reference the proxy server, proxy-related security groups, subdomain-based routing, SSM proxy config parameters, or per-provider DNS records.

#### Scenario: Components table matches deployed infrastructure
- **WHEN** an operator reads the components table in `packages/cdk/README.md`
- **THEN** it SHALL list only: Agent Server, Gateway Server, Remote Access (SSM), Wallet Key (KMS), API Key Secrets (Secrets Manager), and Private DNS (Route 53)
- **AND** the API Key Secrets description SHALL note that the Gateway Server can also read the Telegram token secret when configured

#### Scenario: Security boundaries reflect conditional gateway access
- **WHEN** an operator reads the security boundaries section
- **THEN** it SHALL describe the Gateway Server IAM role as having SSM access plus conditional Secrets Manager read access for the Telegram token (when `TELEGRAM_BOT_TOKEN` is set in `.env`)

### Requirement: Secret Rotation Documentation

The `packages/cdk/README.md` SHALL include a "Rotate an API key" section that lists all secret names, documents the rotation command, and warns about the CDK overwrite behavior.

#### Scenario: All secret names are listed
- **WHEN** an operator reads the rotation section
- **THEN** it SHALL list `${agentName}/llm-api-key`, `${agentName}/rpc-api-key`, `${agentName}/web-search-api-key`, `${agentName}/gateway-token`, and `${agentName}/telegram-token`

#### Scenario: No-restart behavior is documented
- **WHEN** an operator reads the rotation section
- **THEN** it SHALL state that the agent picks up rotated secrets immediately with no restart required (because OpenClaw fetches from Secrets Manager on every use via the exec provider)

#### Scenario: CDK overwrite warning is present
- **WHEN** an operator reads the rotation section
- **THEN** it SHALL warn that `.env` must also be updated, otherwise the next `cdk deploy` will revert the secret to the old value

### Requirement: Architecture Diagram

The root README.md Mermaid architecture diagram SHALL accurately reflect which servers read from Secrets Manager.

#### Scenario: Gateway Server Secrets Manager access in diagram

- **WHEN** a user reads the architecture diagram
- **THEN** it SHALL show the Gateway Server reading the Telegram token from Secrets Manager
- **AND** it SHALL show the Agent Server reading API keys from Secrets Manager
- **AND** the Secrets Manager node label SHALL include the Telegram token in its list of secrets
