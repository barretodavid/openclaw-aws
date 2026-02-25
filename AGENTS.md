# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

Secure AWS infrastructure for an OpenClaw agent, defined using AWS CDK in TypeScript. See [README.md](README.md) for the full architecture, components, security boundaries, and design decisions.

## Technology

* TypeScript for readability and maintainability
* AWS CDK for infrastructure-as-code
* dotenv for loading `.env` configuration at synth/deploy time

## Build & Deploy Commands

* `npm run typecheck` — type-check TypeScript (no JS emitted)
* `npx cdk synth` — synthesize CloudFormation template
* `npx cdk deploy` — deploy to AWS
* `npx cdk destroy` — tear down the stack
* `npm run test` — run Jest tests

## Project Structure

* `bin/openclaw.ts` — CDK app entry point
* `lib/openclaw-stack.ts` — single stack defining all infrastructure
* `.env` / `.env.example` — LLM API key configuration

## Key Conventions

* Security boundaries are enforced via separate IAM roles per EC2 instance, not network isolation
* The KMS wallet key has `removalPolicy: DESTROY` — see the tear down warning in README.md
* The `.env` file must never be committed (it's in `.gitignore`)
* AWS resource descriptions must use ASCII-only characters (no em dashes, special characters)