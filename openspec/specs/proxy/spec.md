# LLM API Proxy

## Purpose

The Proxy SHALL intercept LLM API requests from the Agent, inject real API keys from Secrets Manager, and forward to backend providers with SSE streaming support.

## Requirements

### Requirement: Subdomain-Based Routing

The Proxy SHALL route requests based on the subdomain in the Host header.

#### Scenario: Valid provider subdomain

- **GIVEN** a request with Host header "anthropic.proxy.vpc:8080"
- **WHEN** the Proxy receives the request
- **THEN** it SHALL extract "anthropic" as the subdomain
- **AND** look up the provider configuration from SSM
- **AND** forward to api.anthropic.com over HTTPS

#### Scenario: Base domain without health path

- **GIVEN** a request with Host header "proxy.vpc" and path != /health
- **WHEN** the Proxy receives the request
- **THEN** it SHALL return 404 with guidance to use provider subdomains

#### Scenario: Unknown provider

- **GIVEN** a request with an unrecognized subdomain
- **WHEN** the Proxy receives the request
- **THEN** it SHALL return 404 with "Unknown provider" error

### Requirement: API Key Injection

The Proxy SHALL inject API keys using provider-specific methods.

#### Scenario: Header-based injection

- **GIVEN** a provider configured with inject type "header"
- **WHEN** forwarding the request
- **THEN** the Proxy SHALL set the configured header name with the API key value
  - Anthropic: x-api-key header (no prefix)
  - OpenAI-compatible: Authorization header with "Bearer " prefix

#### Scenario: Path-based injection

- **GIVEN** a provider configured with inject type "path" (e.g., Alchemy, Infura)
- **WHEN** forwarding the request
- **THEN** the Proxy SHALL append the API key as a final URL path segment

### Requirement: Health Check

The Proxy SHALL expose a health check endpoint.

#### Scenario: Health check response

- **GIVEN** a GET request to /health on the base domain
- **WHEN** the Proxy receives the request
- **THEN** it SHALL return HTTP 200

### Requirement: Transparent Streaming

The Proxy SHALL transparently pipe backend responses including SSE streams.

#### Scenario: Response forwarding

- **WHEN** the backend responds
- **THEN** the Proxy SHALL forward the status code and headers
- **AND** pipe the response body to the client without buffering

### Requirement: Hop-by-Hop Header Stripping

The Proxy SHALL remove RFC 2616 hop-by-hop headers before forwarding.

#### Scenario: Header filtering

- **WHEN** building the outbound request
- **THEN** the Proxy SHALL strip connection, keep-alive, transfer-encoding, te, trailer, upgrade, proxy-authorization, proxy-authenticate, and host headers

### Requirement: Provider Registry

Each provider SHALL be configured with a subdomain, backend domain, injection method, and API compatibility flag.

#### Scenario: Dynamic provider deployment

- **WHEN** a provider's API key is set in .env
- **THEN** a Secrets Manager secret SHALL be created for that provider
- **AND** an SSM Parameter Store entry SHALL map the subdomain to the backend
- **AND** a DNS A record SHALL be created at <subdomain>.proxy.vpc
- **AND** only providers with keys in .env SHALL be deployed

### Requirement: Supported Providers

The Proxy SHALL support the following LLM and RPC providers.

#### Scenario: LLM providers

- **GIVEN** the provider registry
- **THEN** it SHALL support Anthropic, OpenAI, Google Gemini, Mistral, Groq, xAI, OpenRouter, Venice, and Cerebras
- **AND** each SHALL use header-based key injection

#### Scenario: Starknet RPC providers

- **GIVEN** the provider registry
- **THEN** it SHALL support Alchemy and Infura with path-based key injection
- **AND** it SHALL support Cartridge with Bearer header injection
- **AND** it SHALL support Voyager with x-apikey header injection
