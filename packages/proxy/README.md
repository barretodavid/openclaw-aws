# openclaw-aws-proxy

An HTTP proxy that sits between your application and LLM/API providers, automatically injecting API keys from AWS Secrets Manager. Your application sends requests with fake or empty credentials, and the proxy swaps in the real keys before forwarding to the backend.

## How it works

```
Your App                  Proxy                        LLM Provider
   |                        |                               |
   |-- POST /v1/messages -->|                               |
   |   Host: anthropic...   |                               |
   |   Auth: fake-key       |                               |
   |                        |-- fetch secret from AWS SM -->|
   |                        |<-- real API key --------------|
   |                        |                               |
   |                        |-- POST /v1/messages --------->|
   |                        |   Host: api.anthropic.com     |
   |                        |   x-api-key: real-key         |
   |                        |                               |
   |<-- 200 response -------|<-- 200 response --------------|
```

Requests are routed by **subdomain**. The proxy extracts the first label from the `Host` header (e.g. `anthropic` from `anthropic.proxy.vpc:8080`) and looks up the corresponding provider config.

## Key injection methods

- **Header injection** -- sets a specific header (e.g. `x-api-key`, `Authorization: Bearer ...`)
- **Path injection** -- appends the API key as a URL path segment (used by Alchemy, Infura)

## AWS dependencies

- **SSM Parameter Store** -- proxy config (provider mapping) is read from an SSM parameter at startup
- **Secrets Manager** -- API keys are fetched on first use and cached in memory

The proxy expects an IAM role with read access to the relevant SSM parameter and Secrets Manager secrets.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `8080` | Port the proxy listens on |
| `PROXY_CONFIG_PARAM` | `/openclaw/proxy-config` | SSM parameter name for provider config |
| `AWS_REGION` | *(required)* | AWS region for SDK clients |

### SSM parameter format

The proxy config SSM parameter is a JSON object keyed by subdomain:

```json
{
  "anthropic": {
    "backendDomain": "api.anthropic.com",
    "secretName": "openclaw/anthropic-api-key",
    "inject": { "type": "header", "name": "x-api-key" },
    "api": "anthropic"
  },
  "openai": {
    "backendDomain": "api.openai.com",
    "secretName": "openclaw/openai-api-key",
    "inject": { "type": "header", "name": "Authorization", "prefix": "Bearer " },
    "api": "openai"
  },
  "alchemy": {
    "backendDomain": "starknet-mainnet.g.alchemy.com",
    "secretName": "openclaw/alchemy-api-key",
    "inject": { "type": "path" },
    "api": null
  }
}
```

## Installation

```bash
npm install -g openclaw-aws-proxy
```

## Usage

```bash
# Set required env vars
export AWS_REGION=us-east-1
export PROXY_CONFIG_PARAM=/openclaw/proxy-config

# Start the proxy
openclaw-aws-proxy
```

## Supported providers

Anthropic, OpenAI, Google Gemini, Mistral, Groq, xAI, OpenRouter, Venice, Cerebras, Brave Search, Alchemy, Infura, Cartridge, and Voyager. Adding a new provider only requires updating the SSM parameter and creating a Secrets Manager secret -- no code changes needed.

## Part of OpenClaw

This proxy is designed to run alongside the [OpenClaw](https://github.com/barretodavid/safe-aws-agent-infra) agent infrastructure on AWS. The CDK stack in that repo provisions the proxy EC2 instance, IAM roles, secrets, SSM config, and private DNS automatically.

## License

MIT
