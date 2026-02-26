# @uluops/core

[![npm version](https://img.shields.io/npm/v/@uluops/core.svg)](https://www.npmjs.com/package/@uluops/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/@uluops/core)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](test/)

The foundational execution engine for UluOps. Orchestrates AI-powered code analysis through a 4-layer execution hierarchy (Agent > Command > Workflow > Pipeline), manages LLM tool loops via Vercel AI SDK, and integrates with UluOps Registry and Validation services.

## Quick Start

```typescript
import { UluOpsClient } from '@uluops/core';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY,
});

// Run a single agent
const result = await client.runAgent('code-validator', './src', {
  model: 'sonnet',
  thresholds: { pass: 80 },
});

console.log(`Score: ${result.score} | Decision: ${result.decision}`);
```

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Authentication](#authentication)
- [Usage](#usage)
  - [Agent Execution](#agent-execution)
  - [Command Execution](#command-execution)
  - [Workflow Execution](#workflow-execution)
  - [Pipeline Execution](#pipeline-execution)
  - [Convenience Methods](#convenience-methods)
  - [Discovery](#discovery)
  - [Validation Tracking](#validation-tracking)
- [Architecture](#architecture)
- [Execution Hierarchy](#execution-hierarchy)
- [Configuration](#configuration)
- [TypeScript Support](#typescript-support)
- [Error Handling](#error-handling)
- [Dependencies](#dependencies)
- [Development](#development)

## Overview

The `@uluops/core` SDK provides:

- **4-Layer Execution Hierarchy** - Agent > Command > Workflow > Pipeline orchestration
- **AI SDK v6 Integration** - Vercel AI SDK for LLM communication with automatic tool loops (`maxSteps`) and built-in retry
- **Registry-Backed Model Resolution** - Model aliases resolved via UluOps Registry with provider metadata
- **Multi-Provider AI** - Anthropic + OpenAI + Google bundled, additional providers via dynamic import
- **Filesystem Sandboxing** - ToolHandler restricts LLM file access to the target directory
- **Content-Addressed Integrity** - SHA-256 hash verification on all definitions
- **Structured Output Extraction** - 3-strategy fallback: JSON code fence > inline JSON > regex text parsing
- **Validation Tracking** - Automatic result submission with issue correlation, regression detection, and analytics
- **Local Development Support** - Load definitions from local YAML files with registry fallback
- **Bundled Starter Agents** - 5 built-in agents for immediate use without registry access

## Installation

```bash
npm install @uluops/core
```

### Bundled Starter Agents

Get started without registry access using the bundled agent definitions:

```typescript
import { UluOpsClient, STARTER_DEFINITIONS_DIR } from '@uluops/core';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY,
  localDefinitions: STARTER_DEFINITIONS_DIR,
});
```

Includes: `code-validator`, `docs-validator`, `public-interface-validator`, `security-analyst`, `test-architect`.

## Authentication

### UluOps API Key

Required for registry and validation service access:

```bash
# Environment variable (recommended)
export ULUOPS_API_KEY=your_api_key_here

# Or pass directly in config
const client = new UluOpsClient({ apiKey: 'your-key' });
```

The SDK checks for `ULUOPS_API_KEY` then `ULU_API_KEY` environment variables.

### AI Provider Keys

Set environment variables for the providers you want to use. The SDK auto-detects configured providers:

```bash
export ANTHROPIC_API_KEY=your_anthropic_key
export OPENAI_API_KEY=your_openai_key        # optional
export GOOGLE_API_KEY=your_google_key        # optional (also accepts GOOGLE_GENERATIVE_AI_API_KEY)
```

Or configure explicitly:

```typescript
const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY,
  ai: {
    providers: {
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
      openai: { apiKey: process.env.OPENAI_API_KEY },
      google: { apiKey: process.env.GOOGLE_API_KEY },
    },
    defaultProvider: 'anthropic',
  },
});
```

## Usage

### Agent Execution

Direct agent execution with call-time options. Best for interactive/ad-hoc validation:

```typescript
const result = await client.runAgent('code-validator', './src', {
  model: 'sonnet',
  thresholds: { pass: 80, warn: 60 },
  trackResults: true,
  project: 'my-project',
});

console.log(`Score: ${result.score}/${result.maxScore}`);
console.log(`Decision: ${result.decision}`);
console.log(`Recommendations: ${result.recommendations.length}`);
```

### Command Execution

Execute saved command configurations. Uses model, thresholds, and aggregation from the command definition. Ideal for CI/CD:

```typescript
const result = await client.runCommand('validate', { target: './src' });

console.log(`Score: ${result.score}`);
console.log(`Categories:`, result.categories);
```

### Workflow Execution

Multi-phase orchestration with gates between phases:

```typescript
const result = await client.runWorkflow('ship', { target: './src' });

console.log(`Phases completed: ${result.phases.length}`);
console.log(`Overall decision: ${result.decision}`);
```

### Auto-Routing

Universal execution — auto-detects definition type and routes to the correct executor:

```typescript
// Routes automatically based on whether name resolves to agent, command, workflow, or pipeline
const result = await client.run('code-validator', { target: './src' });
console.log(`Decision: ${result.decision}`);
```

### Pipeline Execution

Async multi-stage pipelines with dependency resolution:

```typescript
// Start async pipeline
const handle = await client.startPipeline('full-validation', {
  target: './src',
});

// Monitor progress
const status = await handle.status();
console.log(`Stage ${status.stages.length} of pipeline`);

// Wait for completion
const result = await handle.wait();

// Or cancel
await handle.cancel();
```

### Convenience Methods

Shorthand methods for common workflows:

```typescript
// Run the built-in validate command
const result = await client.validate('./src');

// Security audit
const secResult = await client.security('./src');

// Code optimization analysis
const optResult = await client.optimize('./src');

// Ship workflow (full pre-release validation)
const shipResult = await client.ship('./src');

// Post-implementation validation
const postResult = await client.postImplementation('./src');
```

### Discovery

```typescript
// List available definitions
const definitions = await client.list({ type: 'agent', domain: 'software' });

// Inspect a definition
const info = await client.describe('code-validator');
console.log(info.name, info.version, info.interface);
```

### Validation Tracking

Submit execution results, preview submissions, and query run history:

```typescript
// Automatic tracking: results are submitted automatically when trackingEnabled is true
const result = await client.runAgent('code-validator', './src', {
  trackResults: true,
  project: 'my-project',
});

// Manual submission: submit results from a custom execution
const response = await client.submitResults('my-project', 'post-implementation', result);
console.log(`Run #${response.runNumber}: ${response.dashboardUrl}`);
console.log(`New issues: ${response.correlation.newIssues}, Regressions: ${response.correlation.regressions}`);

// Dry run: preview what a submission would do without saving
const preview = await client.validateRun('my-project', 'post-implementation', result);
if (preview.validationErrors.length > 0) {
  console.error('Validation errors:', preview.validationErrors);
}

// Query history: list past runs for a project
const history = await client.getHistory('my-project');
for (const entry of history) {
  console.log(`Run #${entry.runNumber} — ${entry.workflowType} — Score: ${entry.averageScore}`);
}

// Run details: fetch full details for a specific run
const run = await client.getRun('run-uuid');
```

### Usage Metrics

All execution results include token usage metrics. Provider-specific token fields are mapped to a unified format:

```typescript
const result = await client.runAgent('code-validator', './src');
const { metrics } = result;

console.log(`Input: ${metrics.inputTokens}, Output: ${metrics.outputTokens}`);
console.log(`Cache: ${metrics.cacheCreationTokens ?? 0} created, ${metrics.cacheReadTokens ?? 0} read`);

// Google Gemini 2.5+ models report thinking tokens separately from output tokens.
// thinking_tokens are included in totalEffectiveTokens (unlike OpenAI reasoning_tokens
// which are already counted within outputTokens).
if (metrics.thinkingTokens) {
  console.log(`Thinking: ${metrics.thinkingTokens}`);
}

console.log(`Effective total: ${metrics.totalEffectiveTokens}`);
```

## Architecture

```
UluOpsClient (facade)
  |
  +-- AgentExecutor        (single-agent LLM execution)
  |     +-- AIProvider     (AI SDK v6 wrapper, tool loop via maxSteps)
  |     +-- ToolHandler    (sandboxed filesystem tools)
  |     +-- ToolAdapter    (converts tools to AI SDK format)
  |     +-- OutputExtractor (3-strategy JSON parsing)
  |
  +-- CommandExecutor      (single/multi-agent aggregation)
  |     +-- AgentExecutor
  |     +-- preflight      (prerequisite checks)
  |
  +-- WorkflowExecutor     (multi-phase orchestration with gates)
  |     +-- CommandExecutor
  |
  +-- PipelineExecutor     (multi-stage async pipelines)
  |     +-- WorkflowExecutor
  |     +-- CommandExecutor
  |
  +-- RegistryClient       (definition resolution + hash verification)
  +-- ValidationClient     (result submission + history)
  +-- ModelCatalog         (registry-backed model alias resolution)
```

## Execution Hierarchy

| Level | Definition | Description |
|-------|-----------|-------------|
| Agent | ADL | Atomic unit: single LLM with filesystem tools |
| Command | CDL | Wraps 1+ agents with preflight checks and aggregation |
| Workflow | WDL | Sequences commands into phases with gates |
| Pipeline | PDL | Orchestrates workflows/commands across stages |

## Configuration

```typescript
const client = new UluOpsClient({
  // Required
  apiKey: 'your-api-key',             // or ULUOPS_API_KEY env var

  // AI Configuration
  ai: {
    providers: {                       // Provider API keys (env var fallback)
      anthropic: { apiKey: '...' },
    },
    defaultProvider: 'anthropic',      // Default AI provider
    modelOverride: 'sonnet',           // Override model for all executions
  },

  // Service URLs
  registryUrl: 'https://...',         // Registry API (or ULUOPS_REGISTRY_URL)
  validationUrl: 'https://...',       // Validation API (or ULUOPS_VALIDATION_URL)

  // Behavior
  trackingEnabled: true,              // Auto-submit results to validation service
  hashVerificationEnabled: true,      // Verify definition integrity via SHA-256
  timeout: 300000,                    // Request timeout in ms
  defaultProject: 'my-project',       // Default project for result submission
  debug: false,                       // Detailed execution logging (or ULUOPS_DEBUG)
  defaultThinkingBudget: 10000,       // Extended thinking budget (Anthropic + Google models)
  contextBudget: 200000,              // Context window budget — forces wrap-up at 80%
  dashboardUrl: 'https://app.uluops.ai', // Dashboard link prefix for run URLs

  // Local Development
  localDefinitions: './definitions',  // Load YAML definitions from local dir
});
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ULUOPS_API_KEY` | Platform API key | (required) |
| `ANTHROPIC_API_KEY` | Anthropic provider key | - |
| `OPENAI_API_KEY` | OpenAI provider key | - |
| `GOOGLE_API_KEY` | Google/Gemini provider key | - |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider key (alternative) | - |
| `ULUOPS_REGISTRY_URL` | Registry API URL | `https://api.uluops.ai/api/v1/registry` |
| `ULUOPS_VALIDATION_URL` | Validation API URL | `https://api.uluops.ai/api/v1/ops` |
| `ULUOPS_TRACKING_ENABLED` | Auto-submit results | `true` |
| `ULUOPS_PROJECT` | Default project name | - |
| `ULUOPS_LOCAL_DEFINITIONS` | Local definitions path | - |
| `ULUOPS_DASHBOARD_URL` | Dashboard base URL for run links | `https://app.uluops.ai` |
| `ULUOPS_DEBUG` | Enable detailed execution logging | `false` |

## TypeScript Support

Full TypeScript support with exported types for all parameters and results:

```typescript
import {
  UluOpsClient,
  // Executor types
  type AgentResult,
  type CommandResult,
  type WorkflowResult,
  type PipelineResult,
  // Definition types
  type AgentDefinition,
  type CommandDefinition,
  type WorkflowDefinition,
  type PipelineDefinition,
  // Config types
  type UluOpsConfig,
  type ExecutionInput,
  type ExecutionOptions,
  // Usage metrics
  type UsageMetrics,
  // Error classes
  ExecutionError,
  ConfigurationError,
  ModelNotFoundError,
  // Error code narrowing
  ValidationErrorCodes,
} from '@uluops/core';
```

### Subpath Exports

For tree-shaking or importing just types/errors without pulling in the full client:

```typescript
// Import only types (zero runtime cost)
import type { AgentResult, ExecutionInput } from '@uluops/core/types';

// Import only error classes
import { ExecutionError, ConfigurationError } from '@uluops/core/errors';
```

## Error Handling

The SDK provides a structured error hierarchy:

### Core SDK Errors

| Error | Description |
|-------|-------------|
| `UluOpsError` | Base error class for all SDK errors |
| `ExecutionError` | Agent/command execution failures |
| `PreflightError` | Preflight check failures |
| `ConfigurationError` | Invalid configuration |
| `ModelNotFoundError` | Model alias not found in registry |
| `CapabilityError` | Model lacks required capabilities |
| `ValidationError` | Output validation failures. Use `ValidationErrorCodes` to narrow by code. |
| `WorkflowError` | Workflow phase gate failures |
| `PipelineError` | Pipeline stage failures |
| `ParseError` | Output extraction failures |
| `HashVerificationError` | Definition integrity failures |

### Re-exported from @uluops/sdk-core

| Error | Description |
|-------|-------------|
| `SdkApiError` | Base API error |
| `RateLimitError` | 429 rate limit exceeded |
| `UnauthorizedError` | 401 authentication failure |
| `ForbiddenError` | 403 access denied |
| `NotFoundError` | 404 resource not found |
| `ServiceUnavailableError` | 503 service unavailable |
| `NetworkError` | Connection failures |
| `TimeoutError` | Request timeout |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@uluops/sdk-core` | Shared HTTP infrastructure (HttpClient, errors, auth) |
| `@uluops/registry-sdk` | Registry API client for definitions and models |
| `@uluops/ops-sdk` | Validation tracking API client |
| `ai` | Vercel AI SDK v6 - LLM communication and tool loops |
| `@ai-sdk/anthropic` | Anthropic provider for AI SDK |
| `@ai-sdk/openai` | OpenAI provider for AI SDK |
| `@ai-sdk/google` | Google/Gemini provider for AI SDK |
| `yaml` | YAML parsing for local definitions |
| `glob` | File globbing for ToolHandler |
| `zod` | Schema validation for AI SDK tools |

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests (366 tests)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Build
npm run build
```

## License

MIT
