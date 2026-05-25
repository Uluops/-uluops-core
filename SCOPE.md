# @uluops/core — Scope Definition

## What This Package Is

The foundational execution engine for UluOps. Orchestrates AI-powered code analysis through a 4-layer execution hierarchy, manages LLM tool loops via Vercel AI SDK, and integrates with UluOps Registry and Validation services.

Four layers under one roof:

- **Agent execution** — The atomic unit. `AgentExecutor` renders a definition's prompt, sets up filesystem tools, calls an LLM via `AIProvider`, extracts structured output, and returns a typed `AgentResult`. Every other layer terminates here.
- **Command execution** — Wraps one or more agents with preflight checks, model/threshold overrides, and multi-agent score aggregation. `CommandExecutor` uses `Promise.allSettled` for parallel multi-agent execution with partial recovery.
- **Workflow execution** — DAG-based multi-phase orchestration with quality gates. `WorkflowExecutor` topologically sorts phases by dependency declarations, executes independent phases in parallel, and evaluates continuous scores against gate thresholds with four failure behaviors (stop/abort/continue/warn).
- **Pipeline execution** — Multi-stage async orchestration. `PipelineExecutor` handles stage dependencies, conditional execution, and async monitoring via `PipelineHandle`.

Additionally:

- **AI abstraction** — `AIProvider` wraps Vercel AI SDK v6 with multi-provider support (Anthropic, OpenAI, Google bundled; Mistral, Cohere, Groq, xAI, DeepSeek via dynamic import). Provider-specific option injection (thinking budgets, reasoning effort, context management) is handled via a registry of provider options builders.
- **Filesystem sandboxing** — `ToolHandler` provides six LLM-accessible tools (read_file, list_files, search_content, get_file_info, get_directory_tree, get_symbols) with symlink-aware path validation to prevent directory traversal.
- **Output extraction** — 4-strategy fallback: AI SDK structured output > JSON code fence > inline JSON > regex text parsing. The strategies are ordered by confidence; lower strategies activate only when higher ones fail.
- **Registry integration** — `RegistryClient` resolves definitions by name/version from local YAML files or the remote registry API, with SHA-256 hash verification. `ModelCatalog` resolves model aliases (e.g., `sonnet` → `claude-sonnet-4-6`) via the registry.
- **Validation tracking** — `SubmissionClient` submits execution results to the tracker API with issue correlation and regression detection.

## Why These Live Together

The four execution layers are coupled by a strict delegation hierarchy — each layer instantiates and delegates to the layer below:

- **Pipeline → Workflow/Command:** PipelineExecutor routes stages to WorkflowExecutor or CommandExecutor based on the stage definition.
- **Workflow → Command:** WorkflowExecutor resolves and executes commands within phases, collecting their results for gate evaluation.
- **Command → Agent:** CommandExecutor resolves referenced agents and delegates to AgentExecutor, aggregating scores for multi-agent commands.
- **Agent → AI + Tools:** AgentExecutor composes AIProvider (LLM calls), ToolHandler (filesystem), ToolAdapter (AI SDK bridge), and OutputExtractor (result parsing) into a single execution.

Splitting these into separate packages would create a 4-deep dependency chain where every layer depends on the one below, shares `ResolvedDefinition` as the universal exchange type, and shares the `ExecutionMetrics` base type for token accounting. The coupling is structural — it follows the execution hierarchy.

## What This Package Is NOT

- **Not a definition language parser.** YAML parsing and validation against ADL/CDL/WDL/PDL schemas is handled by `@uluops/definition-factory`. This package receives parsed definitions and executes them.
- **Not a CLI.** The CLI (`@uluops/definition-factory-cli` / `udl`) handles user interaction, file discovery, and command dispatching. This package is a programmatic SDK.
- **Not a web server.** No Express, no routes, no middleware. The tracker and registry APIs consume this package but this package never serves HTTP.
- **Not an analytics library.** Does not compute effectiveness scores, health metrics, or burn-down trends. `@uluops/analytics` owns computation; this package produces the raw execution data that analytics consumes.
- **Not an access control layer.** Does not check subscription tiers or org roles. `@uluops/tier-gate` and `@uluops/platform` own access control. This package reads API keys from config but never validates authorization.
- **Not a prompt authoring tool.** Agent definitions (ADL YAML) contain the prompts. This package renders them into LLM system messages but does not create or edit them.

## Scope Boundary Principle

A capability belongs in `@uluops/core` if it meets **both** criteria:

1. **Execution criterion:** It is required for the execution of agent, command, workflow, or pipeline definitions — from definition resolution through LLM generation to result extraction.
2. **SDK criterion:** It is consumed by external SDK users (programmatically via `UluOpsClient`) or by the execution hierarchy internally. It must be part of the runtime execution path, not a build-time, admin-time, or analytics-time concern.

Definition authoring stays in `@uluops/definition-factory`. Analytics computation stays in `@uluops/analytics`. Access control stays in `@uluops/tier-gate`. HTTP serving stays in consuming APIs.

### Applying the Principle

| Capability | In scope? | Reasoning |
|---|---|---|
| `AgentExecutor.execute()` | Yes | Core execution — LLM call with tool loop |
| `WorkflowExecutor` DAG scheduling | Yes | Core execution — phase orchestration |
| `AIProvider.generate()` | Yes | Core execution — single LLM callsite for the system |
| `ToolHandler` filesystem tools | Yes | Core execution — LLM tool fulfillment |
| `OutputExtractor` 4-strategy parsing | Yes | Core execution — result extraction |
| `RegistryClient` definition resolution | Yes | Core execution — definitions must be resolved before execution |
| `TokenBudgetTracker` | Yes | Core execution — prevents context window exhaustion |
| `ModelCatalog` alias resolution | Yes | Core execution — model names must resolve to provider:modelId |
| `SubmissionClient` result submission | Yes | Post-execution tracking — SDK users expect `trackResults: true` |
| ADL/CDL/WDL/PDL YAML validation | No | Build-time concern — `@uluops/definition-factory` |
| Score analytics (burn-down, velocity) | No | Post-execution analytics — `@uluops/analytics` |
| Tier-gated endpoint enforcement | No | API-layer concern — `@uluops/tier-gate` |
| Agent prompt content | No | Definition content — lives in YAML files, not in the SDK |
| `udl validate` / `udl generate` CLI | No | Developer tooling — `@uluops/definition-factory-cli` |

## Known Structural Decisions

### AgentExecutor is the universal convergence point

Every execution path in the system — whether entered via `runAgent()`, `runCommand()`, `runWorkflow()`, or `startPipeline()` — terminates in `AgentExecutor.execute()`. This is by design: the 4-layer hierarchy is a compression funnel. The consequence is that AgentExecutor's behavioral assumptions (output parsing, token calculation, decision classification) silently shape every result the system produces.

All 6 agent types (validator, executor, analyst, generator, explorer, forecaster) use a single `agentOutputSchema` and produce a unified `AgentResult`. There is no type-specific schema routing or result discrimination — categories and artifacts are both optional on every result. Decisions pass through as-is from the LLM; `classifyDecision()` normalizes them via vocabulary maps built from agent definitions.

### ResolvedDefinition is a structural type, not a discriminated union

`ResolvedDefinition` carries `type: DefinitionType` and `definition: AgentDefinition | CommandDefinition | WorkflowDefinition | PipelineDefinition`, but TypeScript cannot narrow `definition` based on `type` because they are independent fields on a single interface. Each executor uses a runtime type guard (`assertWorkflowDefinition`, `assertAgentRuntime`, etc.) that checks `resolved.type` and throws `WorkflowError`/`ExecutionError`/`PipelineError` on mismatch.

The alternative — making `ResolvedDefinition` a proper discriminated union with four variants — was considered but deferred because it would require updating every consumer of `ResolvedDefinition` across multiple packages simultaneously.

### Threshold defaults are centralized with an intentional split

All numeric defaults are in `constants.ts`: `DEFAULT_PASS_THRESHOLD` (75), `DEFAULT_WARN_THRESHOLD` (50), `DEFAULT_GATE_THRESHOLD` (70), `DEFAULT_MAX_STEPS` (50), `DEFAULT_MODEL_ALIAS` ('sonnet').

The pass threshold (75) and gate threshold (70) are intentionally different values. Pass threshold is the score above which an agent/command result is considered passing. Gate threshold is the phase-level quality gate below which a workflow phase blocks. Gates are more lenient because they aggregate multiple command scores and a single low-scoring command shouldn't necessarily block the workflow.

### Provider options builder registry

`AIProvider` uses a `providerOptionsBuilders` registry map instead of if/else dispatch for provider-specific option injection. New providers register a builder function — one entry instead of a new if-branch. This addresses the non-linear maintenance cost identified by the fragility analysis (linear code growth × high provider SDK churn × undocumented internal contracts).

The three bundled providers (Anthropic, OpenAI, Google) have custom option builders for thinking budgets, reasoning effort, and context management. All other providers receive passthrough options.

### Anthropic-first provider strategy

Anthropic is the primary provider by design. The SDK is built with Claude Code and Claude Desktop — Anthropic models receive the deepest optimization: prompt caching with cache control markup, context management (clearing old tool uses at budget thresholds), extended thinking budgets, and provider-specific bash tool integration. OpenAI receives reasoning effort auto-configuration and shell tools. Google receives thinking config. All other providers receive passthrough options via the provider options builder registry.

This is an intentional engineering investment, not an oversight. The provider options builder registry (`AIProvider.providerOptionsBuilders`) is the extension point — adding first-class support for any Vercel AI SDK-supported provider requires one builder function. The AI SDK supports 15+ providers (Anthropic, OpenAI, Google, Mistral, Cohere, Groq, xAI, DeepSeek, Amazon Bedrock, Azure, Fireworks, Together, Perplexity, Cerebras, LMStudio) with a common interface. The SDK's multi-provider architecture is designed so that any of these can be elevated to first-class status by adding a provider options builder and, optionally, a provider-specific shell tool.

The `DEFAULT_MODEL_ALIAS = 'sonnet'` and `defaultProvider = 'anthropic'` defaults reflect the team's primary development context. These are configurable via `UluOpsConfig.ai.defaultProvider` and environment variables.

### costUsd — plumbed but not yet populated

`ExecutionMetrics.costUsd` is declared in types, propagated through `CommandMetricsSummary` and `WorkflowExecutor`, and rendered by the CLI formatter when present. It is not yet computed because the registry `Model` type does not carry pricing data. Populating this field requires adding per-model pricing rates to the registry model catalog (input $/MTok, output $/MTok, cache read/write rates) and computing cost from token counts in `AgentExecutor.buildMetrics()`. This is deferred until the registry model schema supports pricing fields.

### Anthropic identifiers are volatile constants

`ANTHROPIC_BASH_TOOL_VERSION` ('bash_20250124') and `ANTHROPIC_CONTEXT_MANAGEMENT_TYPE` ('clear_tool_uses_20250919') are date-stamped Anthropic API identifiers extracted to `constants.ts`. They are the fastest-decaying elements in the codebase (days-to-weeks timeline). When Anthropic ships successors, updating these constants is a single-line change.

### Context management trigger derives from budget

The Anthropic context management trigger (clearing old tool uses) fires at 50% of `contextBudget` (default: 100K tokens with 200K budget). The budget wrap-up (forcing `toolChoice: 'none'`) fires at 80%. These are co-calibrated: context management preserves working context in the first half, budget wrap-up forces output in the last 20%.

### OutputExtractor strategies are in managed decline

The 4-strategy extraction fallback (structured output > JSON fence > inline JSON > regex text) is a graduated system where higher strategies are progressively displacing lower ones. As models gain structured output support via AI SDK `Output.object`, the text-based strategies (JSON fence, inline JSON, regex) activate less frequently. They remain for models that don't support structured output and as a fallback when structured output fails.

The Zod schemas in `outputSchemas.ts` must stay synchronized with TypeScript types in `types/command.ts` and `types/parser.ts`. A compile-time check (`_AssertIssueFieldsCovered`) catches drift between `issueSchema` (Zod) and `Issue` (TypeScript). The null→undefined mapping between Zod's `.nullable()` and TypeScript's optional fields is handled in `mapStructuredOutput()`.

### Filesystem sandboxing uses dual-path validation

`ToolHandler.isPathSafe()` performs two checks: logical path containment (`path.resolve` + `startsWith`) and real path containment (`fs.realpath` + `startsWith` against the realpath-resolved base). The dual check is required on macOS where `/tmp` symlinks to `/private/tmp` — without realpath resolution on the base path, legitimate files inside temp directories would be rejected.

`preflight.ts` applies the same pattern for `file_exists` checks, adding a post-access realpath verification to catch symlink-based escape attempts.

## Relationship to Other Packages

| Package | Relationship |
|---|---|
| `@uluops/sdk-core` | Foundation — provides HttpClient, error hierarchy (RateLimitError, UnauthorizedError, etc.), auth utilities. Build dependency. |
| `@uluops/registry-sdk` | Foundation — provides RegistrySdk client consumed by RegistryClient and ModelCatalog. Build dependency. |
| `@uluops/ops-sdk` | Foundation — provides validation/tracking API client consumed by SubmissionClient. Build dependency. |
| `@uluops/definition-factory` | Upstream — parses and validates YAML definitions. This package executes the parsed output. No direct dependency. |
| `@uluops/analytics` | Downstream — consumes execution results for effectiveness scoring, health metrics, trend analysis. No direct dependency. |
| `@uluops/tier-gate` | Independent — gates access to analytics endpoints. Does not interact with this package. |
| `@uluops/platform` | Independent — handles auth/identity. This package reads API keys from config but does not validate them. |
| `ops-uluops-api` (tracker) | Consumer — uses `UluOpsClient` for agent/command/workflow execution in API routes. |
| `uluops-registry-api` | Consumer — uses RegistryClient patterns for definition serving. |

## Planned / Deferred

| Feature | Status | Notes |
|---|---|---|
| `get_dependencies` tool | Deferred | Low priority — `read_file` on package.json covers the use case |
| Progressive context summarization | Deferred | Would use a secondary model (haiku) to summarize old tool results. High impact but adds complexity and latency. Anthropic context management partially addresses this. |
| Provider failover | Deferred | Automatic failover between providers would change model behavior. Multi-provider support exists for manual selection. |
| `ResolvedDefinition` discriminated union | Deferred | Would eliminate `as` casts but requires coordinated update across multiple packages. Runtime type guards provide the safety net. |
| Cost estimation (`costUsd`) | Deferred | Types, propagation, and CLI display are wired. Blocked on registry model pricing schema (input/output $/MTok per model). |
| Windows support | Not planned | POSIX shell assumed for ShellExecutor and preflight. No platform detection or graceful degradation. |

## Inherent Tensions

These are structural properties of the package's design that have been examined and accepted.

| Tension | Status | Notes |
|---|---|---|
| **AgentExecutor convergence** | By design | All paths converge on AgentExecutor. This is the intended compression funnel, not accidental load concentration. Exhaustiveness guard mitigates the latent defect risk. |
| **Decision vocabulary fragmentation** | By design | Four registers: validator (PASS/WARN/FAIL), executor (COMPLETE/PARTIAL/FAILED), phase (passed/warned/blocked/skipped/aborted), workflow (SHIP/HOLD/BLOCK). Each layer has different decision semantics — unifying them would lose information. PARTIAL is classified as 'conditional' (not 'negative') because partial completion is incremental progress, not failure. Normalization via `classifyDecision()` — see [ADR-001](docs/adr/adr-001-decision-vocabulary.md). |
| **Provider SDK undocumented contracts** | Accepted risk | `providerMetadata` shapes for usage extraction are cast through type assertions. Provider SDK updates may silently break usage metrics. Volatile identifiers extracted to constants; provider registry pattern limits blast radius. |
| **Vercel AI SDK structural coupling** | Accepted dependency | Deep API surface dependency on `generateText`, `Output.object`, `stepCountIs`, `prepareStep`. The SDK is the strategic abstraction layer — the coupling is the investment. |
| **Issue → Recommendation lossy mapping** | By design | `flattenRecommendations()` maps `Issue` to `Recommendation`, dropping fields that don't have counterparts. Full data remains available in `parsed.categories` for consumers who need it. |
| **Error propagation across layers** | Unexamined | How failures at the AgentExecutor level manifest at the Pipeline level with 3+ decision vocabularies has not been systematically analyzed. Identified as a coverage gap by fragility-map synthesis. |
| **Validator-centric execution stack** | By design | The execution pipeline — default agent type, dedicated output schemas, decision vocabulary, scoring thresholds, starter agents — is optimized for the validator pattern. Non-validator agent types (analyst, generator, explorer, forecaster) share a generic output schema and receive less parsing fidelity. This reflects the platform's founding use case. Extending to first-class support for other types requires dedicated output schemas per type and corresponding result type discrimination. |
| **Anthropic-first provider investment** | By design | Anthropic receives ~3x the provider-specific engineering (caching, context management, bash tools). This is an intentional optimization for the team's primary development context (Claude Code + Claude Desktop). The provider options builder registry is the extension point for elevating other providers. See "Anthropic-first provider strategy" above. |
| **costUsd infrastructure gap** | Deferred | Type field exists, CLI renders it, workflow propagates it, but no execution path populates it. Blocked on registry model pricing data. Tracked as a known gap rather than dead code. |
