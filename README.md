**[UluOps](https://uluops.ai)** · Operating Intelligence as Infrastructure

---

# @uluops/core

[![npm version](https://img.shields.io/npm/v/@uluops/core.svg)](https://www.npmjs.com/package/@uluops/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/@uluops/core)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](test/)

The foundational execution engine for UluOps. Orchestrates AI-powered code analysis through a 4-layer execution hierarchy (Agent > Command > Workflow > Pipeline), manages LLM tool loops via Vercel AI SDK, and integrates with UluOps Registry and Validation services.

## Prerequisites

- **Node.js 18+** with an ESM project (`"type": "module"` in package.json)
- **[tsx](https://github.com/privatenumber/tsx)** for running TypeScript examples: `npm install -D tsx`
- **UluOps API key** — get one at [app.uluops.ai](https://app.uluops.ai), or use bundled starter agents offline (see below)
- **AI provider key** — at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`

```bash
npm install @uluops/core
export ULUOPS_API_KEY=ulr_your_key_here
export ANTHROPIC_API_KEY=your_anthropic_key  # or OPENAI_API_KEY
```

## Quick Start

Create `validate.ts`:

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

// Or run a saved command configuration (model, thresholds, and aggregation
// come from the command definition — ideal for CI):
const cmd = await client.runCommand('validate', { target: './src' });
console.log(`Score: ${cmd.score} | Decision: ${cmd.decision}`);
```

```bash
npx tsx validate.ts
```

### Offline Quick Start (No UluOps API Key)

Use the bundled starter agents without registry access. An AI provider key (e.g. `ANTHROPIC_API_KEY`) is still required:

```typescript
import { UluOpsClient, STARTER_DEFINITIONS_DIR } from '@uluops/core';

const client = new UluOpsClient({
  localDefinitions: STARTER_DEFINITIONS_DIR,
  trackingEnabled: false,
});

const result = await client.runAgent('code-validator', './src');
console.log(`Score: ${result.score} | Decision: ${result.decision}`);
```

This still requires an AI provider key but no UluOps API key or network access to the registry.

> **Note:** `runAgent`/`resolve` return immediately from local definitions when found. `client.list()`, however, always queries the registry first and only falls back to the bundled definitions after the request fails — in a genuinely offline environment that means a few seconds of retry/backoff before the local list returns.

> **Workflows and pipelines.** Local resolution applies the same WDL/PDL authoring→runtime normalization (e.g. `steps[]` → `commands[]`/`agentRefs[]`) the registry applies server-side, so `runWorkflow`/`runPipeline` resolve from local definitions too — provided every definition they reference (sub-agents, commands) is itself resolvable, locally or from the registry.

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
  - [Integrity Verification](#integrity-verification)
- [Architecture](#architecture)
- [Execution Hierarchy](#execution-hierarchy)
- [Advanced Exports](#advanced-exports)
- [Configuration](#configuration)
- [TypeScript Support](#typescript-support)
- [Error Handling](#error-handling)
- [Security](#security)
- [Dependencies](#dependencies)
- [Development](#development)

## Overview

The `@uluops/core` SDK provides:

- **4-Layer Execution Hierarchy** - Agent > Command > Workflow > Pipeline orchestration
- **AI SDK v6 Integration** - Vercel AI SDK for LLM communication with automatic tool loops (`maxSteps`) and built-in retry
- **Registry-Backed Model Resolution** - Model aliases resolved via UluOps Registry with provider metadata
- **Multi-Provider AI** - Anthropic-first with deepest optimization (caching, context management, bash tools); OpenAI + Google bundled; Mistral, Cohere, and 10+ others via dynamic `@ai-sdk/*` import. See [SCOPE.md](https://github.com/Uluops/uluops-core/blob/main/SCOPE.md) for provider strategy.
- **Filesystem Sandboxing** - ToolHandler restricts LLM file access to the target directory with symlink-aware path validation
- **Content-Addressed Integrity Verification** - Registry-resolved definitions carry a SHA-256 YAML content hash (`sha256:…`) and, for agents/commands, a `promptHash` over the frozen rendered prompt. Hashing uses the shared `@uluops/sdk-core` implementation, so the client and registry hash identically. Remote resolution executes the **frozen `runtimeMd`** the `promptHash` certifies (not a live re-render). Callers can pin `expectedHash`/`expectedPromptHash` (from a trusted channel) on `resolve()`/`ExecutionOptions`; pins are verified **fail-closed** on every resolve path (cache/local/remote) and a mismatch throws `IntegrityError`. Verification is opt-in — unpinned resolves behave as before. See [Integrity Verification](#integrity-verification).
- **Universal Agent Output** - Single `agentOutputSchema` with categories + artifacts for all 6 agent types (validator, executor, analyst, generator, explorer, forecaster)
- **Structured Output Extraction** - 4-strategy fallback: AI SDK structured output > JSON code fence > inline JSON > regex text parsing
- **Validation Tracking** - Automatic result submission with issue correlation, regression detection, per-agent execution recording, and analytics
- **Analysis Summary Extraction** - Automatic extraction of category scores, cognitive system metrics, epistemic assessments, and exploration maps from agent results at submission time. Execution telemetry (tokens, model, duration) travels first-class on `agents[]`, never inside analysis data
- **Local Development Support** - Load definitions from local YAML files with registry fallback
- **Bundled Starter Agents** - 5 built-in agents for immediate use without registry access

## Installation

```bash
npm install @uluops/core
```

Bundled starter agents (no registry needed): `code-validator`, `docs-validator`, `public-interface-validator`, `security-analyst`, `test-architect`.

## Authentication

### UluOps API Key

Required for registry and validation service access:

```bash
# Environment variable (recommended)
export ULUOPS_API_KEY=ulr_your_api_key_here
```

Or pass directly in config:

```typescript
const client = new UluOpsClient({ apiKey: 'ulr_your-key' });
```

The SDK checks for `ULUOPS_API_KEY` then `ULU_API_KEY` environment variables. Keys use a `ulr_` prefix. Generate one at [app.uluops.ai](https://app.uluops.ai).

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

console.log(`Score: ${result.score} | Decision: ${result.decision}`);
console.log(`Recommendations: ${result.recommendations.length}`);
```

#### Operator Prompt

Pass a `prompt` to give the agent a directive or focus. Especially useful for generators and executors that need to know *what* to create:

```typescript
// Generator: tell it what to create
const generated = await client.runAgent('aristotle-generator', {
  target: './src',
  prompt: 'Create a health check endpoint for the Express API',
}, { model: 'opus' });

// Validator: provide focus context
const focused = await client.runAgent('security-analyst', {
  target: './src',
  prompt: 'Focus on the authentication middleware and JWT handling',
});
```

The prompt appears as a prominent `Directive:` section in the initial message, before project context. When omitted, behavior is identical to previous versions.

#### Run Completeness & Degradation Markers

Every agent run carries a `completeness` signal — **distinct from the agent's decision** — describing whether the run actually finished its work:

```typescript
const result = await client.runAgent('security-analyst', './src');

// Decision = what the agent concluded; completeness = whether the run finished its work.
console.log(`${result.decision} · ${result.completeness ?? 'complete'}`);

if (result.completeness !== 'complete') {
  for (const m of result.degradationMarkers ?? []) {
    console.log(`[${m.severity}] ${m.code}${m.detail ? ` — ${m.detail}` : ''}`);
  }
}
```

- **`completeness`**: `'complete' | 'partial' | 'failed'`, derived from degradation markers (any `critical` ⇒ `failed`; any `degraded` ⇒ `partial`; else `complete`). Absent ⇒ treat as `complete`. A `PASS` + `partial` result is a positive verdict reached on incomplete evidence — worth surfacing.
- **`degradationMarkers`**: typed `{ code, phase, severity, detail? }[]`. `code` is the stable contract (e.g. `budget.forced-wrap-up`, `steps.near-exhaustion`, `extraction.low-confidence`, `render.raw-yaml-fallback`); `detail` is human-only — never match on it. `phase` is `'resolution' | 'execution'`.
- The engine *observes* completeness from how the run actually executed; agents never self-report it. `deriveCompleteness(markers)` is exported if you want to recompute it.
- `degradations: string[]` is the deprecated legacy alias (resolution-phase strings only), retained for compatibility — prefer `degradationMarkers`.

> Empty-output step exhaustion is a thrown [`MaxStepsExhaustedError`](#error-handling), not a marker; near-exhaustion *with* output is the `steps.near-exhaustion` marker.

### Command Execution

Execute saved command configurations. Uses model, thresholds, and aggregation from the command definition. Ideal for CI/CD:

```typescript
const result = await client.runCommand('validate', { target: './src' });

// Override the definition's default model at runtime (e.g., for CI cost control)
const fast = await client.runCommand('validate', { target: './src' }, { model: 'haiku' });

console.log(`Score: ${result.score}`);
console.log(`Categories:`, result.categories);
```

### Workflow Execution

DAG-based multi-phase orchestration with quality gates. Independent phases execute in parallel; dependent phases wait for their dependencies:

```typescript
const result = await client.runWorkflow('ship', { target: './src' });

console.log(`Overall: ${result.decision} (score: ${result.score})`);

for (const phase of result.phases) {
  // decision: 'passed' | 'warned' | 'blocked' | 'skipped' | 'aborted'
  console.log(`  ${phase.name}: ${phase.decision} (${phase.score})`);
}

// Metrics break down phase outcomes
const { phasesExecuted, phasesPassed, phasesBlocked, phasesAborted } = result.metrics;
```

Workflows define phase dependencies and failure behaviors in their WDL definition:

```yaml
orchestration:
  on_failure: stop       # stop | abort | continue | warn
  max_parallel: 3        # optional concurrency limit
  phases:
    - id: lint
      commands: [lint-validator@latest]
    - id: test
      commands: [test-architect@latest]
    - id: security
      commands: [security-analyst@latest]
      depends_on: [lint, test]   # DAG dependency — waits for lint + test
      gate:
        threshold: 85
        on_fail: abort
```

### Auto-Routing

Universal execution — auto-detects definition type and routes to the correct executor:

```typescript
// Routes automatically based on whether name resolves to agent, command, workflow, or pipeline
const result = await client.run('code-validator', { target: './src' });
console.log(`Decision: ${result.decision}`);
```

### Pipeline Execution

Synchronous execution (blocks until complete):

```typescript
const result = await client.runPipeline('foundations', { target: './src' });

console.log(`Overall: ${result.decision} (score: ${result.score})`);
for (const stage of result.stages) {
  console.log(`  ${stage.name}: ${stage.status}`);
}
```

**Stage & agent conditions.** A stage's `condition` (and per-agent `agents[].condition` in inline-agent stages) is a **run-gate**: the stage or agent runs when the expression holds and is skipped when it is definitively false. Conditions can read run parameters (`params.frontend`, passed via `ExecutionInput.params`) and prior-stage results, including executed step outputs (`stages.preflight.steps['Detect TypeScript'].output == 'DETECTED'`). Unresolvable expressions — missing param or stage, unsupported namespace, or over the length cap — **fail open**: the stage runs and a warning is logged. `skip_if` is deprecated (skip-if-true semantics). See the PDL spec for the full expression grammar.

Async execution with handle-based control:

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

### Cache Management

```typescript
// Clear the definition resolution cache — call after registry updates in long-lived processes
client.clearCache();
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
const preview = await client.previewSubmission('my-project', 'post-implementation', result);
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

On the auto-tracking path, a failed submission (e.g. a free-tier `402 PROJECT_LIMIT`, `SUBSCRIPTION_REQUIRED`, or a transient 5xx) is **non-fatal** — the agent run still resolves successfully. The result carries `trackingFailed: true` plus a typed `trackingError` (`{ code, statusCode, message, requestId, details }`), so callers can surface the reason — and any `details.upgradeUrl` — instead of silently dropping the dashboard link. `code` (e.g. `PROJECT_LIMIT`) is the stable contract; `message` is human-readable and should not be matched on.

**What lands in analysis data.** At submission time, `AnalysisSummaryExtractor` builds the run's `analysisSummary` + `analysisRecords`:

- `systemMetrics` carries the agent's **cognitive measurements only** — its analysis-block `system_metrics`, else structured-output `domainMetrics`, else `null`. Execution telemetry (tokens, model, duration) is never merged in; it travels on `agents[]`.
- Extraction facts (`extraction_confidence`, `extraction_method`) are epistemic facts about the parse and merge into `epistemicAssessment` — the agent's own keys always win.
- Record `severity` is sanitized onto the tracker enum (`critical`/`high`/`medium`/`low`/`info`): enum values are case-normalized; anything else (register-style severities like `structural` or `NOTABLE`) becomes `null` with the original preserved as `data.rawSeverity`. One off-vocabulary record can no longer reject the entire submission.

### Usage Metrics

All execution results include token usage metrics. Provider-specific token fields are mapped to a unified format:

```typescript
const result = await client.runAgent('code-validator', './src');
const { metrics } = result;

console.log(`Input: ${metrics.inputTokens}, Output: ${metrics.outputTokens}`);
console.log(`Cache: ${metrics.cacheCreationTokens ?? 0} created, ${metrics.cacheReadTokens ?? 0} read`);
console.log(`Harness: ${metrics.harness ?? 'unknown'}`); // producing runtime ('uluops-core'), v0.26.0

// Cross-harness components (v0.26.0). cachedInputTokens is the cache-served portion of
// gross input (OpenAI/Google), SUBTRACTED in totalEffectiveTokens. reasoningOutputTokens
// (OpenAI) and thinkingTokens (Google) are subsets of gross outputTokens — exposed for
// cost breakdown only, NEVER added to totalEffectiveTokens (the AI SDK already folds them in).
if (metrics.cachedInputTokens) console.log(`Cached input: ${metrics.cachedInputTokens}`);
if (metrics.reasoningOutputTokens) console.log(`Reasoning: ${metrics.reasoningOutputTokens}`);
if (metrics.thinkingTokens) console.log(`Thinking: ${metrics.thinkingTokens}`);

// Canonical: (inputTokens − cachedInputTokens) + outputTokens (gross) + cacheCreationTokens.
console.log(`Effective total: ${metrics.totalEffectiveTokens}`);
```

### Integrity Verification

Pin a definition's expected hashes so execution is **refused** if the resolved
content doesn't match. Pins come from a trusted, independent channel (a lockfile,
a reviewed value) — recomputing against the registry's own returned hash only
catches an internally-inconsistent registry, not a compromised one.

```typescript
import { IntegrityError } from '@uluops/core';

try {
  const result = await client.runAgent('code-validator', './src', {
    expectedHash: 'sha256:…',        // pins the YAML (source + config)
    expectedPromptHash: 'sha256:…',  // pins the rendered prompt (agents/commands)
  });
} catch (err) {
  if (err instanceof IntegrityError) {
    // err.kind: 'yaml' | 'prompt' | 'unavailable'; err.expected / err.actual
    // err.definitionName / err.definitionVersion identify which definition failed
    console.error(`Execution refused (${err.kind}) for ${err.definitionName}@${err.definitionVersion}: ${err.message}`);
  }
}
```

- **Both pins are optional.** Unpinned resolves are unverified and behave exactly as before.
- **`expectedHash`** verifies `computeHash(resolved.yaml)` — covers source and execution config. For **WDL/PDL** the YAML *is* the runtime, so the YAML pin alone fully covers execution.
- **`expectedPromptHash`** verifies the frozen rendered prompt and is required (with `expectedHash`) for full **agent/command** executed-prompt integrity. Supplying it for a definition with no rendered prompt (workflow/pipeline, local, content-gated, schema-stale) throws `IntegrityError(kind: 'unavailable')` — never a silent pass.
- Verification runs on **every** resolve path, including cache hits — a prior unpinned resolve cannot let a later pinned one through unchecked.
- `ResolvedDefinition` also surfaces `promptHash` and `translatorVersion` so callers can detect a retranslation restamp.

> **Trust bootstrap.** This ships the verification *mechanism* and explicit pin inputs, not pin *provenance*. A pin seeded from a first unpinned `resolve()` against an already-compromised registry is trust-on-first-use. A pin manifest (lockfile) is the natural completion.

## Architecture

For a detailed, hop-by-hop trace of every execution chain (resolution → LLM generation → persistence), see [ARCHITECTURE.md](./ARCHITECTURE.md).

```text
UluOpsClient (facade)
  |
  +-- AgentExecutor        (single-agent LLM execution)
  |     +-- AIProvider     (AI SDK v6 wrapper, provider registry, context management)
  |     +-- ToolHandler    (sandboxed filesystem tools with symlink protection)
  |     +-- ToolAdapter    (converts tools to AI SDK format)
  |     +-- OutputExtractor (4-strategy: structured output > JSON fence > inline JSON > regex)
  |
  +-- CommandExecutor      (single/multi-agent aggregation via Promise.allSettled)
  |     +-- AgentExecutor
  |     +-- preflight      (prerequisite checks with path traversal protection)
  |
  +-- WorkflowExecutor     (DAG-based parallel phase orchestration with quality gates)
  |     +-- CommandExecutor
  |
  +-- PipelineExecutor     (multi-stage async pipelines)
  |     +-- WorkflowExecutor
  |     +-- CommandExecutor
  |
  +-- RegistryClient       (definition resolution + content hash)
  +-- SubmissionClient     (result submission + history)
  |     +-- AnalysisSummaryExtractor (auto-extract analysis from AgentResult)
  +-- ModelCatalog         (registry-backed model alias resolution)
```

## Execution Hierarchy

| Level | Definition | Description |
|-------|-----------|-------------|
| Agent | ADL | Atomic unit: single LLM with filesystem tools. 6 types: validator, executor, analyst, generator, explorer, forecaster — all produce a universal `AgentResult` (`score`/`maxScore` are `number \| null`: `null` for generators/executors that produce artifacts not scores), with categories and optional artifacts |
| Command | CDL | Wraps 1+ agents with preflight checks and aggregation |
| Workflow | WDL | Sequences commands into phases with quality gates (DAG-based parallel execution) |
| Pipeline | PDL | Orchestrates workflows/commands across stages |

## Advanced Exports

All internal components are exported for direct use when `UluOpsClient` is too opinionated. Import from the package root (reference listing — import only what you need):

```typescript
import {
  // Executors — run definitions at any level without the UluOpsClient facade
  AgentExecutor,       // Single-agent LLM execution with tool loop
  CommandExecutor,     // Multi-agent aggregation with preflight checks
  WorkflowExecutor,    // DAG-based parallel phase orchestration with quality gates
  PipelineExecutor,    // Multi-stage async pipelines

  // Service clients — talk to UluOps APIs directly
  RegistryClient,      // Definition resolution, local/remote (normalization: server-side via API; local applies the same authoring→runtime transforms client-side)
  SubmissionClient,    // Run submission, history queries, regression detection

  // AI layer — provider management and model resolution
  AIProvider,          // AI SDK v6 wrapper with provider registry and error mapping
  ModelCatalog,        // Registry-backed model alias → provider/model resolution
  ToolAdapter,         // Converts ToolHandler tools to AI SDK ToolSet format
  TokenBudgetTracker,  // Tracks token consumption against configurable budgets

  // Analysis
  AnalysisSummaryExtractor, // Auto-extract analysisSummary + analysisRecords from agent results

  // Utilities
  OutputExtractor,     // 4-strategy LLM output parser (structured > JSON fence > inline > regex)
  ToolHandler,         // Sandboxed filesystem tools (read_file, list_files, search_content, get_file_info, get_directory_tree, get_symbols)
  parseRef,            // Parse "name@version" reference strings
  classifyDecision,    // Classify decision strings into positive/negative/conditional/neutral
  buildVocabularyMap,  // Build custom decision vocabulary from agent definitions
  deriveCompleteness,         // Recompute completeness from a DegradationMarker[]
  resolutionMarkersFromLegacy, // Convert the deprecated degradations[] to DegradationMarker[]
} from '@uluops/core';
```

### Exported Constants

The default thresholds and limits used by the executors are exported for custom
threshold logic, diagnostics, and tests:

```typescript
import {
  DEFAULT_PASS_THRESHOLD,  // 75    — default validator pass threshold
  DEFAULT_WARN_THRESHOLD,  // 50    — default warn threshold
  DEFAULT_GATE_THRESHOLD,  // 70    — default workflow phase gate
  DEFAULT_MAX_STEPS,       // 50    — default tool-loop step ceiling
  DEFAULT_MAX_TOKENS,      // 16384 — default output tokens per generation call
  STARTER_DEFINITIONS_DIR, // bundled starter definitions directory (offline quick start)
} from '@uluops/core';
```

### Direct Executor Usage

```typescript
import { AgentExecutor, AIProvider, RegistryClient } from '@uluops/core';

// Wire up dependencies manually
const ai = new AIProvider(config, catalog, logger);
const executor = new AgentExecutor(config, ai, logger);

// Execute with full control over options
const result = await executor.execute(resolvedDefinition, {
  target: '/path/to/project',
  prompt: 'Create a database migration for the users table',  // optional operator directive
}, {
  model: 'opus',
  maxTokens: 16384,
  timeoutMs: 60_000,
});
```

### Model Resolution

```typescript
import { ModelCatalog } from '@uluops/core';

const catalog = new ModelCatalog(registrySdk);
const resolved = await catalog.resolve('sonnet', {
  requiredCapabilities: ['tools', 'extendedThinking'],
});
// → { provider: 'anthropic', modelId: 'claude-sonnet-4-...', providerModelId: 'claude-sonnet-4-...' }

// Enumerate available models and aliases
const aliases = await catalog.listAliases();
const premiumModels = await catalog.listModels({ tier: 'premium' });

// Clear in-memory cache after registry admin syncs models
catalog.refresh();
```

### Decision Classification

```typescript
import { classifyDecision, buildVocabularyMap } from '@uluops/core';

// Core vocabularies — covers all execution layers
classifyDecision('PASS');     // → 'positive'
classifyDecision('COMPLETE'); // → 'positive'
classifyDecision('FAIL');     // → 'negative'
classifyDecision('WARN');     // → 'conditional'
classifyDecision('PARTIAL');  // → 'conditional' (progress, not failure)
classifyDecision('MAYBE');    // → 'neutral' (unknown)

// Custom vocabulary from agent definition — cognitive lens agents use these
const vocab = buildVocabularyMap(agentDefinition);
classifyDecision('EXAMINED', vocab);  // → 'positive' (Socrates)
classifyDecision('VITAL', vocab);     // → 'positive' (Nietzsche)
```

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
    additionalProviders: ['groq', 'xai'], // Enable extra @ai-sdk/* providers (must be installed)
  },

  // Service URLs
  registryUrl: 'https://...',         // Registry API (or ULUOPS_REGISTRY_URL)
  submissionUrl: 'https://...',        // Submission API (or ULUOPS_SUBMISSION_URL)

  // Behavior
  trackingEnabled: true,              // Auto-submit results to validation service
  timeout: 300000,                    // Request timeout in ms
  defaultProject: 'my-project',       // Default project for result submission
  debug: false,                       // Detailed execution logging (or ULUOPS_DEBUG)
  defaultThinkingBudget: 10000,       // Extended thinking budget (Anthropic + Google models)
  contextBudget: 200000,              // Optional cap on the context budget (forces wrap-up at 80%, Anthropic eviction at 50%).
                                      // When unset, the engine uses the resolved model's real context window
                                      // (registry `limits.context`) — e.g. 1M for Opus 4.6+, 128k for many GPT/Gemini —
                                      // falling back to 200k only when the window is unknown. When set, it caps the
                                      // budget at min(this, modelWindow). Set it to control cost on large-window models.
  maxRetries: 2,                      // Retries for transient LLM errors (429/5xx); exponential backoff via AI SDK
  maxConcurrency: 8,                  // Global ceiling on concurrent in-flight LLM calls across the whole engine
                                      // (or ULUOPS_MAX_CONCURRENCY). Bounds total requests regardless of how many
                                      // workflow phases, parallel steps, or inline pipeline agents fan out at once —
                                      // the global throttle that stops fan-out × retry from amplifying a rate limit.
                                      // Distinct from a workflow's per-level `max_parallel`, which caps one layer only.
  dashboardUrl: 'https://app.uluops.ai', // Dashboard link prefix for run URLs

  // Security
  allowedTools: ['bash'],             // Operator tool allowlist (or ULUOPS_ALLOWED_TOOLS)
                                      // Default: all tools except 'bash' are allowed
  allowStageSteps: false,             // Permit engine execution of PDL stage `steps:` blocks
                                      // (host shell; or ULUOPS_ALLOW_STAGE_STEPS=true). Off by
                                      // default — steps-only stages pass through with a null
                                      // score when disabled. See Security > Stage Steps.

  // Local Development
  localDefinitions: './definitions',  // Load YAML definitions from local dir
});
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ULUOPS_API_KEY` | Platform API key | (required) |
| `ULU_API_KEY` | Platform API key (legacy alias; used only if `ULUOPS_API_KEY` is unset) | - |
| `ANTHROPIC_API_KEY` | Anthropic provider key | - |
| `OPENAI_API_KEY` | OpenAI provider key | - |
| `GOOGLE_API_KEY` | Google/Gemini provider key | - |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider key (alternative) | - |
| `ULUOPS_REGISTRY_URL` | Registry API URL | `https://api.uluops.ai/api/v1/registry` |
| `ULUOPS_SUBMISSION_URL` | Submission API URL | `https://api.uluops.ai/api/v1` |
| `ULUOPS_TRACKING_ENABLED` | Auto-submit results | `true` |
| `ULUOPS_PROJECT` | Default project name | - |
| `ULUOPS_LOCAL_DEFINITIONS` | Local definitions path | - |
| `ULUOPS_DASHBOARD_URL` | Dashboard base URL for run links | `https://app.uluops.ai` |
| `ULUOPS_ALLOWED_TOOLS` | Comma-separated tool allowlist (e.g., `bash`) | all except `bash` |
| `ULUOPS_ALLOW_STAGE_STEPS` | Permit engine execution of PDL stage `steps:` blocks (host shell; exact string `true`) | `false` |
| `ULUOPS_MAX_CONCURRENCY` | Global ceiling on concurrent in-flight LLM calls | `8` |
| `ULUOPS_DEBUG` | Enable detailed execution logging | `false` |

## TypeScript Support

Full TypeScript support with exported types for all parameters and results:

```typescript
import {
  UluOpsClient,
  // Result types — AgentResult is universal for all 6 agent types
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
  // Async pipeline handle (return type of startPipeline)
  type PipelineHandle,
  // Decision classification
  classifyDecision,
  type DecisionCategory,
  type DecisionVocabularyMap,   // return type of buildVocabularyMap
  // Analysis & AI layer companion types (for direct Advanced Exports usage)
  type AnalysisExtractionResult, // return type of AnalysisSummaryExtractor
  type ResolvedModel,            // return type of ModelCatalog.resolve
  // Completeness & degradation markers
  deriveCompleteness,
  resolutionMarkersFromLegacy, // migrate the deprecated degradations[] field
  type Completeness,
  type DegradationMarker,
  type DegradationPhase,        // 'resolution' | 'execution'
  type DegradationSeverity,     // 'info' | 'degraded' | 'critical'
  // Usage metrics
  type ExecutionMetrics,        // type of result.metrics on every result type (camelCase)
  type UsageMetrics,            // raw AI-provider usage on AIGenerateResult.usage (advanced; snake_case)
  type AIGenerateResult,        // return type of AIProvider.generate() (advanced)
  // Error classes
  ExecutionError,
  MaxStepsExhaustedError,
  ConfigurationError,
  ModelNotFoundError,
  // Error code narrowing
  SubmissionErrorCodes,
  UluOpsErrorCodes,
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

> **Note:** The `/types` subpath exports consumer-facing types only. Internal registry configuration types (`CategoryConfig`, `CriteriaConfig`, `PhaseConfig`, etc.) are not part of the public API — use the YAML schema definitions as the authoritative reference for these structures.

## Error Handling

The SDK provides a structured error hierarchy:

### Core SDK Errors

| Error | Thrown by | Description |
|-------|----------|-------------|
| `UluOpsError` | _(base class)_ | Base error class for all SDK errors. Use `UluOpsErrorCodes` for exhaustive code narrowing |
| `ConfigurationError` | `UluOpsClient` constructor, `RegistryClient.resolve()`, `AIProvider.ensureProvider()` | Missing API key, invalid provider config, definition not found in registry, invalid definition format |
| `ModelNotFoundError` | `ModelCatalog.resolve()` | Model alias not found in registry catalog |
| `CapabilityError` | `ModelCatalog.resolve()` | Resolved model lacks a required capability (e.g. tools, vision, extendedThinking) |
| `PreflightError` | `CommandExecutor` (preflight phase) | Preflight check failed — missing env var, file not found, command unavailable |
| `ExecutionError` | `AgentExecutor.execute()`, `CommandExecutor.execute()` | Agent execution failure or definition type mismatch. Check `error.partialResult` for partial output |
| `MaxStepsExhaustedError` | `AgentExecutor.execute()` | The tool loop hit the `maxSteps` ceiling while the model was still calling tools, leaving empty output. Subclass of `ExecutionError` (code `MAX_STEPS_EXHAUSTED`); carries `error.steps` and `error.finishReason`. Raise `maxSteps`, narrow the target, or lower the context budget so wrap-up triggers earlier |
| `ParseError` | `OutputExtractor.extractWithMetadata()` | LLM output could not be parsed as structured JSON. Check `error.contentPreview` for raw output |
| `SubmissionError` | `SubmissionClient` methods | Validation service rejected a submission. Use `SubmissionErrorCodes` to narrow by code |
| `WorkflowError` | `WorkflowExecutor.execute()` | Phase gate failure. Check `error.context.partialResult` for completed phase results |
| `PipelineError` | `PipelineExecutor.execute()` | Pipeline stage failure. Check `error.context` for stage name/index |
| `SubscriptionRequiredError` | `RegistryClient.resolve()` | Definition requires a higher subscription tier. Check `error.requiredTier`, `error.currentTier`, and `error.upgradeUrl` for upgrade guidance |
| `IntegrityError` | `RegistryClient.resolve()` (caller-pinned) | A pinned `expectedHash`/`expectedPromptHash` did not match the resolved content, or a prompt pin was supplied for a definition with no rendered prompt. Check `error.kind` (`'yaml'`/`'prompt'`/`'unavailable'`), `error.expected`, `error.actual`, and `error.definitionName`/`error.definitionVersion` (which definition failed). Fail-closed — execution is refused |

```typescript
import { ConfigurationError, ModelNotFoundError, CapabilityError, ExecutionError, MaxStepsExhaustedError, WorkflowError, SubscriptionRequiredError } from '@uluops/core';

try {
  const result = await client.runAgent('code-validator', './src');
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error('Check your config:', error.message);
  } else if (error instanceof ModelNotFoundError) {
    console.error('Unknown model alias:', error.message);
  } else if (error instanceof CapabilityError) {
    console.error('Model lacks a required capability:', error.message);
  } else if (error instanceof MaxStepsExhaustedError) {
    // Check this BEFORE ExecutionError — it is a subclass.
    console.error(`Hit the step ceiling (${error.steps} steps) — raise maxSteps or narrow the target.`);
  } else if (error instanceof ExecutionError) {
    console.error('Execution failed:', error.message);
    console.log('Partial result:', error.partialResult);
  } else if (error instanceof WorkflowError) {
    // Phase gate failure — completed phases are in error.context.partialResult
    console.error('Workflow gate failed:', error.message);
  } else if (error instanceof SubscriptionRequiredError) {
    console.error(`Upgrade required: needs "${error.requiredTier}" (you have "${error.currentTier}"). ${error.upgradeUrl}`);
  }
}
```

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

### Network Error Recovery

```typescript
import { NetworkError, TimeoutError, RateLimitError } from '@uluops/core';

try {
  const result = await client.runAgent('code-validator', './src');
} catch (error) {
  if (error instanceof TimeoutError) {
    // Increase timeout: default is 300s, some large repos need more
    const result = await client.runAgent('code-validator', './src', {
      timeoutMs: 600_000,
    });
  } else if (error instanceof RateLimitError) {
    // Back off and retry — the SDK does not auto-retry rate limits
    await new Promise(r => setTimeout(r, 5000));
  } else if (error instanceof NetworkError) {
    // Check ULUOPS_REGISTRY_URL and ULUOPS_SUBMISSION_URL environment variables
    console.error('Connection failed. Verify API URLs and network access.');
  }
}
```

## Security

### Tool Allowlist

Agent definitions can request tools (e.g., `tools: ['bash']` in YAML), but the operator must explicitly permit them. This separates the trust boundary: **definition authors declare** what they need, **operators decide** what they permit.

By default, all tools except `bash` are allowed. The `bash` tool passes LLM-generated command strings to `sh -c`, granting full host OS access scoped to the working directory. Only enable it in sandboxed environments (containers, CI).

```typescript
// Default: bash blocked even if definition requests it
const client = new UluOpsClient({});

// Explicit opt-in for containerized environments
const client = new UluOpsClient({
  allowedTools: ['bash'],
});
```

Or via environment variable:

```bash
ULUOPS_ALLOWED_TOOLS=bash
```

### Filesystem Sandboxing

The `ToolHandler` restricts LLM file operations to the target directory:

- Path traversal prevention with separator-aware prefix matching
- Symlink resolution via `fs.realpath()` to detect escape attempts
- Fail-closed on filesystem errors (dangling symlinks, race conditions)
- macOS `/tmp` → `/private/tmp` symlink handling

### Preflight Checks

CDL command definitions can declare prerequisite checks (file existence, git state, tool availability) that run before agent execution. Preflight `command` checks:

- Execute in the **target directory** (`cwd = input.target`), matching the execution context of `file_exists` and `git_clean` checks
- Are restricted to a **read-only allowlist**: `test`, `git`, `grep`, `find`, `ls`, `cat`, `head`, `tail`, `wc`, `which`, `command`, and shell built-ins (`[`, `true`, `false`, `echo`)
- Reject shell metacharacters (`;`, `|`, `&&`, `` ` ``, `$()`), interpreter eval flags (`-e`, `-c`), and chaining operators
- Quote `$ARGUMENTS` substitutions via `shellQuote()` to prevent CWE-78 injection

Package managers (`npm`, `pip`), orchestrators (`docker`, `kubectl`), build tools (`make`, `cargo`), and interpreters (`node`, `python`) are **not permitted** in preflight — they have broad side-effect authority that doesn't belong in prerequisite checks. The security boundary for preflight commands is supply-chain trust in the definition author, not runtime effect confinement.

### Stage Steps (opt-in)

PDL pipeline stages can declare inline shell `steps:` blocks (detection preflights, build gates). The engine executes them **only when the operator opts in** via `allowStageSteps: true` (or `ULUOPS_ALLOW_STAGE_STEPS=true` — the exact string `true`). This is the same trust boundary as the `bash` tool: step commands come from resolved definitions, so running them is definition-author-controlled shell on your host. **The opt-in is the boundary — there is no command allowlist.** With the opt-in off (the default), steps-only stages pass through as `PASS` with a `null` score (excluded from pipeline score aggregation) and their steps are not run.

Confinements applied to executed steps:

- **Secret scrubbing** — env vars matching secret-class patterns (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS`, `AWS_*`, `GOOGLE_*`, `AZURE_*`, `ANTHROPIC_*`, `OPENAI_*`) are removed from the environment steps inherit
- **`step.env` restrictions** — keys overriding loader vectors or lookup paths (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH`) fail the step
- **`working_dir` containment** — resolved within the target root and verified via `realpath`; execution occurs at the resolved real path
- **Resource caps** — per-step timeout (default 60s), `retries` capped at 10, `retry_delay` capped at 60s, output retained up to 8KB per step
- **Template quoting** — `{{ params.x }}` / `{{ params.x || fallback }}` substitutions (from `ExecutionInput.params`; `target` is implied) are shell-quoted (CWE-78); commands with unresolved templates fail the step rather than executing literal braces

Per-step results (`name`, `status`, `exitCode`, `output`, `durationMs`) are returned on `StageResult.steps`. A step failure fails the stage's decision unless the step declares `continue_on_error`; steps marked `always_run` execute even after an earlier hard failure. Note: the opt-in is a **config/env** control — the per-run `ExecutionOptions.allowStageSteps` override applies only to direct `PipelineExecutor` callers (Advanced Exports), not to `runPipeline()`/`startPipeline()`/`run()`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@uluops/sdk-core` | Shared HTTP infrastructure (HttpClient, errors, auth) |
| `@uluops/registry-sdk` | Registry API client for definitions, models, and server-side normalization (`?normalize=true`) |
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

# Run tests
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

## Maintainers

- **Alex Self** ([@aself101](https://github.com/aself101)) — architecture, execution engine, AI integration
- **Claude** (Anthropic) — implementation, validation, documentation

## License

MIT — Copyright (c) 2026 Uluops. See [LICENSE](LICENSE) for details.
