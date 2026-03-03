# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

Secure AWS infrastructure for an OpenClaw agent, defined using AWS CDK in TypeScript. See [README.md](README.md) for the full architecture, components, security boundaries, and design decisions.

## Technology

* TypeScript for readability and maintainability
* AWS CDK for infrastructure-as-code
* pnpm workspaces for monorepo dependency management
* dotenv for loading `.env` configuration at synth/deploy time

## Build & Deploy Commands

* `pnpm run typecheck` — type-check TypeScript across all packages
* `pnpm run test` — run Jest tests across all packages
* `pnpm run synth` — synthesize CloudFormation template
* `pnpm run deploy` — deploy to AWS
* `pnpm run destroy` — tear down the stack

## Project Structure

* `packages/cdk/` — CDK infrastructure package
  * `bin/openclaw.ts` — CDK app entry point
  * `lib/openclaw-stack.ts` — single stack defining all infrastructure
* `packages/proxy/` — LLM API proxy package (published to npm)
* `.env` / `.env.example` — per-provider API key configuration

## Key Conventions

* Security boundaries are enforced via separate IAM roles per EC2 instance, not network isolation
* The KMS wallet key has `removalPolicy: DESTROY` — see the tear down warning in README.md
* The `.env` file must never be committed (it's in `.gitignore`)
* AWS resource descriptions must use ASCII-only characters (no em dashes, special characters)
* When researching GitHub repos, prefer `gh search code` over `gh api` — search is read-only and auto-approved, while `gh api` can write and should require user confirmation