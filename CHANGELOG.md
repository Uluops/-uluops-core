# Changelog

All notable changes to `@uluops/core` will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-05-11

### Added

- **Automatic analysis summary extraction** — `AnalysisSummaryExtractor` builds `analysisSummary` and `analysisRecords` from `AgentResult` + `ResolvedDefinition` at submission time. Every tracked agent run now automatically populates:
  - `categoryScores` with weights from the agent definition's scoring categories (equal-weight fallback for non-validators)
  - `systemMetrics` from execution metrics (tokens, duration, model, toolCallCount, costUsd, extractionConfidence)
  - `decisionVocabulary` from the agent definition's decision or completion vocabulary
  - `epistemicAssessment`, `auditImplications`, `explorationMaps` extracted from LLM raw JSON output (cognitive lens and explorer agents)
  - `analysisRecords` auto-generated from recommendations (failureDomain → recordType, failureCode → recordId)
- **`rawJson` field on `AgentResult`** — preserves the full pre-Zod-strip LLM output for downstream analysis extraction. Internal field, not part of the public API surface.
- **`resolvedDefinition` on `RunSubmission`** — enables the extractor to access definition metadata (scoring weights, decision vocabulary) at submission time

### Changed

- **`ValidationClient.transformToOpsInput()`** — now populates `analysisSummary` and `analysisRecords` on every agent submission when `resolvedDefinition` is available
- **`UluOpsClient.trackIfEnabled()`** — passes full `ResolvedDefinition` (previously narrowed to `{ type, name, version }`) to enable analysis extraction

## [0.8.2] - 2026-04-16

### Security

- **Definition name validation** — `RegistryClient.resolve()` rejects path traversal sequences (`../`, non-alphanumeric names) before filesystem use (CWE-22)
- **ReDoS nested quantifier detection** — `searchContent` rejects patterns with nested quantifiers like `(a+)+` before regex compilation, closing the catastrophic backtracking gap the 200-char length cap couldn't prevent (CWE-1333)
- **Preflight metacharacter blocklist hardened** — single `&` (background execution) and trailing `\` (line continuation) added to the blocked pattern set
- **Raw LLM output removed from debug logs** — output text may contain secrets read from target project files; only metadata (length, finishReason) is now logged. Full output remains available in `AgentResult`
- **API key prefix redacted in error messages** — validation errors no longer echo `apiKey.substring(0, 4)`, replaced with `[redacted]`
- **Anthropic bash tool version throws on stale** — `createProviderShellTool` now throws with upgrade guidance instead of silently returning `undefined` when the date-stamped tool version is not found on the provider instance

### Fixed

- **Local definitions compute real SHA-256 hash** — `RegistryClient.resolveLocal()` now computes `sha256:<hex>` from YAML content instead of hardcoding `hash: ''`, closing the integrity verification gap for locally-resolved definitions
- **RegistryClient comments corrected** — local resolution is documented as priority (not fallback), matching actual code behavior

### Changed

- **License changed to MIT** — `@uluops/core` is now open source. Execution runs locally on the user's machine, shifting trust and liability to the user. Registry, tracker, analytics, and platform remain proprietary.

## [0.8.1] - 2026-04-16

### Security

- **`isPathSafe()` hardened — three independent CWE-22 fixes** (ToolHandler.ts:141-157):
  1. `startsWith` without path separator allowed `/base-evil/` to pass `/base` check — fixed with `startsWith(base + path.sep)`
  2. `catch` block returned `true` (fail-open), enabling TOCTOU symlink races — changed to `return false` (fail-closed)
  3. Realpath check had same prefix collision as logical check — fixed with exact-match fallback
  - Discovered by security-audit pipeline run #10: each bug found by a different agent (security-tester, perverse-outcome-detector, circumvention-forecaster)

### Added

- **`allowedTools` config** — operator-controlled tool allowlist that separates the trust boundary between definition authors and system operators. Definitions request tools (e.g., `tools: ['bash']` in YAML), but tools are only granted if the operator also permits them via `allowedTools`. Default: all tools except `bash` are allowed (safe default). Set `allowedTools: ['bash']` to explicitly opt in to shell access. Also configurable via `ULUOPS_ALLOWED_TOOLS` env var (comma-separated).

## [0.8.0] - 2026-04-15

### Added
- **`extractionConfidence` and `extractionMethod`** fields on `AgentResult` — surfaces how LLM output was parsed and how reliable the result is
- **`EXTRACTION_FAILED` decision** — when extraction confidence is below 0.7, decision is `EXTRACTION_FAILED` instead of silently defaulting to `FAIL`
- **Low-confidence extraction warning** — logged when fallback strategies produce results below 0.7 confidence
- **`DEFAULT_MAX_TOKENS`** constant (16384) — centralized from two hardcoded callsites
- **`ANTHROPIC_CONTEXT_KEEP_TOOL_USES`** constant (5) — extracted magic number with documented rationale

### Changed
- **Deduplication preserves cross-agent convergence** — dedup key now includes agent name so the same finding from different agents is preserved as convergence evidence
- **ADR-001 updated** — PARTIAL classification corrected from 'negative' to 'conditional', custom vocabulary section updated to reflect `buildVocabularyMap` auto-resolution

### Removed
- **Dead code cleanup** — unused barrel files (`src/ai/index.ts`, `src/registry/index.ts`, `src/validation/index.ts`), dead `Tool` interface, orphaned runtime type re-exports

## [0.7.0] - 2026-04-15

### Breaking Changes
- **Unified output schema** — `validatorOutputSchema`, `executorOutputSchema`, and `genericOutputSchema` replaced by single `agentOutputSchema` with categories + artifacts for all 6 agent types
- **Unified result type** — `ValidatorAgentResult` and `ExecutorAgentResult` removed; single `AgentResult` interface with `decision: string` passthrough, score, categories, and optional artifacts
- **Decision passthrough** — `validatedDecision()` removed; LLM decisions pass through as-is. `classifyDecision()` with vocabulary maps handles normalization via `decisionCategory`

### Changed
- **PARTIAL reclassified as conditional** — `classifyDecision` and `buildVocabularyMap` now treat PARTIAL as 'conditional' (progress) instead of 'negative' (failure)
- **Category extraction ungated** — `OutputExtractor` extracts categories for all agent types, not just validators
- **Score aggregation generalized** — `CommandExecutor` aggregates scores from all scored agents, not just validators
- **issueLine regex synced with LANG_MAP** — added PHP, C#, C++, C, Swift, Kotlin, SQL, Shell, SCSS, MJS, CJS to issue file path matching
- **`AIProvider.mapError` preserves error cause** — mapped errors now set `.cause` to the original AI SDK error
- **`AgentExecutor.execute()` refactored** — 158→40 lines via 7 extracted helpers
- **`AIProvider.generate()` refactored** — 136→25 lines via 4 extracted helpers

### Added
- **Anthropic-first provider strategy** documented in SCOPE.md with extension points
- **costUsd trace** documented in SCOPE.md (plumbed but blocked on registry pricing)
- **Maintainers section** in README
- **Advanced Exports** section in README documenting all 16 exported components

### Fixed
- **Filesystem paths stripped** from user-facing RegistryClient error messages
- **`parseFloat` replaced with `Number()`** to reject partial numeric strings from LLM output
- **CHANGELOG v0.6.0** entry added (was missing)

## [0.6.0] - 2026-04-15

### Added
- **`classifyDecision()` utility** — classifies agent decision strings into positive/negative/conditional/neutral categories with support for custom vocabulary maps via `buildVocabularyMap()`
- **`DefinitionType` type guards** — `isAgentDef()`, `isCommandDef()`, `isWorkflowDef()`, `isPipelineDef()` for narrowing parsed definitions

### Changed
- **Naming alignment** — `validator` references renamed to `agent` throughout (executor, types, metrics) per name-game remediation
- **`maxScore`/`maxPoints` unified** — consolidated duplicate scoring fields across agent result types
- **`AIProvider.mapError` preserves original error cause** — mapped errors now set `.cause` to the original AI SDK error for debugging
- **`AIProvider` provider name validation** — `additionalProviders` allowlist validates names against `^[a-z][a-z0-9-]{0,30}$` (CWE-829)
- **Unsafe `Function` type replaced** — `createProviderShellTool` uses typed callable signature instead of bare `Function`

### Fixed
- **Null-safe priority handling** — `prioritizeRecommendations` no longer throws on undefined severity
- **`PipelineError` serialization** — error now includes `pipelineName` in formatted output
- **Symlink mismatch in tool handler** — path safety check resolves symlinks on macOS before comparison
- **Zod/TypeScript schema sync** — compile-time check ensures Zod schemas stay aligned with TypeScript interfaces

## [0.5.0] - 2026-04-14

### Added
- **DAG-based parallel phase execution** — WorkflowExecutor now topologically sorts phases by `depends_on` declarations and executes independent phases (same topological level) in parallel via `Promise.allSettled`
- **`topoGroupLevels()` utility** — groups phases into parallel execution levels with cycle detection and missing-dependency validation
- **Four `on_failure` behaviors** — `stop` (finish current level, skip rest), `abort` (skip all remaining immediately), `continue` (proceed past failures, deps check naturally), `warn` (downgrade blocked to warned)
- **`max_parallel` concurrency limit** — optional semaphore on `orchestration` config to cap parallel phase execution (1-10)
- **`phasesAborted` metric** on `WorkflowMetrics` — tracks phases terminated by abort behavior
- **`'aborted'` phase decision** — new `PhaseResult.decision` value distinguishing abort-terminated phases from skipped phases

### Changed
- **`on_failure` type** — `'stop' | 'continue' | 'skip_dependents'` → `'stop' | 'continue' | 'abort' | 'warn'` (aligns with WDL schema)
- **`gate.on_fail` type** — `'block' | 'warn'` → `'stop' | 'warn' | 'abort'` (aligns with WDL schema)
- **`WorkflowRuntime.onFailure`** and **`PhaseConfig.gate.on_fail`** in registry types updated to match
- **Phase execution model** — sequential `for...of` loop replaced with level-based DAG execution; phases without dependencies now run concurrently instead of sequentially

### Migration from 0.4.x

**`on_failure` enum values changed.** If you set `on_failure` in workflow definitions or pass it programmatically, update the values:

| Old value | New value | Behavior change |
|-----------|-----------|----------------|
| `'skip_dependents'` | `'stop'` | Finishes current parallel level, then skips remaining phases |
| _(new)_ | `'abort'` | Immediately skips all remaining phases (including current level) |
| _(new)_ | `'warn'` | Downgrades blocked phases to `'warned'` instead of `'skipped'` |

**`gate.on_fail` enum values changed.** Update gate configurations:

| Old value | New value | Behavior change |
|-----------|-----------|----------------|
| `'block'` | `'stop'` | Same behavior (halts after current level) |
| _(new)_ | `'abort'` | Immediate halt of all remaining phases |

**Phase execution is now parallel by default.** Phases without `depends_on` declarations run concurrently. If your workflow relied on sequential execution order, add explicit `depends_on` edges between phases to preserve ordering.

## [0.4.0] - 2026-03-15

### Added
- **`'archived'` definition status** — `DefinitionStatus` union type extended with `'archived'` value for soft-deleted definitions

### Changed
- **`@uluops/ops-sdk`** bumped to `^1.1.0` — includes `status` → `decision` field rename on execution results
- **`@uluops/sdk-core`** bumped to `^0.5.0` — updated HTTP infrastructure and error mapping

## [0.3.0] - 2026-02-25

### Added
- **Google/Gemini provider support** — `@ai-sdk/google` bundled as third provider alongside Anthropic and OpenAI
- **Google thinking support** — auto-enables `thinkingConfig.thinkingBudget` for Gemini 2.5+ models with `extendedThinking` capability
- **Google usage metrics** — maps `cachedContentTokenCount` and `thoughtsTokenCount` from Google provider metadata
- **`thinking_tokens`** field on `UsageMetrics` type for Google Gemini thinking token tracking
- **Dual Google env var** — checks both `GOOGLE_API_KEY` (UluOps convention) and `GOOGLE_GENERATIVE_AI_API_KEY` (Google SDK default)
- **`FACTORY_NAME_OVERRIDES`** map in `ensureProvider()` — fixes dynamic import path for providers with non-standard factory names (e.g., `createGoogleGenerativeAI` instead of `createGoogle`)
- **Generic provider metadata scan** — best-effort cache token extraction from unknown provider metadata for non-bundled providers (DeepSeek, Mistral, xAI, etc.)

### Changed
- **AIProvider** — extended from 2-provider to 3-provider dispatcher; `buildProviderOptions()` now dispatches to `buildGoogleOptions()` in addition to Anthropic/OpenAI
- **AIProvider** — `buildSystemMessage()` returns plain string for Google (implicit caching for Gemini 2.5+, same as OpenAI)
- **AgentExecutor** — `calculateEffectiveTokens()` now includes `thinking_tokens` (Google charges thinking tokens separately from output tokens, unlike OpenAI which includes reasoning in output tokens)
- **UluOpsClient** — `resolveAIConfig()` checks `GOOGLE_GENERATIVE_AI_API_KEY` as fallback when `GOOGLE_API_KEY` is not set

## [0.2.0] - 2026-02-25

### Added
- **OpenAI provider support** — `@ai-sdk/openai` bundled as second provider alongside Anthropic
- **Auto-detection of AI providers** — `resolveAIConfig()` scans `OPENAI_API_KEY`, `GOOGLE_API_KEY`, etc. when no explicit `ai.providers` config is given
- **OpenAI shell tool** — `createProviderShellTool()` dispatches to Anthropic `bash_20250124` or OpenAI `shell()` based on resolved model provider
- **OpenAI reasoning support** — auto-sets `reasoningEffort: 'medium'` for reasoning-capable models (o1, o3, o4-mini)
- **OpenAI usage metrics** — maps `cachedPromptTokens` and `reasoningTokens` from OpenAI provider metadata
- **`reasoning_tokens`** field on `UsageMetrics` type for OpenAI reasoning model token tracking
- **`resolveModel()`** on AIProvider (`@internal`) for early provider detection in AgentExecutor

### Changed
- **AIProvider** — refactored from Anthropic-only to multi-provider dispatcher; `buildProviderOptions()` dispatches to `buildAnthropicOptions()` / `buildOpenAIOptions()`
- **AIProvider** — `buildSystemMessage()` returns plain string for non-Anthropic providers (OpenAI caching is automatic for prompts ≥1024 tokens)
- **AgentExecutor** — shell tool setup uses early model resolution to select correct provider tool
- **UluOpsClient** — `resolveAIConfig()` auto-detects providers via `KNOWN_PROVIDERS` env var scan instead of defaulting to Anthropic-only

### Removed
- **`createBashTool()`** — replaced by `createProviderShellTool(provider, targetDir, timeoutMs)`

### Migration from 0.1.x

**`createBashTool()` removed.** Replace with the provider-aware shell tool:

```typescript
// Before (0.1.x)
import { createBashTool } from '@uluops/core';
const tool = createBashTool(targetDir, timeoutMs);

// After (0.2.0+)
// Shell tool is now created internally by AgentExecutor when the agent
// definition includes 'bash' in its tools list. No manual creation needed.
// For advanced usage, use AIProvider.createProviderShellTool():
const tool = aiProvider.createProviderShellTool(provider, targetDir, timeoutMs);
```

**Provider auto-detection added.** If you hardcoded Anthropic-only config, the SDK now scans for `OPENAI_API_KEY` and `GOOGLE_API_KEY` automatically. To keep Anthropic-only behavior, set `defaultProvider: 'anthropic'` explicitly.

## [0.1.0] - 2026-02-09

### Added
- Initial SDK implementation
- 4-layer execution hierarchy: Agent > Command > Workflow > Pipeline
- AI SDK v6 integration via AIProvider (replaces direct Anthropic SDK usage)
- ToolHandler with filesystem sandboxing (read_file, list_files, search_content)
- OutputExtractor with 3-strategy JSON extraction
- RegistryClient for local + remote definition resolution with hash verification
- ValidationClient for core execution submission (submit, validateRun, getHistory, getRun)
- PipelineHandle for async pipeline monitoring
- AgentResult discriminated union types (ValidatorAgentResult, ExecutorAgentResult)
- Safe condition evaluator for PipelineExecutor (replaces `new Function()`)
- Reuses `@uluops/sdk-core` HttpClient for RegistryClient and ValidationClient HTTP infrastructure

### Changed (Pre-implementation Architecture Review)
- **`@uluops/sdk-core` integration**: RegistryClient and ValidationClient now use HttpClient (retry, rate limits, error mapping handled automatically)
- **Error hierarchy aligned**: HTTP errors (RateLimitError, UnauthorizedError, etc.) re-exported from `@uluops/sdk-core/errors`; removed duplicate RegistryError, ClaudeAPIError, AuthenticationError, ServerError
- **ValidationClient scope reduced**: From ~25 methods to 4 core execution methods (submit, validateRun, getHistory, getRun). Analytics, issue management, and taxonomy operations available via `@uluops/ops-sdk`
- **AIProvider simplified**: Anthropic-only for v0.1.0 (removed OpenAI/Google from MODEL_MAP). Additional providers can be added in future versions
- **Config simplified**: Removed `provider` and `providerApiKey` fields (Anthropic-only)
- **CommandExecutor type safety**: Replaced `any` casts with proper discriminated union narrowing via type predicates

### Fixed (Spec v0.9.0)
- Duplicate `detectEnvironment()` in ValidationClient (kept CI-detection version)
- `submit()` call signature mismatch in UluOpsClient (now uses RunSubmission objects)
- Missing `runningPipelines` Map in PipelineExecutor
- `score` made optional in ExecutionResult (not all executions produce scores)
- Model IDs updated to Claude 4.5/4.6 (haiku-4-5, sonnet-4-5, opus-4-6)
- `new Function()` eval replaced with safe regex-based condition parser
- `transformToAPIRequest` builds validators from ExecutionResult (not non-existent `result.validators`)
- Operator precedence in `parseIssues` and `parseArtifacts` (`??` with `as` chains)
- `AgentResult` discriminated union types added to `types/agent.ts`
- `PipelineHandle` class implementation added to `client/PipelineHandle.ts`
