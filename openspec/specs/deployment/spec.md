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

The web search API key SHALL be stored in Secrets Manager and accessible only to the Agent Server. The provider SHALL be configurable via `WEB_SEARCH_PROVIDER` in `.env`.

#### Scenario: Required provider and API key in .env

- **WHEN** `WEB_SEARCH_PROVIDER` is not set or empty in `.env`
- **THEN** CDK synth SHALL fail with an error indicating that `WEB_SEARCH_PROVIDER` is required and listing the supported providers (brave, gemini, grok, kimi, perplexity)

#### Scenario: Unknown provider

- **WHEN** `WEB_SEARCH_PROVIDER` is set to an unrecognized value
- **THEN** CDK synth SHALL fail with an error indicating the provider is unknown and listing the supported providers

#### Scenario: Missing API key

- **WHEN** `WEB_SEARCH_PROVIDER` is set but `WEB_SEARCH_API_KEY` is not set or empty
- **THEN** CDK synth SHALL fail with an error indicating that `WEB_SEARCH_API_KEY` is required when `WEB_SEARCH_PROVIDER` is set

#### Scenario: Secret creation

- **GIVEN** `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_API_KEY` are set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `${agentName}/web-search-api-key` SHALL be created
- **AND** only the Agent Server IAM role SHALL have read access to this secret
- **AND** the Gateway Server role SHALL NOT have access to this secret

#### Scenario: .env.example entry

- **GIVEN** the `.env.example` file
- **THEN** it SHALL include a `WEB_SEARCH_PROVIDER` entry with a comment listing supported providers (brave, gemini, grok, kimi, perplexity)
- **AND** it SHALL include a `WEB_SEARCH_API_KEY` entry

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
- **AND** a Secrets Manager secret named `${agentName}/llm-api-key` SHALL be created
- **AND** only the Agent Server IAM role SHALL have read access to this secret

### Requirement: RPC API Key

An RPC API key MAY be set in `.env` for blockchain RPC access.

#### Scenario: RPC API key set

- **GIVEN** `RPC_API_KEY` is set in `.env`
- **WHEN** the stack is deployed
- **THEN** a Secrets Manager secret named `${agentName}/rpc-api-key` SHALL be created
- **AND** only the Agent Server IAM role SHALL have read access to this secret

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

The root README.md SHALL include an "OpenClaw Setup" section documenting the CLI-only steps to configure and start OpenClaw after deployment. Secret IDs in all commands SHALL use `${agentName}/` prefix instead of `openclaw/`. Gateway WebSocket URL SHALL use `gateway.${agentName}.vpc`.

#### Scenario: Pre-deploy channel choice

- **WHEN** a user reads the pre-deploy prerequisites
- **THEN** the documentation SHALL include a channel comparison table (Telegram / WhatsApp / Signal) with Low/Medium/High ratings for: setup difficulty, setup cost, maintenance, privacy, user familiarity, and survives redeploy
- **AND** the table SHALL be followed by per-cell justifications explaining each rating
- **AND** it SHALL include a recommendation: Telegram for quick start with no hardware, WhatsApp for E2E encryption with easy setup, Signal for maximum privacy with no ongoing device maintenance
- **AND** it SHALL instruct Telegram users to create a bot via BotFather and add the token to `.env` as `TELEGRAM_BOT_TOKEN`
- **AND** it SHALL note that WhatsApp and Signal users can skip `.env` changes (their setup is post-deploy)

#### Scenario: SIM card guidance

- **WHEN** a user reads the pre-deploy prerequisites for WhatsApp or Signal
- **THEN** the documentation SHALL include a shared "Choosing a SIM card" section
- **AND** it SHALL present two options: long-term SIM (recommended) and prepaid/travel SIM (budget option)
- **AND** it SHALL note that the SIM must support SMS for initial activation/registration
- **AND** it SHALL explain the number recycling risk: agent goes offline (availability risk), but no one gains control of the agent (not a security risk)
- **AND** it SHALL explain recovery steps: get a new SIM, re-link or re-register on the Gateway Server, update the allowlist

#### Scenario: Gateway Server login

- **WHEN** a user begins Gateway Server setup
- **THEN** the documentation SHALL instruct logging in with `pnpm run login:gateway`

#### Scenario: Gateway Server Signal registration

- **WHEN** a user configures Signal on the Gateway Server
- **THEN** it SHALL document obtaining a captcha token from a laptop browser
- **AND** it SHALL document registering a dedicated phone number with `signal-cli -u <PHONE_NUMBER> register --captcha "<CAPTCHA_TOKEN>"`
- **AND** it SHALL document verifying the registration with `signal-cli -u <PHONE_NUMBER> verify <SMS_CODE>`

#### Scenario: Gateway Server WhatsApp linking

- **WHEN** a user configures WhatsApp on the Gateway Server
- **THEN** it SHALL document running `openclaw channels login --channel whatsapp --verbose` to display an ASCII QR code in the terminal
- **AND** it SHALL instruct scanning the QR code with WhatsApp on the dedicated phone (WhatsApp > Linked Devices > Link a Device)

#### Scenario: Gateway Server onboard via wizard

- **WHEN** a user configures the Gateway Server
- **THEN** the documentation SHALL instruct running `openclaw onboard --non-interactive --accept-risk --flow quickstart --gateway-bind lan --skip-daemon` on the Gateway Server

#### Scenario: Gateway Server channel configuration (Signal)

- **WHEN** a user configures Signal on the Gateway Server
- **THEN** it SHALL instruct adding the Signal channel with `openclaw channels add --channel signal --account <PHONE_NUMBER>`
- **AND** it SHALL instruct configuring the DM policy to allowlist with `openclaw config set channels.signal.dmPolicy allowlist`
- **AND** it SHALL instruct adding the owner's phone number to the allowlist with `openclaw config set channels.signal.allowFrom '["<OWNER_PHONE_NUMBER>"]'`
- **AND** it SHALL instruct setting session isolation with `openclaw config set session.dmScope per-channel-peer`

#### Scenario: Gateway Server channel configuration (WhatsApp)

- **WHEN** a user configures WhatsApp on the Gateway Server
- **THEN** it SHALL instruct adding the WhatsApp channel with `openclaw channels add --channel whatsapp`
- **AND** it SHALL instruct configuring the DM policy to allowlist with `openclaw config set channels.whatsapp.dmPolicy '"allowlist"'`
- **AND** it SHALL instruct adding the owner's phone number to the allowlist with `openclaw config set channels.whatsapp.allowFrom '["<OWNER_PHONE_NUMBER>"]'`
- **AND** it SHALL instruct setting session isolation with `openclaw config set session.dmScope '"per-channel-peer"'`

#### Scenario: Gateway Server channel configuration (Telegram)

- **WHEN** a user configures Telegram on the Gateway Server
- **THEN** it SHALL document running `openclaw secrets configure` to set up an exec SecretRef provider with args `secretsmanager get-secret-value --secret-id ${agentName}/telegram-token --query SecretString --output text`

#### Scenario: WhatsApp dedicated phone number explanation

- **WHEN** a user reads the WhatsApp setup instructions
- **THEN** the documentation SHALL include a "Why a dedicated phone number?" section
- **AND** it SHALL explain that WhatsApp uses a linked device model where the Gateway Server is a companion device with full protocol-level read/write access to the account
- **AND** it SHALL explain that OpenClaw's `dmPolicy` restricts access at the application layer, not the protocol layer
- **AND** it SHALL recommend a dedicated phone number so that even if the policy is misconfigured, the agent can only reach contacts of the dedicated number

#### Scenario: Gateway Server token export

- **WHEN** a user has completed Gateway Server onboard
- **THEN** it SHALL instruct storing the token in Secrets Manager with `aws secretsmanager put-secret-value --secret-id ${agentName}/gateway-token --secret-string "<GATEWAY_TOKEN>"`

#### Scenario: Gateway Server service management

- **WHEN** a user starts the gateway service
- **THEN** it SHALL document installing and starting the gateway service with `openclaw gateway install` and `openclaw gateway start`
- **AND** it SHALL document enabling the gateway service on boot with `systemctl --user enable openclaw-gateway.service`

#### Scenario: Agent Server login

- **WHEN** a user begins Agent Server setup
- **THEN** the documentation SHALL instruct logging in with `pnpm run login:agent`

#### Scenario: Agent Server setup via wizard

- **WHEN** a user configures OpenClaw on the Agent Server
- **THEN** the documentation SHALL instruct running `openclaw onboard` with appropriate flags for remote mode connecting to `ws://gateway.${agentName}.vpc:18789`

#### Scenario: Agent Server gateway token configuration

- **WHEN** a user configures the gateway token on the Agent Server
- **THEN** it SHALL document running `openclaw secrets configure` with args `secretsmanager get-secret-value --secret-id ${agentName}/gateway-token --query SecretString --output text`

#### Scenario: Agent Server model configuration

- **WHEN** a user configures models on the Agent Server
- **THEN** it SHALL instruct setting the image model with `openclaw models set-image venice/kimi-k2-5`
- **AND** it SHALL instruct setting the fallback model with `openclaw config set agents.defaults.model.fallbacks '["venice/minimax-m25"]'`

#### Scenario: Agent Server web search configuration

- **WHEN** a user configures web search on the Agent Server
- **THEN** it SHALL document running `openclaw secrets configure` with args `secretsmanager get-secret-value --secret-id ${agentName}/web-search-api-key --query SecretString --output text`

#### Scenario: Agent Server LLM secret configuration

- **WHEN** a user configures the LLM secret on the Agent Server
- **THEN** it SHALL document running `openclaw secrets configure` with args `secretsmanager get-secret-value --secret-id ${agentName}/llm-api-key --query SecretString --output text`

#### Scenario: Agent Server start

- **WHEN** a user starts the agent
- **THEN** it SHALL document starting the agent with `openclaw agent`

#### Scenario: Variable placeholders

- **WHEN** a command contains user-specific values
- **THEN** the documentation SHALL use angle bracket placeholders (e.g. `<PHONE_NUMBER>`, `<OWNER_PHONE_NUMBER>`, `<CAPTCHA_TOKEN>`, `<SMS_CODE>`, `<GATEWAY_TOKEN>`, `<TELEGRAM_USER_ID>`)
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
