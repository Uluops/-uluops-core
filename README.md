# @uluops/core

The foundational execution engine for UluOps. Orchestrates AI-powered code analysis through a 4-layer execution hierarchy (Agent > Command > Workflow > Pipeline), manages LLM tool loops via Vercel AI SDK, and integrates with UluOps Registry and Validation services.

## Installation

```bash
npm install @uluops/core
```

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

// Run a saved command configuration
const cmdResult = await client.runCommand('validate', { target: './src' });

// Run a multi-phase workflow
const wfResult = await client.runWorkflow('ship', { target: './src' });

// Auto-detect and route
const autoResult = await client.run('code-validator', { target: './src' });
```

## Convenience Methods

For common workflows, `UluOpsClient` provides shorthand methods:

```typescript
// Validation
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

Discovery and tracking:

```typescript
// List available definitions
const definitions = await client.list({ type: 'agent', domain: 'software' });

// Inspect a definition
const info = await client.describe('code-validator');

// Query validation history
const history = await client.getHistory('my-project');

// Submit results manually
await client.submitResults('my-project', 'custom', result);
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
  +-- ValidationClient     (result submission + issue tracking)
```

## Execution Hierarchy

| Level | Definition | Description |
|-------|-----------|-------------|
| Agent | ADL | Atomic unit: single LLM with filesystem tools |
| Command | CDL | Wraps 1+ agents with preflight checks and aggregation |
| Workflow | WDL | Sequences commands into phases with gates |
| Pipeline | PDL | Orchestrates workflows/commands across stages |

## Key Features

- **AI SDK Integration** - Uses Vercel AI SDK v6 for LLM communication with automatic tool loop management (`maxSteps`) and built-in retry
- **Filesystem Sandboxing** - ToolHandler restricts LLM file access to the target directory
- **Content-Addressed Integrity** - SHA-256 hash verification on all definitions
- **Structured Output Extraction** - 3-strategy fallback: JSON code fence > inline JSON > regex text parsing
- **Validation Tracking** - Automatic result submission with issue correlation, regression detection, and analytics

## Configuration

```typescript
const client = new UluOpsClient({
  // Required
  apiKey: 'your-api-key',         // or ULUOPS_API_KEY env var

  // Optional
  registryUrl: 'https://...',     // Registry API URL
  validationUrl: 'https://...',   // Validation API URL
  modelOverride: 'sonnet',        // Override default model
  trackingEnabled: true,          // Submit results to validation service
  timeout: 300000,                // Request timeout (ms)
  defaultProject: 'my-project',   // Default project for result submission
});
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@uluops/sdk-core` | Shared HTTP infrastructure (HttpClient, errors, auth) |
| `ai` | Vercel AI SDK v6 - LLM communication and tool loops |
| `@ai-sdk/anthropic` | Anthropic provider for AI SDK |
| `yaml` | YAML parsing for local definitions |
| `glob` | File globbing for ToolHandler |
| `zod` | Schema validation for AI SDK tools |

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build
npm run build
```

## License

MIT
