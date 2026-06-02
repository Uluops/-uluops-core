# Changelog

All notable changes to `@uluops/core` will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.1] - 2026-06-01

### Fixed

- **Repair broken dependency references in published `0.18.0` manifest.** `0.18.0` was published pinning `@uluops/ops-sdk: 3.0.0` and `@uluops/registry-sdk: 0.30.0`, both of which were later unpublished from the npm registry. As a result, every fresh `npm install` of `@uluops/core@0.18.0` failed with `ETARGET No matching version found`. This release re-pins to currently-published versions (`ops-sdk: 3.0.5`, `registry-sdk: 0.30.2`).

### Security

- **Bump `@uluops/sdk-core` from `0.11.0` to `0.11.1`.** Pulls in today's sdk-core security hardening: `redirect: 'error'` on all fetch sites (CRLF/credential-replay on auth redirects), control-character stripping in error messages (`stripControlChars` + `SdkApiError` constructor), widened `SENSITIVE_KEYS` (x-api-key, set-cookie, proxy-authorization, x-auth-token), added `column` to `REDACTED_DETAIL_KEYS`, and `sanitizeString` coverage for URL userinfo + bare JWT shapes. See `@uluops/sdk-core` CHANGELOG 0.11.1.

### Supply chain

- **Pin all dependencies and devDependencies to exact versions.** Per the new UluOps-wide exact-pinning policy adopted 2026-06-01 in response to the RedHat-class supply-chain attack pattern. `@ai-sdk/*`, `ai`, `glob`, `yaml`, `zod`, and all devDeps stripped of caret ranges. Lockfile re-aligned to actually-tested resolutions.

## [0.18.0] - 2026-06-01

### Changed

- Bumps `@uluops/sdk-core` to `0.11.0` (exact pin), `@uluops/ops-sdk` to `3.0.0`
  (exact pin), `@uluops/registry-sdk` to `0.30.0` (exact pin). Aligns with the
  sdk-core schema-removal cascade; no code changes in core itself.

## [0.17.1] - 2026-05-27

### Fixed

- **Submission URL corrected** — default submission URL changed from `https://api.uluops.ai/api/v1/ops` to `https://api.uluops.ai/api/v1`.

## [0.17.0] - 2026-05-27

### Added

- **`riskProfile` on `ResolvedDefinition`** — definitions resolved from the registry now include safety scan results (risk level, signals, scanner version) when available. Also surfaced in `describe()` output.

### Changed

- **`PipelineExecutor` uses shared `aggregateScores` utility** — pipeline and workflow score aggregation consolidated into a single path, eliminating duplicate averaging logic.

## [0.16.0] - 2026-05-25

### Added

- **Pipeline agent decomposition** — pipeline stages with inline agents (`type: 'agents'`) now preserve individual `AgentResult[]` on `StageResult.agentResults`. The submission client decomposes these into per-agent tracker entries instead of collapsing them into stage-level summaries. Dashboard now shows `confucius-analyst`, `laozi-analyst`, etc. instead of `Parallel Philosophical Analysis`.
- **Pipeline analysis extraction** — structured analysis records are now extracted from each `AgentResult` within pipeline stages and submitted to the tracker. Previously analysis extraction only ran for single-agent results.
- **Steps-only pipeline stage auto-pass** — PDL stages with `steps` but no `ref` or `agents` (e.g., shell preflight checks) are treated as auto-pass so downstream stages can proceed. Logged as a warning.

### Fixed

- **`PipelineResult.name` uses definition name** — pipeline results now report the definition name (e.g., `peirce-pipeline`) instead of the internal execution ID (`pipeline_1779739332318_a757fda2`). The `definitionName` field was added to `PipelineState`.
- **Reasoning model temperature detection** — `isReasoning` now checks `resolved.tier === 'reasoning'` in addition to capability flags (`extendedThinking`, `reasoning`). Fixes temperature warnings for GPT-5.5 and other models where the registry signals reasoning via tier rather than capabilities.

## [0.15.2] - 2026-05-25

### Changed

- **Preflight commands execute in target directory** — `checkCommand` now passes `cwd: input.target` to `execFileAsync`, matching the execution context of `file_exists` and `git_clean` checks. Previously commands ran in the CLI process's cwd.
- **Preflight allowlist trimmed to read-only commands** — removed package managers (`npm`, `pip`), orchestrators (`docker`, `kubectl`), build tools (`make`, `cargo`), and interpreters (`node`, `python`). None were used in any CDL definition; their broad side-effect authority doesn't belong in prerequisite checks.
- **Preflight security model documented** — README now includes a Preflight Checks section documenting the trust model, allowlist rationale, and defense layers. ARCHITECTURE.md boundary crossing updated to reflect cwd and trust model.
- **Reasoning model temperature warnings suppressed** — `executeGeneration` omits `temperature` for reasoning models (o1, o3, gpt-5.x) instead of sending `undefined` which the AI SDK defaulted back to 0.

## [0.15.1] - 2026-05-25

### Fixed

- **`console.warn` replaced with logger in PipelineExecutor** — PipelineExecutor now accepts a `Logger` parameter and routes warnings through the structured logging system instead of `console.warn`.
- **`flattenGroupedIssues` no longer mutates input** — severity assignment on grouped issues now spreads before writing, preventing mutation of caller-owned objects.
- **PreflightError no longer leaks full command string** — security rejection error details now include only the base command name, not the full command with arguments.
- **`buildTree` sandbox escape via symlinked directories** — `getDirectoryTree` now calls `isPathSafe()` on subdirectories before recursing, preventing symlink-based sandbox escapes.
- **Stale `@uluops/definition-factory` reference removed from README** — dependency was removed in v0.10.0 but the README table still listed it.

### Changed

- **`ValidatorRuntime` renamed to `AgentRuntime`** — completes the validator→agent naming migration. All internal references updated. Not a public API change (type was not exported).
- **`BaseRuntime` extracted** — new base interface with `{ prompt: string }` shared by all runtime types. `AgentRuntime` and `ExecutorRuntime` now extend it. `ResolvedDefinition.runtime` includes `BaseRuntime` in its union, eliminating unsafe casts during registry resolution.
- **`degradations` populated on fallback paths** — `RegistryClient.resolve()` now sets `degradations: ['empty-definition']` and/or `'normalization-fallback'` when resolution falls back to empty or client-side normalization, giving consumers a discriminant for the `Partial<AgentDefinition>` branch.

### Added

- **`clearCache()` documented in README** — new Cache Management section documents the public method for long-lived processes.

## [0.15.0] - 2026-05-21

### Added

- **`runPipeline()` convenience method** — synchronous pipeline execution mirroring `runWorkflow()`. Resolves by ref, validates the definition is a pipeline, executes via `PipelineExecutor` with timeout and model config, and tracks results. Use `runPipeline()` for blocking execution or `startPipeline()` for async handle-based control.

### Changed

- **`PhaseResult.score` is now `number | null`** — all-generator phases return null score instead of 0. Gate evaluation passes null-score phases unconditionally (scoreless phases are not score-bearing).
- **`aggregatePhaseScore` filters null scores** — only scored command results contribute to phase score aggregation. An all-scoreless phase returns null.
- **`evaluateGate` accepts null score** — null score → `'passed'`. Scoreless phases are categorically outside the scoring domain.
- **`aggregateScores` filters null entries** — `ScoredItem.score` is now `number | null`. Null-score items are excluded from min/max/sum/average/weighted_average computation. Returns 0 when all items are null.

## [0.13.0] - 2026-05-21

### Added

- **Operator prompt on `ExecutionInput`** — new `prompt?: string` field lets operators pass a free-text directive to any agent run. For generators, this provides the telos ("Create a health check endpoint"); for validators/analysts, it provides focus ("Focus on the authentication module"). The prompt appears as a prominent `Directive:` section in the initial user message, positioned before project context.
- **Agent-type-aware initial message templates** — `AgentExecutor.buildInitialMessage()` now renders type-specific preambles and closing instructions based on the agent's type: generators get "Generate the requested artifact", executors get "Execute the requested operation", explorers/forecasters/analysts/validators each get appropriate framing. Previously all agent types received the generic "Analyze the following project" preamble.

### Changed

- **`UluOpsClient.runAgent()` accepts `string | ExecutionInput`** — the second parameter now accepts either a target path string (existing behavior) or a full `ExecutionInput` object with `target`, `prompt`, and `options`. This aligns `runAgent` with `runCommand`, `runWorkflow`, and `run`, which already accept `ExecutionInput`. Fully backward compatible — all existing string-based calls continue to work.
- **Empty `Options: {}` suppressed** — when `ExecutionInput.options` is empty or undefined, the `Options:` line is omitted from the initial message instead of rendering `Options: {}`.

## [0.12.1] - 2026-05-20

### Fixed

- **Pipeline decision ignores thrown-error stages** — `computeDecision` now checks `s.status === 'failed'` in addition to `classifyDecision(s.result?.decision)`, so stages that throw (registry unavailable, agent crash) correctly produce a FAIL decision. Previously these stages were invisible to the decision logic because they had no `result` object. `computeStageMetrics` also updated — failed stages now count as both executed and failed instead of neither. Found by GPT-5.5 code-validator run.
- **Parallel command execution silently drops rejected agents** — `executeParallel` now returns agent errors alongside successful results. Partial failures are surfaced as critical recommendations on the aggregated `CommandResult`, so consumers see which agents failed and why. Previously, if some agents succeeded and others threw, the errors were collected but never exposed.

## [0.12.0] - 2026-05-20

### Changed

- **Server-side definition normalization** — `RegistryClient` now requests `?normalize=true` from the registry API and uses the API-provided `normalized` field directly, eliminating client-side YAML parsing for remote definitions. Falls back to local normalization via `@uluops/definition-factory` when the API response lacks a `normalized` field.
- **Normalization import migrated** — switched from `@uluops/registry-sdk/normalization` (removed in SDK v0.26.0) to `@uluops/definition-factory`. Local file resolution uses the factory directly.

### Dependencies

- Added `@uluops/definition-factory` — provides `normalizeDefinition()` for local file resolution and remote fallback
- `@uluops/registry-sdk` — consumes v0.26.0 (`normalized` field on `Definition`, `/normalization` subpath removed)

## [0.11.1] - 2026-05-20

### Security

- **Preflight newline injection prevention** — metacharacter regex now rejects `\n` and `\r` in command strings, which `sh -c` treats as command separators (CWE-78). Added 7 tests covering all metacharacter types.
- **Shell command audit logging** — `runShellCommand` now logs every invocation (command string truncated at 200 chars, output intentionally omitted to avoid secret leakage). Wired through AIProvider for both Anthropic and OpenAI shell tool paths.
- **Preflight TOCTOU window reduction** — replaced sequential `fs.access()` + `fs.realpath()` with `fs.lstat()` + `fs.realpath()` in a single try block, narrowing the race window for symlink swap attacks (CWE-367).
- **brace-expansion DoS fix** — updated brace-expansion to >=5.0.6 via `npm audit fix` (GHSA-jxxr-4gwj-5jf2, CVSS 6.5). LLM-emitted glob patterns could previously trigger large numeric range expansion.
- **Line-range read_file size guard** — `ToolHandler.readFile()` now enforces `MAX_FILE_SIZE` (1MB) in line-range mode, preventing OOM when an LLM requests lines from oversized files.

### Added

- **`maxRetries` config option** — exposed on `UluOpsConfig` and `AIGenerateOptions`, passed through to the AI SDK's `generateText()`. The SDK handles 429/503 retries with exponential backoff and Retry-After header support. Default: 2 (3 total attempts).
- **`clearCache()` on UluOpsClient** — delegates to `RegistryClient.clearCache()` for invalidating the definition resolution cache in long-lived processes.
- **`trackingFailed` field on results** — `AgentResult` and `ExecutionResult` now include a `trackingFailed?: boolean` flag, set when tracking submission fails. Callers can detect silent tracking loss instead of checking for undefined `dashboardUrl`.

### Changed

- **`trackIfEnabled()` decomposed** — extracted `recordExecutions()` private method, separating submission orchestration from execution recording logic.
- **Exploration map section filtering** — `AnalysisSummaryExtractor.extractExplorationMaps()` now filters sections against known types (`inventory`, `topology`, etc.) before `reshapeSection`, eliminating untyped pass-through to the double assertion.

### Fixed

- **README stale naming corrections** — `ValidationClient` → `SubmissionClient`, `validateRun` → `previewSubmission`, `validationUrl` → `submissionUrl`, `ULUOPS_VALIDATION_URL` → `ULUOPS_SUBMISSION_URL`, `ValidationErrorCodes` → `SubmissionErrorCodes` across architecture diagram, advanced exports, config example, env var table, and error table.
- **README `additionalProviders`** — added to Configuration example (was documented in Overview but absent from the config block).

### Documentation

- **wrapAgentResult divergence documented** — added rationale in `CommandExecutor.wrapAgentResult` explaining why three sites (CommandExecutor, WorkflowExecutor, PipelineExecutor) intentionally diverge and why a shared helper would add complexity without value.

## [0.11.0] - 2026-05-20

### Added

- **Per-agent execution recording** — when a command or workflow runs, each participating agent now gets its own execution record in the registry. `trackIfEnabled()` extracts agent name+version pairs from the result tree via `SubmissionClient.extractAgents()` and records each against the registry. Dedup is handled by the per-definition unique index `(definition_id, run_id)` — same tracker UUID can appear on multiple definitions.
- **`SubmissionClient.extractAgents()`** — new public method exposing the agent decomposition logic already used for tracker submission. Returns `Array<{ name: string; version?: string }>` from any `ExecutionResult` or `AgentResult`.

### Design Notes

- Agent recording is non-fatal — if an agent name doesn't match a published registry definition, the failure is silently caught
- Direct agent runs (`runAgent`) skip per-agent recording since the top-level IS the agent
- Pipelines via `startPipeline()` are not covered by this path — the webhook and sync service paths handle pipeline-level per-agent recording via `agent_snapshots`
- See `plans/execution-recording-integrity-spec-v0_1_0.md` for the full spec and name-game analysis

## [0.10.1] - 2026-05-19

### Changed

- **Definition normalization delegated to `@uluops/registry-sdk/normalization`** — replaced 6 private methods in `RegistryClient.ts` (`castDefinition`, `normalizeCommandDefinition`, `normalizeWorkflowDefinition`, `normalizePipelineDefinition`, `validateWorkflowStructure`, `validatePipelineStructure`) with the SDK's canonical `normalizeDefinition()`. Net reduction of 188 lines. Behavior unchanged — the SDK normalizers produce identical output with the added guarantee of immutability (structuredClone). See [ADR-003](https://github.com/Uluops/-uluops-registry-sdk/blob/main/docs/adr/ADR-003-definition-normalization.md) in registry-sdk.

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
