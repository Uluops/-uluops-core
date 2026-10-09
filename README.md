**[UluOps](https://uluops.ai)** · The operations layer for agentic work

---

# @uluops/core

[![npm version](https://img.shields.io/npm/v/@uluops/core.svg)](https://www.npmjs.com/package/@uluops/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/@uluops/core)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](test/)

The foundational execution engine for UluOps. Orchestrates AI-powered code analysis through a 4-layer execution hierarchy (Agent > Command > Workflow > Pipeline), manages LLM tool loops via Vercel AI SDK, and integrates with the UluOps registry and tracker — every run's findings become tracked issues with fingerprints, so a resolved finding that comes back is a regression, not a new issue.

## Prerequisites

- **Node.js 20.3+** with an ESM project (`"type": "module"` in package.json)
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

> **Plain JavaScript.** The snippet above contains no TypeScript-specific syntax — save it as `validate.mjs` (or `validate.js` in a `"type": "module"` package) and run `node validate.mjs`. The offline snippet below is likewise valid JS as written. `tsx` is needed only once you add type annotations.

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
  - [Result Tracking](#result-tracking)
  - [Extended Thinking](#extended-thinking)
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
- **Multi-Provider AI** - Anthropic-first with deepest optimization (caching, context management, bash tools); OpenAI + Google bundled; Mistral, Cohere, and 10+ others via dynamic `@ai-sdk/*` import; OpenRouter (experimental) via `@openrouter/ai-sdk-provider`. See [SCOPE.md](https://github.com/Uluops/-uluops-core/blob/main/SCOPE.md) for provider strategy.
- **Filesystem Sandboxing** - ToolHandler restricts LLM file access to the target directory with symlink-aware path validation
- **Content-Addressed Integrity Verification** - Registry-resolved definitions carry a SHA-256 YAML content hash (`sha256:…`) and, for agents/commands, a `promptHash` over the frozen rendered prompt. Hashing uses the shared `@uluops/sdk-core` implementation, so the client and registry hash identically. Remote resolution executes the **frozen `runtimeMd`** the `promptHash` certifies (not a live re-render). Callers can pin `expectedHash`/`expectedPromptHash` (from a trusted channel) on `resolve()`/`ExecutionOptions`; pins are verified **fail-closed** on every resolve path (cache/local/remote) and a mismatch throws `IntegrityError`. Verification is opt-in — unpinned resolves behave as before. See [Integrity Verification](#integrity-verification).
- **Universal Agent Output** - Single `agentOutputSchema` with categories + artifacts for all 6 agent types (validator, executor, analyst, generator, explorer, forecaster)
- **Structured Output Extraction** - 4-strategy fallback: AI SDK structured output > JSON code fence > inline JSON > regex text parsing
- **Result Tracking** - Automatic submission of every run's findings to the tracker: issue correlation by fingerprint, regression detection, per-agent execution recording, and analytics
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

Required for registry and tracker access:

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

### OpenRouter (experimental)

Route any OpenRouter model through core with an `openrouter:<slug>` model string. Install the
provider yourself, at the version core is built against:

```bash
npm install @openrouter/ai-sdk-provider@2.10.0
export OPENROUTER_API_KEY=your_openrouter_key   # auto-detected like the keys above
```

```typescript
// `client` is the UluOpsClient from Quick Start.
const result = await client.runAgent('code-validator', './src', {
  model: 'openrouter:deepseek/deepseek-v4-flash',
});
```

> **Data governance.** Every file the agent reads, and every shell command's output, is sent to
> OpenRouter and on to whichever upstream provider serves the request. OpenRouter itself retains
> no prompts unless you opt in to its prompt logging; the upstreams differ. **Since 0.49.0 core
> sends `provider.data_collection: 'deny'` by default**, so only upstreams that do not retain or
> train on your data are eligible. Fewer endpoints qualify; when none does (OpenRouter's routing
> step "Filter by Data Policy" — typical of `:free` models), the run fails with a `CapabilityError`
> that names `provider.data_collection = 'deny'` and how to opt in.
>
> To opt in for one run, pass it per request in `runAgent`'s options:
> `providerOptions: { openrouter: { provider: { data_collection: 'allow' } } }`. Commands,
> workflows, pipelines and the CLI take no `providerOptions`; for them the levers are
> `ai.openRouterDataCollection: 'allow'` in the client config or `OPENROUTER_DATA_COLLECTION=allow`
> in the environment, and both apply to **every** run that client or shell makes. While `allow` is
> in effect, the first OpenRouter request it applies to from each lever logs a warning naming that
> lever. Per request beats config, config beats the environment. At every layer an empty or null
> value means unset; any other value than `allow`/`deny` means `deny` at that layer — it does not
> fall through to a lower layer's `allow`.
>
> These levers are a preference, not a lock: a more specific one always overrides a less specific
> one, so an environment `deny` cannot stop an embedding app's `allow`. To **enforce** deny, use
> your OpenRouter account's privacy settings (openrouter.ai/settings/privacy), which apply on top of
> all of this. `deny` is OpenRouter's per-provider data-policy flag, not zero data retention: for
> the strictest routing add `zdr: true` (zero-retention endpoints only) and pin upstreams with
> `provider.only`. Core keeps any `provider` fields you set and adds its own `require_parameters`.

- **Pin 2.10.0.** The package's npm `latest` is 3.x, which targets `ai@7`; core runs `ai@6` and
  refuses a different major at load with an error naming both versions. Under strict pnpm
  isolation the package must be hoisted, because core resolves it with a dynamic `import()` from
  its own install location (the same as the other non-bundled providers).
- **Catalog data.** OpenRouter slugs resolve against the registry catalog (core 0.45.0+), so a
  listed slug gets its real capabilities, context window and price. A slug the catalog does not
  list runs on defaults and the run carries an info marker, `model.unregistered-defaults`
  (programmatic callers of `AIProvider.generate()` also get `modelRegistered: false` on the result).
- **Routing guards.** Core always sends `provider.require_parameters: true` (route only to
  endpoints that support every parameter sent, the only capability guard for a routed model) and
  `usage.include: true`; caller options cannot turn either off. Extended thinking is opt-in (see
  [Extended Thinking](#extended-thinking)): when it is on, a capable model gets
  `reasoning.max_tokens` from `defaultThinkingBudget`, and `anthropic/…` models also get a raised
  `max_tokens` and the interleaved-thinking beta. Adding `reasoning` narrows the endpoints
  `require_parameters` admits; a no-endpoint error names it and the switch that turns it off.
- **Shell.** OpenRouter has no provider-defined shell tool, so routed agents that request `bash`
  get a schema-fallback `bash` tool. The `allowedTools` gate applies exactly as for Anthropic's
  native tool (`bash` stays off unless you allow it), and runs offered it carry an info marker,
  `tools.shell-schema-fallback`. Commands run unsandboxed in the target directory, as with the
  native tools, but are generated by whichever upstream OpenRouter routed to; allow `bash` only
  with upstreams pinned (`provider.only`) and a target you would let that model run commands in.
- **Errors.** Each OpenRouter failure arrives typed (core 0.48.0+):
  - **Out of credit (402)** is a `ProviderCreditError` carrying OpenRouter's `limitSource` and its
    own text. A **pre-flight** refusal ("can only afford N") means the balance cannot cover this
    request's worst case (`maxTokens` × price): lowering `maxTokens` works, credit remains.
    Otherwise the credit or the key's limit is spent. Inside a pipeline a 402 **stops the whole
    run and fails it**: later stages are skipped, in-flight siblings are aborted, the run ends
    `failed` (decision `FAIL`), and `wait()` / `runPipeline` throw a `PipelineError` whose message
    is the provider's text. A user `cancel()` still ends `cancelled`. Only the agent that
    received the 402 keeps a failing record (one critical recommendation carrying the provider's
    text); the siblings the stop aborted are recorded `ABORTED` — see
    [Stopped agents](#stopped-agents-aborted).
  - **Outside a pipeline** there is no run to stop. `runAgent` and single-agent commands reject
    with `ProviderCreditError`. A multi-agent command or a workflow contains a failing agent the
    way it contains any crash: the result carries a failing verdict and a crash recommendation
    whose title includes the provider's text, and it throws only if every agent failed.
  - **Spend on a 402 mid-run is not recorded.** The completed requests of an agent that hit the
    402, and of siblings the stop aborted, are not carried across the throw, so the run's cost
    reads `unpriced` (see [Cost](#cost)).
  - **No endpoint (404)** is a `CapabilityError` naming the routing step and every constraint the
    request carried: the parameters `require_parameters` holds endpoints to, any `provider.only` /
    `ignore` / `quantizations`, and for an allowed-providers miss, the providers that do serve
    the model.
  - **Unknown slug (400 "is not a valid model ID")** is a `ModelNotFoundError` naming the slug.
  - **Rate limited (429)** is a `RateLimitError` whose `retryAfter` (seconds) comes from
    OpenRouter's `X-RateLimit-Reset`, since it sends no `retry-after`; the message names whose
    limit it was (`limit_source`).
  - A context-length 400 on an uncatalogued slug names the budget it ran with, and an error
    OpenRouter returns inside an HTTP 200 body maps by its own code.
- **Cost.** OpenRouter's billed amount is summed per request into `costUsdBilled`, and
  `costUsdTotal` prefers it over the registry estimate (see [Cost](#cost)). On a BYOK request the
  upstream provider's charge is added; on a normal one it is not, since OpenRouter reports the same
  figure twice there.
- **Not yet:** route tagging in the Tracker. A routed run is recorded under its
  `openrouter:<slug>` model string.

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

- **`completeness`**: `'complete' | 'partial' | 'failed'`, derived from degradation markers (any `critical` ⇒ `failed`; any `degraded` ⇒ `partial`; else `complete`). Absent ⇒ treat as `complete`. **`PASS` + `partial` is a legitimate, gate-satisfying pass** (decided 2026-07-10, recorded in `types/degradation.ts`): the agent passed the scope it could cover — forced wrap-up and context eviction are normal operation on large repos. Gates never downgrade on completeness; consumers that care about evidence span read `completeness` alongside the decision.
- **`degradationMarkers`**: typed `{ code, phase, severity, detail? }[]`. `code` is the stable contract (e.g. `budget.forced-wrap-up`, `context.evicted`, `steps.near-exhaustion`, `extraction.low-confidence`, `usage.provider-metadata-shape-drift`, `provider.warnings`, `model.unregistered-defaults`, `tools.shell-schema-fallback`, `render.raw-yaml-fallback`); `detail` is human-only — never match on it. `phase` is `'resolution' | 'execution'`.

  > **`budget.forced-wrap-up` is emitted only when the wrap-up brake could actually engage.**
  > On an Anthropic structured-output run the provider overrides `toolChoice` to select its
  > json tool, so the brake is inert — see the `contextBudget` caveat under
  > [Configuration](#configuration). Before 0.42.0 the marker latched anyway, so a complete
  > run was reported `partial` for a wrap-up that never happened. It no longer does; the
  > budget crossing is still logged at `warn`, naming the reason the brake could not act.
- The engine *observes* completeness from how the run actually executed; agents never self-report it. `deriveCompleteness(markers)` is exported if you want to recompute it.
- **`decisionCategory`**: the vocabulary-resolved category of `decision` (`'positive' | 'negative' | 'conditional' | 'neutral'`), stamped on every result. For custom-vocabulary agents (cognitive lens agents, WDL-remapped workflow decisions) gate on this — or on `resolveDecisionCategory(result)` — instead of the raw decision string. See [Decision Classification](#decision-classification).
- `degradations: string[]` is the deprecated legacy alias (resolution-phase strings only), retained for compatibility — prefer `degradationMarkers`.

> Empty-output step exhaustion is a thrown [`MaxStepsExhaustedError`](#error-handling), not a marker; near-exhaustion *with* output is the `steps.near-exhaustion` marker.

### Command Execution

Execute saved command configurations. Uses model, thresholds, and aggregation from the command definition. Ideal for CI/CD:

```typescript
const result = await client.runCommand('validate', { target: './src' });

// Override the definition's default model at runtime (e.g., for CI cost control)
const fast = await client.runCommand('validate', { target: './src' }, { model: 'haiku' });

// CI: pin the definition so a mutated registry entry is refused, not executed
// (see Integrity Verification). Strongly recommended when `bash` is enabled.
const pinned = await client.runCommand('validate', { target: './src' }, {
  expectedHash: 'sha256:…',
  expectedPromptHash: 'sha256:…',
});

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
// `params` supplies run parameters read by stage/agent `condition:` expressions
// and by `{{ params.x }}` substitutions in stage `steps:` commands.
// An absent param reads as false in a condition (see below).
const result = await client.runPipeline('foundations', {
  target: './src',
  params: { frontend: true, tier: 'pro' },
});

console.log(`Overall: ${result.decision} (score: ${result.score})`);
for (const stage of result.stages) {
  console.log(`  ${stage.name}: ${stage.status}`);
}
```

**Stage & agent conditions.** A stage's `condition` (and per-agent `agents[].condition` in inline-agent stages) is a **run-gate**: the stage or agent runs when the expression holds and is skipped when it is definitively false. Conditions can read run parameters (`params.frontend`, passed via `ExecutionInput.params`) and prior-stage results, including executed step outputs (`stages.preflight.steps['Detect TypeScript'].output == 'DETECTED'`). **An absent param is `false`** (so `!params.x` is `true` and `params.x || <detection>` gates on detection alone when `x` is unset) — param absence is a normal caller state. Unresolvable expressions of other kinds — missing stage/step path, unsupported namespace, or over the length cap — **fail open**: the stage runs and a warning is logged. `skip_if` is deprecated (skip-if-true semantics). See the PDL spec for the full expression grammar.

**Stage output forwarding (0.31.0, ON by default).** Any inline-agent stage with `depends_on` automatically receives an `## Upstream Analysis` section in each of its agents' initial messages — a severity-sorted slice (decision, `decisionCategory`, score, summary, top-5 recommendations) of every dependency's results, placed after the operator `Directive:` and before the project context. Forwarding is one hop (direct dependencies only) and never flows between parallel siblings. Controls:

```yaml
stages:
  - id: gate            # producer-side opt-out: this stage's outputs are never forwarded
    forward: none
  - id: deep-analysis   # escalation: also forward head+tail-retained rawOutput (16K+8K chars)
    forward: full
  - id: synthesis
    depends_on: [deep-analysis]
    # receives: none    # consumer-side opt-out: depend for ordering only
```

Caps (provisional; exported as `UPSTREAM_STAGE_SLICE_CAP` 8K / `UPSTREAM_STAGE_FULL_CAP` 24K / `UPSTREAM_TOTAL_CAP` 32K chars) reduce deterministically — findings first, then narratives; stage headers and verdict lines are never dropped, and all truncation is marked in-place. Fleet-wide kill switch: `ULUOPS_DISABLE_STAGE_FORWARDING=1` (or `true`). The forwarded slices ride `ExecutionInput.upstreamContext` (type `UpstreamStageContext`) — engine-populated; not an operator input.

**Stage gates.** A stage's `gate:` block (PDL `$defs/gate`) controls pipeline flow after the stage completes. The gate *fails* when the stage's vocabulary-resolved decision is negative, the stage errored, or — when `threshold` is set — the aggregated score falls below it (`aggregate: min | max | average` over inline-agent scores, default `min`; ref-based stages use the stage result score; scoreless stages are fail-open for the threshold check only). What happens next is the gate's flow action:

```yaml
stages:
  - id: build-gate
    steps: [...]
    gate:
      on_failure: abort      # hard stop: remaining stages skipped, run fails (PDL default)
  - id: validate
    ref: ship@1.0.0
    gate:
      threshold: 70          # score gate on top of the decision gate
      aggregate: min
      on_failure: warn       # log and continue
      # on_failure: skip     # skip remaining stages, run still completes
      # on_success: skip_remaining  # early exit when the gate passes
```

`on_failure: abort` surfaces as a thrown `PipelineError` from `wait()`/`runPipeline()` carrying the partial result; skipped stages are recorded with `skipReason: 'gate_abort' | 'gate_skip' | 'gate_early_exit'`. Note: an abort-gated `steps:` stage that cannot execute because `allowStageSteps` is off **fails the run loudly** instead of passing through — an unexecutable mandatory gate is a configuration error (see [Stage Steps](#stage-steps-opt-in)).

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

// Or cancel — aborts the in-flight provider request, not just the stage loop.
// The running agent's HTTP call ends; the run reports `status: 'cancelled'`.
await handle.cancel();
```

Pass your own `abortSignal` on `ExecutionOptions` to tie a run to a lifetime you already
have (an inbound request, a parent job). It is **merged** with the pipeline's own signal,
not replaced, so `handle.cancel()` keeps working on the same run. An explicit `abort()` of your
signal stops the run exactly like `cancel()` — status `cancelled`, later stages skipped — and a
`cancel()` on a cancelled run, or while any stopped run is still unwinding, is a no-op. A **deadline** is different: if your signal is
`AbortSignal.timeout(ms)` (its abort reason is a `TimeoutError`), the run ends **`failed`**,
`wait()` throws a `PipelineError` naming the deadline, and the agents still in flight are
recorded as crashes — the slow agent is the likeliest broken one, so a deadline is never filed
away as a neutral stop. (Before the release that added stopped-agent recording, your own signal
aborted the provider calls but left the run `running`, so later stages were dispatched against a
dead signal and the run could end `completed`.)

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

### Result Tracking

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

`response.correlation` carries counts. The per-finding detail — which recommendation matched which existing issue by fingerprint, and which resolved issue a run caught again — is typed here as `FingerprintedRecommendation` and `RegressionInfo` (re-exported from the package root) but is read from the tracker through `@uluops/ops-sdk` directly (`runs.get`, `issues.getHistory`); core submits, it does not fetch it back.

> `allGatesPassed` on history entries and run reads is `boolean | null` (since
> v0.34.0): `null` = **NOT_A_GATE** — the run carried no gate-bearing agents
> (e.g. a cognitive-lens-only run), distinct from `false` (a gate ran and
> failed). Render `null` neutrally and exclude null runs from pass-rate math.
> Submission *inputs* are unchanged — the client still asserts an explicit
> boolean verdict; `null` is never a valid input value.

On the auto-tracking path, a failed submission (e.g. a free-tier `402 PROJECT_LIMIT`, `SUBSCRIPTION_REQUIRED`, or a transient 5xx) is **non-fatal** — the agent run still resolves successfully. The result carries `trackingFailed: true` plus a typed `trackingError` (`{ code, statusCode, message, requestId, details }`), so callers can surface the reason — and any `details.upgradeUrl` — instead of silently dropping the dashboard link. `code` (e.g. `PROJECT_LIMIT`) is the stable contract; `message` is human-readable and should not be matched on.

**What lands in analysis data.** At submission time, `AnalysisSummaryExtractor` builds the run's `analysisSummary` + `analysisRecords`:

- `systemMetrics` carries the agent's **cognitive measurements only** — its analysis-block `system_metrics`, else structured-output `domainMetrics`, else `null`. Execution telemetry (tokens, model, duration) is never merged in; it travels on `agents[]`.
- Extraction facts (`extraction_confidence`, `extraction_method`) are epistemic facts about the parse and merge into `epistemicAssessment` — the agent's own keys always win.
- **Every agent-authored field on a record is sanitized against the API's storage contract, at one seam, for all four extraction tiers** (v0.36.0). The tracker validates the *whole* `analysisRecords` array before the network, so a single out-of-contract value used to lose the entire run's analysis rather than one record. Each field is normalized in the way that preserves the most meaning, and anything rejected is kept under a `raw*` key rather than dropped:

  | Field | Contract | On violation |
  |---|---|---|
  | `severity` | the tracker enum | case-normalized; register-style values (`structural`, `NOTABLE`) → `null`, original in `data.rawSeverity` |
  | `recordType` | non-empty, ≤50 | trimmed and lowercased; **no vocabulary check** — see below; unusable → `evidence_finding`, original in `data.rawRecordType` |
  | `title` | non-empty, ≤500 | prose, so **truncated** to the bound with the full text in `data.rawTitle`; blank → `(untitled record)` |
  | `classification` | ≤50, optional | categorical, so **nulled** rather than truncated — a clipped category is a different category — original in `data.rawClassification` |
  | `data` | a plain object | entries-form `[{key,value}]` converted; any other array, primitive or `null` → `{}` or `{ rawData }` |

  `recordType` is deliberately **not** checked against a fixed vocabulary. The tracker stores it as a bounded string so registry-defined agents can emit new record shapes without a coordinated release; this package used to re-narrow it client-side against a 47-value set and silently rewrite anything outside it to `evidence_finding`. If you consume `recordType`, expect a materially wider set than before v0.36.0 — 307 distinct values were already in storage from other write paths.

### Usage Metrics

All execution results include token usage metrics. Provider-specific token fields are mapped to a unified format:

```typescript
const result = await client.runAgent('code-validator', './src');
const { metrics } = result;

console.log(`Input: ${metrics.inputTokens}, Output: ${metrics.outputTokens}`);
console.log(`Cache: ${metrics.cacheCreationTokens ?? 0} created, ${metrics.cacheReadTokens ?? 0} read`);
console.log(`Harness: ${metrics.harness ?? 'unknown'}`); // producing runtime ('uluops-core'), v0.26.0

// inputTokens is CACHE-EXCLUSIVE — input the model processed fresh, excluding cache reads
// and writes. It is NOT the provider's headline input count (AI SDK v6 reports that as a
// cache-INCLUSIVE total); do not subtract a cached figure from it again, or you undercount.
// cachedInputTokens is a recorded component only and no longer participates in the total.
// reasoningOutputTokens (OpenAI) and thinkingTokens (Google) are subsets of gross
// outputTokens — exposed for cost breakdown only, NEVER added (the AI SDK already folds them in).
if (metrics.cachedInputTokens) console.log(`Cached input: ${metrics.cachedInputTokens}`);
if (metrics.reasoningOutputTokens) console.log(`Reasoning: ${metrics.reasoningOutputTokens}`);
if (metrics.thinkingTokens) console.log(`Thinking: ${metrics.thinkingTokens}`);

// Canonical: inputTokens (cache-exclusive) + outputTokens (gross) + cacheCreationTokens.
// Summed across every step of the tool loop, not just the last one.
console.log(`Effective total: ${metrics.totalEffectiveTokens}`);

// Provider warnings — settings the provider could not honor (unsupported parameter,
// clamped max_tokens, unknown context-management strategy). Provider option schemas
// STRIP unknown keys rather than rejecting them, so a warning is the only runtime
// evidence that a request setting silently didn't apply.
//
// On an AgentResult these surface as an info-severity degradation marker (the same
// route usage.provider-metadata-shape-drift takes). The raw string[] lives on
// AIGenerateResult if you are calling AIProvider.generate() directly.
const warned = result.degradationMarkers?.filter((m) => m.code === 'provider.warnings');
if (warned?.length) {
  console.warn('Provider warnings:', warned.map((m) => m.detail));
}
```

### Cost

Every result level (agent, command, workflow, pipeline, stage) carries four cost fields:

| Field | Meaning |
|---|---|
| `costUsd` | The registry **estimate**: usage priced at the catalog's rates. `undefined` when any child's model is unpriced. |
| `costUsdBilled` | The **billed** amount, summed over every request. Only OpenRouter reports one today. On a BYOK request it is OpenRouter's charge **plus** the upstream provider's charge to your own key — total spend across both invoices, not OpenRouter's invoice alone. `undefined` unless every request reported it. |
| `costUsdTotal` | The **best available** total: per agent the bill if there is one, else the estimate; per parent the sum of children's totals. `undefined` only when some child has neither. |
| `costBasis` | What `costUsdTotal` is made of: `'billed'`, `'estimated'`, `'mixed'`, `'unpriced'` (no total), or `'none'` (no model was called, e.g. a steps stage; the total is a real 0). |

```typescript
const { costUsdTotal, costBasis } = result.metrics;
// Six decimals: a single OpenRouter request can bill $0.000003, which toFixed(4) shows as $0.0000.
console.log(costUsdTotal === undefined ? 'cost unknown' : `$${costUsdTotal.toFixed(6)} (${costBasis})`);
```

Read `costUsdTotal` for spend, and `costUsd` and `costUsdBilled` side by side to reconcile the
estimate against the bill. Reconcile against an invoice only when `costBasis` is `'billed'`: a
`'mixed'` total adds bills to estimates. Limits worth knowing:

- **Cost is in-process only.** The Tracker wire format has no cost field, so none of the four is
  submitted with a run; the client logs a warning on each run that carries one.
- **A failed or cancelled agent has no cost figure at all.** The in-flight request's cost is
  unknowable and the completed requests' totals are not carried across the throw, so the agent
  reads `'unpriced'` and every parent above it does too (no total). Money was spent; core cannot
  say how much. The exception is an agent stopped by the step ceiling
  (`MaxStepsExhaustedError`), whose requests all completed: it keeps its real cost and basis.
- **A structured-output fallback is not a failure.** When structured output cannot be parsed and
  the run falls back to text extraction, every request has already completed, so it keeps its
  billed figure under the same every-request rule.
- **SDK retries are invisible.** A request the AI SDK retried is billed but never reported to
  core, so both figures can understate a run that hit retries.

### Extended Thinking

**Off by default; opt in per client or per run** (core 0.51.0+). Thinking is billed as output on
every step of a tool loop, and scores measured with it are not comparable with scores measured
without it, so nothing turns it on for you.

| Lever | Values | Notes |
|---|---|---|
| `runAgent(name, target, { extendedThinking })` | `true` / `false` | Wins over everything below. `runAgent` only — commands, workflows and pipelines take the client setting. Any non-boolean (the string `"false"` included) is off with a warning. |
| `ai.extendedThinking` | `'on'` / `'off'` | Every run this client makes. Booleans are malformed here (off + warning). |
| `ULUOPS_EXTENDED_THINKING` | `on` / `off` | Same, from the environment; the config field wins. A value in a `.env` file the CLI loaded is sticky across runs — the CLI warns when that is where it came from. |

A malformed value at any layer is **off at that layer** and does not fall through. A
provider-native option you pass yourself (`providerOptions.openai.reasoningEffort`,
`google.thinkingConfig`, `openrouter.reasoning`, `anthropic.thinking`) always wins and is not capped.
An explicit native "off" (`thinking: {type:'disabled'}`, `reasoningEffort: 'none'`,
`thinkingBudget: 0`, `reasoning: {enabled: false}`) is recorded as not applied (`'caller-native'`);
any other native thinking option is recorded as applied from source `'native'`, and logs a notice.

What "on" sends, per provider, on a model that can think (`capabilities.reasoning`, or the
`reasoning` tier):

| Provider | Sent | Caps |
|---|---|---|
| OpenAI | `reasoningEffort: 'medium'` | — (effort, not budget; `defaultThinkingBudget` is ignored) |
| Google | `thinkingConfig.thinkingBudget` | Capped at half of `maxTokens`: Gemini counts thinking inside `maxOutputTokens`, and a budget at the cap leaves almost no answer. |
| OpenRouter | `reasoning.max_tokens` | Capped so the answer keeps at least half of `maxTokens` (budget ≤ sent `max_tokens` − ½ `maxTokens`) — OpenRouter counts thinking inside `max_tokens`, and a budget at or above it is not rejected: OpenRouter silently raises the cap and bills past it. On `anthropic/…` models `max_tokens` is raised by the budget (up to the model's output limit) and the interleaved-thinking beta is sent, so tool steps after the first can think too (probed: `claude-sonnet-4.5` thought on every step; the adaptive `claude-sonnet-5`, `claude-opus-4.8` and `claude-haiku-5.5` accepted the request and thought on some steps, choosing how much themselves; other `anthropic/` ids unprobed). |
| Anthropic (direct) | nothing in 0.51.0 | Mapped in 0.52.0, with the structured-output degrade it needs (Anthropic rejects thinking with forced tool use). Until then a run records "not applied: no-mapping". |
| Others | nothing | Recorded "not applied: no-mapping". |

Below a 1024-token budget after capping, nothing is sent and the run records `'invalid-budget'`.

**"Off" means the provider default, not "no thinking".** Off sends nothing — and gpt-5 and gpt-5.5
reason anyway (measured); Gemini 2.5, DeepSeek/xAI reasoners and the always-thinking Claude models
(Sonnet 5.5, Opus 5.5, Fable 5) are expected to. Those runs record `offMeans: 'provider-default'`, by
heuristic (upstream plus the provider's always-thinking list), not by measurement — read
`thinkingObserved` for what the tokens showed.

**Every agent result records what happened**, on `result.runConditions`: what was requested, from
which layer, whether a thinking option was actually sent (`thinkingApplied`) and why not, the budget
sent, whether the interleaved beta was sent, the `max_tokens` core sent when it raised it
(`maxTokensSent` — a thinking-on run that scores better may simply have had more room), and whether
thinking tokens were observed (`thinkingObserved`). Crash and stopped-run placeholders carry it too, from the error
(`thinkingOutcomeOf(error)`). It is in-process only: the tracker does not receive it yet.

The applied-keyed notice: a run that requested thinking logs one line — "on" when it was sent and a
warning naming the reason when it was not. Thinking turned on by the environment, or by your own
provider-native options, warns once per client (then debug), so a pipeline does not repeat it for every
agent. The info-level "on" line for request- and config-sourced thinking shows only with `debug: true`.

**Not covered by the switch: the agent's model choice.** An agent definition's `defaults.model`
outranks the client's model choice, so a definition naming a model that reasons by default is billed
reasoning even with thinking off. The counter is `ai.modelOverride`. Thinking cost appears in
`costUsd` like any output (see [Cost](#cost)); reasoning tokens are in `reasoning_tokens`
(OpenAI, OpenRouter, Anthropic) or `thinking_tokens` (Google).

**Release order.** `@uluops/registry-sdk` 0.61.0 started surfacing the `reasoning` capability that
the registry always served. Core 0.50.0 and older auto-enable thinking wherever that capability is
set; a consumer that injects registry-sdk 0.61.0 into an older core's public `ModelCatalog` turns
that on. Upgrade core and the SDK together (core pins the SDK exactly, so a plain install is safe).

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

- **Every execution entrypoint accepts pins**: `runAgent`/`runCommand` take them in their options/overrides; `runWorkflow`/`runPipeline`/`startPipeline`/`run` take a trailing `ResolvePinOptions`. Pipeline pins cover the pipeline YAML only — stage refs are resolved separately downstream and are not individually pinned (per-stage pinning is lockfile territory).
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
  resolveDecisionCategory, // Aggregation-safe gating — prefers the result's stamped decisionCategory over raw-string classification
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
  DEFAULT_TEMPERATURE,     // 0     — default sampling temperature (omitted for reasoning models)
  STARTER_DEFINITIONS_DIR, // bundled starter definitions directory (offline quick start)
} from '@uluops/core';
```

Upstream stage-forwarding bounds (see [Stage context forwarding](#pipeline-execution)) are exported
from the same entry point:

```typescript
import {
  UPSTREAM_STAGE_SLICE_CAP,      // per-stage cap for the default recommendation slice
  UPSTREAM_STAGE_FULL_CAP,       // 24000 — per-stage cap when the producer declared `forward: full`
  UPSTREAM_FULL_HEAD_CHARS,      // 16000 — head retained from a `forward: full` rawOutput
  UPSTREAM_FULL_TAIL_CHARS,      //  8000 — tail retained; the middle is the safest loss
  UPSTREAM_TOTAL_CAP,            // 32000 — cap on the whole `## Upstream Analysis` section
  UPSTREAM_MAX_RECOMMENDATIONS,  // 5     — recommendations forwarded per upstream agent result
  UPSTREAM_KILL_SWITCH_ENV,      // env var name that disables forwarding fleet-wide
} from '@uluops/core';

// Prefer the constant over the literal string, so the name stays in one place:
process.env[UPSTREAM_KILL_SWITCH_ENV] = '1';
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
  abortSignal: controller.signal,   // optional — ends the provider request, not just the loop
});
```

`abortSignal` is accepted the same way by the other executors, so a single signal can end a
whole composition:

```typescript
const controller = new AbortController();

// Command: on the overrides argument
await commandExecutor.execute(resolved, input, { abortSignal: controller.signal });

// Workflow: an optional third argument
await workflowExecutor.execute(resolved, input, { abortSignal: controller.signal });

// A single-agent command and runAgent reject with CancelledError. A multi-agent command, a
// workflow and a pipeline RETURN, recording each stopped agent as ABORTED (see below).
controller.abort();
```

#### Stopped agents (`ABORTED`)

An agent stopped by a stop of its run — `handle.cancel()`, a provider-credit trip, or an
explicit `abort()` of an `abortSignal` you supplied — is **not completed**, not crashed. It is recorded with
decision `ABORTED`, `decisionCategory: 'neutral'`, `score: null`, **no recommendation** (so no
tracker issue), a cause-free `summary` (`Not completed: …`), a critical `execution.run-stopped`
degradation marker and `completeness: 'failed'`. Its cost is `unpriced`: the spend of a request
aborted mid-stream is unknown. The cause is stated once, on the run: `status: 'cancelled'` for a
cancel, the thrown `PipelineError` (and the originator's own crash record) for a 402.

Test for it with the exported predicates rather than the string. `isAbortedRecord` is true for
a synthesized agent record; `isStoppedResult` also matches a command, stage or workflow that core
aggregated to `ABORTED` (those carry their real version, plus an `execution.run-stopped` entry in
`degradationMarkers` — the predicate keys on that, because a model can output the word `ABORTED`
itself):

```typescript
import { isAbortedRecord, isStoppedResult } from '@uluops/core';
const stoppedAgents = result.stages.flatMap(s => s.agentResults ?? []).filter(isAbortedRecord);
const stoppedStages = result.stages.filter(s => s.result && isStoppedResult(s.result));
```

**Crash decides.** Once a run stop has reached anything inside a command, stage, workflow phase or
workflow, that container gives no quality verdict: it is negative (`FAIL`, phase `'blocked'`,
`BLOCK`) if anything inside really crashed — a caller deadline's agents count as crashes — and
otherwise `ABORTED` / `neutral` (phase `'aborted'`). Score thresholds, lens caps and warn postures
(`on_fail`, `on_failure: warn`) judge finished work and do not apply to a stopped container.
**Finished work keeps its verdict:** the rule covers only the parts a stop reached. A workflow
phase that finished before the stop keeps its own verdict, so a stopped workflow is `BLOCK` if a
stopped phase crashed or a finished phase is `'blocked'`, and otherwise `ABORTED`. A pipeline
treats finished stages the same way: a stage that really failed before a user `cancel()` makes the
decision `FAIL`, and a cancel with no failure reads `CANCELLED`. So the same phases get the same
verdict as one workflow or as separate pipeline stages. A stop that fired but reached nothing
(it landed after the last work returned) leaves the verdict alone at every level; the pipeline's
`status` still records it. A phase whose every step crashed stays `'blocked'` even under
`on_failure: warn`, which softens only gate verdicts. Use `stopReached(result)` to ask whether a stop touched a result
or anything inside it. With `sum`, 90 plus a stopped agent under a 150 threshold is `ABORTED`, not `FAIL`. A panel whose agents were *all* stopped returns rather than throwing, and
a pipeline stage whose single agent was stopped is a completed stage holding an `ABORTED` record.
Genuine crashes — a timeout, a caller deadline, and the agent that received the 402 — keep the
critical crash placeholder. Phases a stop kept from starting are recorded `'aborted'`
(`'blocked'` under a deadline), never `'skipped'`, so a stopped workflow can never read `SHIP`. A
workflow whose only scored work sat in stopped phases reports `score: null`.

**Known gap (tracked separately):** the tracker reads a finding absent from a run as resolved.
A stopped run is missing its stopped agents' findings, and nothing on the wire yet says those
agents did not run — the same gap crash records already had.

### Model Resolution

```typescript
import { ModelCatalog } from '@uluops/core';

const catalog = new ModelCatalog(registrySdk);
const resolved = await catalog.resolve('sonnet', {
  requiredCapabilities: ['tools', 'reasoning'], // 'extendedThinking' is accepted as an alias
});
// → { provider: 'anthropic', modelId: 'claude-sonnet-4-...', providerModelId: 'claude-sonnet-4-...',
//      tier: 'premium', capabilities: {...}, registered: true, resolvedFrom: 'sonnet' }

// `registered` says whether the model was found in the registry catalog. `false` means no
// catalog row existed and `tier`/`capabilities` are fabricated defaults — the model may still
// be perfectly valid at the provider (private or preview access), so it is allowed through.
// It is what lets a provider 404 be explained correctly: registered + 404 means the catalog is
// STALE (retired upstream, not yet re-synced); unregistered + 404 means the name is likely
// wrong. Without it both cases are indistinguishable.
//
// NOTE: `registered` is REQUIRED on ResolvedModel as of 0.41.0. Reading a ResolvedModel is
// unaffected; if you CONSTRUCT one (test fixtures, adapters) you must add the field.

// Model ids containing '/' (OpenRouter slugs) resolve against their catalog row as of 0.45.0
// (registry-sdk 0.58.0 uses the registry's query-string lookup for them). Before 0.45.0 the
// lookup always missed and such ids resolved with registered: false and default capabilities.
const routed = await catalog.resolve('openrouter:anthropic/claude-haiku-4.5');
// → { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4.5', registered: true,
//      contextWindow: 200000, capabilities: {...}, cost: {...}, ... }

// Enumerate available models and aliases
const aliases = await catalog.listAliases();
const premiumModels = await catalog.listModels({ tier: 'premium' });

// Clear in-memory cache after registry admin syncs models
catalog.refresh();
```

> **Registry outages:** the well-known aliases (`sonnet`, `haiku`, `opus`) resolve
> from a baked-in fallback table when the registry is unreachable — transport
> errors only (a 404 still fails: the alias genuinely doesn't exist), never
> cached, default-deny capabilities (structured output disabled), loud warn.
> A cold CI runner survives a registry outage instead of failing before its
> first LLM call.

> **Route misses fail loudly (0.45.0+):** a registry 404 tagged `details.reason: 'route'`
> means the lookup matched no registry endpoint, so the catalog was never asked. `resolve()`
> throws `ConfigurationError` naming the input and the installed registry-sdk version, instead
> of resolving the model as unregistered with default capabilities. In practice this means a
> registry-sdk older than 0.58.0 asking for an id containing `/`. A 404 tagged `model` or
> `alias`, or with no reason, still means "not in the catalog" and behaves as before.

### Decision Classification

```typescript
import { classifyDecision, buildVocabularyMap, resolveDecisionCategory } from '@uluops/core';

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

// A definition's vocabulary can only classify CUSTOM terms — it cannot remap
// the core register. A vocabulary entry targeting a core string (e.g.
// positive: 'FAIL') is ignored, so a definition cannot relabel its own failure
// as a pass.

// Gating on a result? Use resolveDecisionCategory — every result carries a
// decisionCategory stamped by the executor that had the definition's vocabulary
// in hand. Raw-string comparisons (result.decision !== 'FAIL') silently pass
// custom-vocabulary negatives like EXPOSED or a WDL-remapped BLOCK.
const category = resolveDecisionCategory(result); // stamped category, else classifyDecision fallback
if (category === 'negative') {
  // handle failure — works for PASS/FAIL agents AND cognitive lens agents
}
```

**Aggregation semantics** (multi-agent commands and workflow phases):

- A **scoreless** child whose decision resolves `negative` fails the aggregate outright — it has no channel into the score average, so it gates categorically.
- A **scored** child whose decision resolves `negative` but whose score passes (a lens verdict like `DISORDERED@82`) caps the aggregate at `WARN`/`conditional` — never an unqualified `PASS`, never a hard `FAIL`.
- An **all-scoreless** panel (every child a generator/executor) aggregates to `null`, not `0` — no agent scored, so there is no score to report, and a `null` is fail-open at a threshold gate. A definition that asks for nothing is different: an authored-empty phase (`commands: []`) or workflow (`phases: []`) scores `0` and blocks, so a gate cannot pass unexamined.
- A **crashed** parallel agent synthesizes a negative placeholder and fails the command — a gate that couldn't run its full panel doesn't emit an unqualified positive. Survivors' scores are preserved; the crash surfaces as a critical recommendation.
- An agent **stopped** by a run stop (cancel, credit trip, caller signal) is recorded `ABORTED` instead — neutral, no recommendation — and makes the aggregate `ABORTED`/`neutral` unless a real failure is also present ([Stopped agents](#stopped-agents-aborted)).

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
    extendedThinking: 'off',           // 'on' | 'off' (default 'off'), or ULUOPS_EXTENDED_THINKING — see Extended Thinking
  },

  // Service URLs
  registryUrl: 'https://...',         // Registry API (or ULUOPS_REGISTRY_URL)
  submissionUrl: 'https://...',        // Submission API (or ULUOPS_SUBMISSION_URL)
  orgSlug: 'ulu-labs',                 // Org the run is saved under; omit = the workspace default (nearest .uluops.json, else ULUOPS_ORG_SLUG, else your personal org)

  // Behavior
  trackingEnabled: true,              // Auto-submit results to the tracker
  timeout: 300000,                    // Request timeout in ms
  defaultProject: 'my-project',       // Default project for result submission
  debug: false,                       // Detailed execution logging (or ULUOPS_DEBUG)
  defaultThinkingBudget: 10000,       // Thinking budget when ai.extendedThinking is on (Google, OpenRouter;
                                      // direct Anthropic from 0.52.0). Capped per provider; see Extended Thinking
  contextBudget: 200000,              // Optional cap on the context budget (forces wrap-up at 80%, Anthropic eviction at 50%).
                                      // ⚠ The 80% wrap-up brake does NOT apply to Anthropic structured-output runs — see below.
                                      // When unset, the engine uses the resolved model's real context window
                                      // (registry `limits.context`) — e.g. 1M for Opus 4.6+, 128k for many GPT/Gemini —
                                      // falling back to 200k only when the window is unknown. When set, it caps the
                                      // budget at min(this, modelWindow). Set it to control cost on large-window models.
  maxRetries: 2,                      // Retries for transient LLM errors (429/5xx); exponential backoff via AI SDK
  maxConcurrency: 8,                  // Ceiling on concurrent in-flight LLM calls, per UluOpsClient instance
                                      // (or ULUOPS_MAX_CONCURRENCY). Bounds this instance's total requests regardless
                                      // of how many workflow phases, parallel steps, or inline pipeline agents fan out
                                      // at once — the per-instance throttle that stops fan-out × retry from amplifying
                                      // a rate limit. NOT process-wide: multiple UluOpsClient instances in one process
                                      // each get their own ceiling and do not coordinate with each other.
                                      // Distinct from a workflow's per-level `max_parallel`, which caps one layer only.
  dashboardUrl: 'https://app.uluops.ai', // Dashboard link prefix for run URLs
  onSecurityEvent: (event) => { /* see Security events below */ }, // Optional handler for auth/redirect security events

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

> ### ⚠️ `contextBudget`'s 80% wrap-up brake is inert on Anthropic structured output
>
> The brake works by returning `toolChoice: 'none'` from the AI SDK's `prepareStep`. When
> Anthropic runs structured output through `structuredOutputMode: 'jsonTool'` — which is
> what core sets by default for every Anthropic structured-output call — the provider
> **hard-overrides `toolChoice`** to select its json tool, so the brake never applies and
> the model keeps calling tools past 80%.
>
> Two consequences worth knowing before you rely on `contextBudget` as a cost control:
>
> - **It is not a hard stop on that path.** The eviction half (Anthropic context management
>   at 50%) still works; only the wrap-up half is overridden. If you need a hard ceiling,
>   set a lower `contextBudget`, cap `maxSteps`, or run without structured output.
> - **The run no longer claims otherwise.** Through 0.41.0 the `budget.forced-wrap-up`
>   marker latched regardless, downgrading a complete run to `partial` completeness for an
>   event that did not occur. As of 0.42.0 the marker is emitted only where the brake can
>   act; the budget crossing is still logged at `warn`, and the message names this reason.
>
> `providerWarnings` does not surface this — it is a core-internal `toolChoice` override,
> not something the provider reports. An explicit `providerOptions.anthropic.structuredOutputMode`
> other than `'jsonTool'` restores both the brake and the marker.

### Local Definition File Naming

Files under `localDefinitions` must follow the `<name>.<type>.yaml` convention —
a plain `<name>.yaml` is **not** found, and the resulting error ("not found in
registry. Set ULUOPS_API_KEY…") points at the registry rather than the filename:

| Definition type | Filename | Also scanned in subdirectory |
|-----------------|----------|------------------------------|
| Agent (ADL) | `my-agent.agent.yaml` | `agents/` |
| Command (CDL) | `my-command.command.yaml` | `commands/` |
| Workflow (WDL) | `my-workflow.workflow.yaml` | `workflows/` |
| Pipeline (PDL) | `my-pipeline.pipeline.yaml` | `pipelines/` |

Each type is resolved from the base directory first, then its subdirectory
(e.g. `./definitions/code-validator.agent.yaml`, then
`./definitions/agents/code-validator.agent.yaml`). The `<name>` part is what
you pass to `runAgent()` / `resolve()`.

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
| `ULUOPS_DISABLE_STAGE_FORWARDING` | Disable upstream stage-result forwarding engine-wide (`1` or `true`) | `false` |
| `ULUOPS_MAX_CONCURRENCY` | Ceiling on concurrent in-flight LLM calls, per `UluOpsClient` instance | `8` |
| `ULUOPS_DEBUG` | Enable detailed execution logging | `false` |
| `ULUOPS_EXTENDED_THINKING` | Extended thinking for every run: `on` or `off`. `ai.extendedThinking` wins over it; anything else is `off` with a warning | `off` |

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
  // Pipeline structure — stages and their opt-in `steps:` blocks
  type StageDefinition,          // one stage of a PipelineDefinition
  type StageResult,              // one entry of PipelineResult.stages
  type StepDefinition,           // one entry of StageDefinition.steps (see Stage Steps)
  type StepResult,               // one entry of StageResult.steps
  // Registry types
  type SubscriptionTier,         // 'free' | 'hobbyist' | 'plus' | 'pro' | 'enterprise';
                                 // type of SubscriptionRequiredError.requiredTier / .currentTier
  // Decision classification
  classifyDecision,
  resolveDecisionCategory,
  type DecisionCategory,
  type DecisionVocabularyMap,   // return type of buildVocabularyMap
  // Analysis & AI layer companion types (for direct Advanced Exports usage)
  type AnalysisExtractionResult, // return type of AnalysisSummaryExtractor
  type ResolvedModel,            // return type of ModelCatalog.resolve
  type ResolveOptions,           // options for ModelCatalog.resolve — requiredCapabilities, preferredProvider
  // Completeness & degradation markers
  deriveCompleteness,
  resolutionMarkersFromLegacy, // migrate the deprecated degradations[] field
  type Completeness,
  type DegradationMarker,
  type DegradationPhase,        // 'resolution' | 'execution'
  type DegradationSeverity,     // 'info' | 'degraded' | 'critical'
  // Usage metrics
  type ExecutionMetrics,        // type of result.metrics on every result type (camelCase)
  type ExecutionMetricsLike,    // alias of ExecutionMetrics; names MaxStepsExhaustedError.billedMetrics
  type UsageMetrics,            // raw AI-provider usage on AIGenerateResult.usage (advanced; snake_case)
  type AIGenerateResult,        // return type of AIProvider.generate() (advanced)
  type AIGenerateOptions,       // parameter type of AIProvider.generate() (advanced)
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
| `ConfigurationError` | `UluOpsClient` constructor, `RegistryClient.resolve()`, `AIProvider.ensureProvider()`, `ModelCatalog.resolve()` (registry route miss, 0.45.0+) | Missing API key, invalid provider config, definition not found in registry, invalid definition format |
| `ModelNotFoundError` | `ModelCatalog.resolve()`, `AIProvider.generate()` (OpenRouter unknown slug, 0.48.0+) | Model alias not found in registry catalog, or a slug the provider does not recognize |
| `CapabilityError` | `ModelCatalog.resolve()`, `AIProvider.generate()` (OpenRouter no-endpoint 404, 0.48.0+) | Resolved model lacks a required capability (e.g. tools, vision, reasoning), or no provider endpoint can serve the request as sent; the message names the routing constraints |
| `ProviderCreditError` | `AIProvider.generate()` (reached via any executor) | The model provider refused the request for lack of credit (HTTP 402; code `PROVIDER_CREDIT`). Carries `error.provider`, `error.statusCode` and `error.limitSource`. Not UluOps' own entitlement 402 (`SubscriptionRequiredError`). The same request will not succeed on retry; inside a pipeline it stops the run and fails it (`wait()` throws a `PipelineError` with this message) |
| `PreflightError` | `CommandExecutor` (preflight phase) | Preflight check failed — missing env var, file not found, command unavailable |
| `ExecutionError` | `AgentExecutor.execute()`, `CommandExecutor.execute()` | Agent execution failure or definition type mismatch. `error.partialResult` is typed `unknown` — no producer in this package populates it; do not rely on it |
| `CancelledError` | `AIProvider.generate()` (reached via any executor) | The run stopped because the CALLER asked it to — `PipelineHandle.cancel()`, or an `abortSignal` you supplied on `ExecutionOptions`. Subclass of `ExecutionError` (code `CANCELLED`). Check it BEFORE `ExecutionError`, and note it is deliberately **not** a `TimeoutError`: a cancel names no elapsed duration, so treating the two alike sends you to raise a timeout that was never the cause, and makes timeout-keyed retry logic retry work you asked to stop |
| `MaxStepsExhaustedError` | `AgentExecutor.execute()` | The tool loop hit the `maxSteps` ceiling while the model was still calling tools, leaving empty output. Subclass of `ExecutionError` (code `MAX_STEPS_EXHAUSTED`); carries `error.steps`, `error.finishReason`, and `error.billedMetrics?` (typed `ExecutionMetricsLike`) — the tokens and cost ALREADY BILLED before the ceiling was hit. A step-ceiling run is by construction the longest run the engine produces, so read `billedMetrics` rather than recording the run as free; it is **absent**, never zero, when nothing is known (absent is an admission, zero is a claim). Raise `maxSteps`, narrow the target, or lower the context budget so wrap-up triggers earlier |
| `ParseError` | `OutputExtractor.extractWithMetadata()` | LLM output could not be parsed as structured JSON. Check `error.contentPreview` for raw output |
| `SubmissionError` | `SubmissionClient` methods | The tracker rejected a submission. Use `SubmissionErrorCodes` to narrow by code |
| `WorkflowError` | `WorkflowExecutor.execute()` | Phase gate failure. `error.context.partialResult` is `Partial<WorkflowResult> \| CommandResult[] \| undefined` — a partial aggregate object, a raw array of completed command results, or absent, depending which internal path threw |
| `PipelineError` | `PipelineExecutor.execute()` | Pipeline stage failure. Check `error.context` for stage name/index |
| `SubscriptionRequiredError` | `RegistryClient.resolve()` | Definition requires a higher subscription tier. Check `error.requiredTier`, `error.currentTier`, and `error.upgradeUrl` for upgrade guidance |
| `IntegrityError` | `RegistryClient.resolve()` (caller-pinned) | A pinned `expectedHash`/`expectedPromptHash` did not match the resolved content, or a prompt pin was supplied for a definition with no rendered prompt. Check `error.kind` (`'yaml'`/`'prompt'`/`'unavailable'`), `error.expected`, `error.actual`, and `error.definitionName`/`error.definitionVersion` (which definition failed). Fail-closed — execution is refused |

```typescript
import { ConfigurationError, ModelNotFoundError, CapabilityError, ExecutionError, CancelledError, MaxStepsExhaustedError, WorkflowError, SubscriptionRequiredError, ProviderCreditError } from '@uluops/core';

try {
  const result = await client.runAgent('code-validator', './src');
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error('Check your config:', error.message);
  } else if (error instanceof ModelNotFoundError) {
    console.error('Unknown model alias:', error.message);
  } else if (error instanceof CapabilityError) {
    console.error('Model lacks a required capability:', error.message);
  } else if (error instanceof CancelledError) {
    // Check this BEFORE ExecutionError — it is a subclass.
    // You asked for this: handle.cancel(), or your own abortSignal fired.
    console.error('Run cancelled.');
  } else if (error instanceof MaxStepsExhaustedError) {
    // Check this BEFORE ExecutionError — it is a subclass.
    console.error(`Hit the step ceiling (${error.steps} steps) — raise maxSteps or narrow the target.`);
    // The run was fully billed before it threw. Record what it actually spent.
    if (error.billedMetrics) {
      console.error(`  spent: ${error.billedMetrics.totalEffectiveTokens} tokens`
        + (error.billedMetrics.costUsd !== undefined ? ` / $${error.billedMetrics.costUsd}` : ' / cost unknown'));
    }
  } else if (error instanceof ExecutionError) {
    console.error('Execution failed:', error.message);
    // error.partialResult is `unknown` and unpopulated by any producer here — don't read it.
  } else if (error instanceof WorkflowError) {
    // Phase gate failure — error.context.partialResult is
    // Partial<WorkflowResult> | CommandResult[] | undefined
    console.error('Workflow gate failed:', error.message);
  } else if (error instanceof SubscriptionRequiredError) {
    console.error(`Upgrade required: needs "${error.requiredTier}" (you have "${error.currentTier}").`);
    if (error.upgradeUrl) console.error(`Upgrade at: ${error.upgradeUrl}`);
  }
}
```

Every error also carries a stable `code`, which is what to switch on when you want
exhaustive narrowing rather than a chain of `instanceof` checks — or when the error crossed
a serialization boundary (`toJSON()` preserves `code`, but not the prototype, so `instanceof`
does not survive the trip):

```typescript
import { UluOpsErrorCodes, type UluOpsErrorCode } from '@uluops/core';

function describe(code: UluOpsErrorCode): string {
  switch (code) {
    case UluOpsErrorCodes.CANCELLED:          return 'You stopped this run.';
    case UluOpsErrorCodes.MAX_STEPS_EXHAUSTED: return 'Hit the step ceiling — raise maxSteps.';
    case UluOpsErrorCodes.CONFIGURATION_ERROR: return 'Check your config.';
    default:                                   return 'Unhandled UluOps error.';
  }
}
```

Note the `default` is what makes the above safe, not exhaustive — it absorbs any code you
did not name, including ones added in a later release. If you would rather a new code be a
compile error than a silent fallthrough, drop the `default` and assign the scrutinee to
`never` in its place; `UluOpsErrorCode` is a closed union, so TypeScript will then name the
members you have not handled.

### Re-exported from @uluops/sdk-core

| Error | Description |
|-------|-------------|
| `SdkApiError` | Base API error |
| `ValidationError` | 400 validation failure (extends `SdkApiError`, **not** `UluOpsError`; `isValidationError` guard also exported). Config-time key validation never reaches it — `resolveConfig` throws `ConfigurationError` at the boundary |
| `RateLimitError` | 429 rate limit exceeded. `retryAfter` is in seconds when the provider says when to retry (`retry-after`, or OpenRouter's `X-RateLimit-Reset`) |
| `UnauthorizedError` | 401 authentication failure |
| `ForbiddenError` | 403 access denied |
| `NotFoundError` | 404 resource not found |
| `ServiceUnavailableError` | 503 service unavailable |
| `NetworkError` | Connection failures |
| `TimeoutError` | Request timeout |

> #### ⚠️ Do not use `instanceof` on these — use `isApiErrorLike`
>
> **`error instanceof SdkApiError` is structurally always `false`** for any error that crosses
> the registry-sdk boundary, and it fails silently — no exception, no warning, just a branch
> that never runs.
>
> The cause is a dual-package hazard: `@uluops/core`, `@uluops/registry-sdk` and
> `@uluops/ops-sdk` each carry an exact pin of `@uluops/sdk-core`, and exact pins dedupe only
> while they are **equal**. Whenever they drift apart — core 0.43.5 pinned 0.17.0 beside a
> registry-sdk that nested 0.15.0 — two copies are installed, two distinct `SdkApiError`
> class objects exist, and an error minted inside one is not an `instanceof` the other. The
> split was open again from 0.44.0 (core sdk-core 0.18.1, registry-sdk 0.54.0 nesting 0.18.0)
> until the release that pins registry-sdk 0.58.0: now all three resolve sdk-core 0.18.1 and one
> copy is hoisted. That alignment is a property of the current pins, not a guarantee: the next
> unpaired bump reopens it silently.
> `isSdkApiError` and its aliases are themselves `instanceof`-based and are **not** an escape
> hatch.
>
> Use the identity-free guard instead — exported from the package root:
>
> ```typescript
> import { isApiErrorLike } from '@uluops/core';
>
> try {
>   await client.runAgent('code-validator', './src');
> } catch (error) {
>   if (isApiErrorLike(error)) {
>     // Narrowed to { statusCode: number; message: string } regardless of which
>     // copy of sdk-core minted it. Branch on the STATUS, not the class.
>     if (error.statusCode === 402) console.error('Subscription required:', error.message);
>     else if (error.statusCode === 404) console.error('Not found:', error.message);
>     else console.error(`API error ${error.statusCode}:`, error.message);
>   }
> }
> ```
>
> The guard deliberately tests `statusCode`, **not** `name`: a 402 arrives as the base
> `SdkApiError` while a 404 arrives as `NotFoundError`, so a name check would miss one of them.
>
> This is why several `@throws {SdkApiError}` JSDoc tags in `SubmissionClient` describe what is
> thrown but should not be read as a recommendation to match it with `instanceof`.

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

Agent definitions can request tools (`interface.tools` in the ADL, e.g. `[Read, Grep, Glob, Bash]`), but the operator must explicitly permit them. Tool names match case-insensitively on both sides. This separates the trust boundary: **definition authors declare** what they need, **operators decide** what they permit.

By default, all tools except `bash` are allowed; in practice the list gates only `bash` (the read-only filesystem tools are always available). The `bash` tool is offered only on providers with a shell tool in core (`anthropic`, `openai`, and `openrouter` through the schema-fallback tool); elsewhere a warning says the agent runs without one. It passes LLM-generated command strings to `sh -c`, **starting** in the target directory but not confined to it: commands can reach anything the process user can. They run without the operator's credentials (variables ending `_API_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_CREDENTIAL(S)` and the `AWS_`/`GOOGLE_`/`AZURE_`/`ANTHROPIC_`/`OPENAI_` prefixes are removed). The grant is per client: allowing bash allows it for every agent that declares it, and the first time a shell is offered core prints a warning that shell access is active. Only enable it in sandboxed environments (containers, CI). **If you enable `bash` in CI, pin the definitions you run** (`expectedHash` — see [Integrity Verification](#integrity-verification)): with bash on, a mutated registry definition is author-controlled shell on your CI host, and the pin is what makes that substitution refuse to execute.

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

### Security events

Every SDK client core constructs — the tracker client, the registry client — forwards security-relevant events to one handler you supply on the config: a rejected credential, a blocked upstream redirect (a possible MITM or misroute), a failed token refresh, or a credential swap. Nothing is logged for you; the handler is the channel.

```typescript
import type { SecurityEvent } from '@uluops/core';

const client = new UluOpsClient({
  onSecurityEvent: (event: SecurityEvent) => {
    // event.type: 'auth_failure' | 'redirect_rejected' | 'token_refresh_failed' | 'auth_strategy_replaced'
    audit.record(event.type, event.timestamp, event);
  },
});
```

The handler and event types — `SecurityEventHandler`, `SecurityEvent`, `SecurityEventType`, `AuthType`, `AuthFailureEvent`, `RedirectRejectedEvent`, `TokenRefreshFailedEvent`, `AuthStrategyReplacedEvent` — are re-exported from the package root (they originate in `@uluops/sdk-core`). `ResolvedConfig.onSecurityEvent` carries the handler through to every client core builds.

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

PDL pipeline stages can declare inline shell `steps:` blocks (detection preflights, build gates). The engine executes them **only when the operator opts in** via `allowStageSteps: true` (or `ULUOPS_ALLOW_STAGE_STEPS=true` — the exact string `true`). This is the same trust boundary as the `bash` tool: step commands come from resolved definitions, so running them is definition-author-controlled shell on your host. **The opt-in is the boundary — there is no command allowlist.** With the opt-in off (the default), steps-only stages pass through as `PASS` with a `null` score (excluded from pipeline score aggregation) and their steps are not run — **unless the stage carries an abort gate** (`gate.on_failure: abort`, or a `gate:` block that omits `on_failure` — abort is the PDL default), in which case the run fails loudly: an unexecutable mandatory gate is a configuration error, not a skippable step.

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
| `@uluops/ops-sdk` | Tracker API client (6.x) — runs, findings, issues, analytics |
| `@uluops/taxonomy` | The failure taxonomy (4 domains, 28 modes, 5 severities); `isCanonicalMode` guards failure codes at submission |
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
