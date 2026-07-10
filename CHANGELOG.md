# Changelog

All notable changes to `@uluops/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). In addition to the standard `Added`/`Changed`/`Deprecated`/`Removed`/`Fixed`/`Security` sections, some entries use a few informational sections — `Internal` (test/CI/build-only changes), `Supply chain` / `Dependencies`, `Design Notes`, and `Migration` — which carry no consumer-facing API impact.

## [Unreleased]

## [0.32.0] - 2026-07-10

### Changed — BEHAVIOR

- **PDL stage gates are now enacted** (tracker G5, issue cf83cd47 — "hard build gate silently auto-passes"). The `gate:` block on pipeline stages (`threshold`, `aggregate`, `on_failure`, `on_success` — PDL `$defs/gate`, schema v1.2.0) was previously parsed but never read: `on_failure: abort` flowed on exactly like `warn`. Now, after each executed stage:
  - The gate **fails** when the stage's vocabulary-resolved decision is negative, the stage errored, or — when `threshold` is set — the aggregated score falls below it (`gate.aggregate` over inline-agent scores, PDL default `min`; ref-based stages use the stage result score). Scoreless stages are **fail-open for the threshold check only** (WorkflowExecutor.evaluateGate precedent) — decision-negative still fails.
  - `on_failure: abort` (also the PDL schema default for a gate that omits it) fails the pipeline: remaining stages are recorded as skipped (`gate_abort`), `wait()` throws `PipelineError` with the partial result. `skip` skips the remaining stages but lets the run complete (`gate_skip`). `warn` logs and continues (previous behavior for all gates).
  - `on_success: skip_remaining` is the early-exit pattern: downstream stages are skipped (`gate_early_exit`), run completes.
  - **An abort-gated steps stage that cannot execute (`allowStageSteps` off) now fails the run loudly** instead of silently stamping `PASS` — the author declared the gate mandatory; an operator who cannot run it has a configuration error, not a skippable step. The error names the remedy (enable `allowStageSteps` or downgrade the gate).
  - Corpus audit (udl/pdl/v1, 2026-07-10): every stage gate declares `on_failure` explicitly (mostly `warn` — unchanged behavior apart from a new warn log). The `abort` gates (`api-server-validate`, `ship`) now actually stop their pipelines — the authored contract.

### Added

- `GateDefinition` type (`types/pipeline.ts`, exported from root and `/types`) and `StageDefinition.gate` — the gate block survives `normalizePipelineSection` untouched (structuredClone, no allowlist); it was reaching the executor all along, just untyped and unread.
- **Integrity pins are now reachable from every execution entrypoint** (tracker 1a49ad7a, security). The `expectedHash`/`expectedPromptHash` verification shipped in 0.20.0 was threaded through `runAgent` only — while the README steers CI (the exact bash-enablement context) to `runCommand`/`runPipeline`, which could not pin. Now: `runCommand` accepts pins in its `overrides`; `runWorkflow`/`runPipeline`/`startPipeline`/`run` accept a trailing `ResolvePinOptions` (newly exported from the package root). All additive-optional; verification remains resolve-time and fail-closed (`IntegrityError`), including cache hits. Scope notes, on the page: pipeline/workflow pins cover the top-level YAML only (stage/phase refs resolve downstream unpinned — per-stage pinning is lockfile territory, deferred with the trust-bootstrap TOFU caveat); `expectedPromptHash` on a promptless type still throws `kind: 'unavailable'`. README: CI bash-enablement now cross-links Integrity Verification with a pinned `runCommand` example.

## [0.31.0] - 2026-07-08

### Changed — BEHAVIOR

- **Pipeline stages now forward upstream results into downstream agents' prompts.** Any inline-agent stage with `depends_on` automatically receives an `## Upstream Analysis` section in each agent's initial message — a severity-sorted slice (decision, decisionCategory, score, summary, top-5 recommendations) of every dependency's results. **This changes the initial message of every multi-stage pipeline run** (77/77 fleet pipelines use `depends_on`; the 68 synthesis pipelines are the intended beneficiaries — dao-li run #10's 3/100 FRAGMENTED "no upstream analyses available" is the motivating defect). Defaults and opt-outs:
  - Producer-side `forward: auto | none | full` and consumer-side `receives: auto | none` on PDL stage definitions (`StageDefinition`); absent fields mean `auto` — forwarding is ON by default.
  - `forward: full` additionally forwards head+tail-retained `rawOutput` (16K head + 8K tail chars, elided middle). Ref-based stages carry no `rawOutput` and degrade to `auto`.
  - Global kill switch: `ULUOPS_DISABLE_STAGE_FORWARDING=1` (or `true`) disables forwarding engine-wide.
  - Caps (provisional, char-based): 8K/stage slice, 24K/stage under `full`, 32K total with a deterministic three-step reduction (findings → narrative → header-only floor; headers and verdicts are never dropped). All truncation is marked in-place.
  (stage-output-forwarding-spec v0.3.1; pre-implementation run #31.)

### Added

- `ExecutionInput.upstreamContext?: UpstreamStageContext[]` — engine-populated transport for the forwarded slices; **not an operator surface** (attached via a per-stage shallow clone, never by mutating a shared input — run #31 A6). New exported type `UpstreamStageContext`, re-exported from the package root and the `/types` subpath (run #57 closed the barrel gap).
- `StageDefinition.forward` / `StageDefinition.receives` (`types/pipeline.ts`) — survive `normalizePipelineSection` untouched (structuredClone; no field allowlist).
- `src/executor/upstreamContext.ts` — pure `buildUpstreamContext` / `renderUpstreamSection` helpers plus cap constants (`UPSTREAM_STAGE_SLICE_CAP`, `UPSTREAM_STAGE_FULL_CAP`, `UPSTREAM_TOTAL_CAP`, `UPSTREAM_KILL_SWITCH_ENV`, …) exported from the package root. README gained a Stage Output Forwarding section and the kill-switch env-table row.

### Design Notes

- **The slice is severity-sorted by the engine** (critical > high > medium > low > info > unknown, stable within tiers) because `flattenRecommendations` produces category-declaration order, not rank — trusting it as ranked would silently drop a critical finding from a late rubric category out of the top-5 (run #31 A2/F2, the pre-impl run's top finding).
- Forwarding is **one hop** (direct `depends_on` only, no transitive closure) and **inline-agent stages only** on the receiving side; forwarding into command/workflow ref executions is the workflow-twin phase (spec §3.6). Fleet grep 2026-07-08: all 68 synthesis stages are inline-agent, so Phase 1 covers every synthesis consumer.
- Labeled-absence entries (`### <stage> — no output (…)`) are reachable only in partial multi-dependency topologies — `checkStageDependencies` skips a downstream stage whenever any dependency is non-completed, so the single-dependency crash case cannot occur by construction. Kept as defensive coverage.
- Steps-only upstream stages forward nothing (their signal already flows through `condition:` expressions). Parallel sibling slices concatenate in declaration order (pinned by an ordering-contract test); siblings never see each other.

## [0.30.0] - 2026-07-08

### Fixed

- **Custom-vocabulary negative verdicts now fail pipeline stages and pipelines** (tracker run #55, `SEM-INC/H`). The inline-agents stage decision was a literal `decision !== 'FAIL'` test, so a cognitive-lens agent's negative verdict (EXPOSED, BEWITCHED, BLOCKED, REJECT) counted as passing and the stage resolved PASS; `computeDecision`/`computeStageMetrics` had the same blindness for command/workflow-ref stages carrying non-core decision strings. Aggregation now gates on the vocabulary-resolved category: AgentExecutor's stamped `decisionCategory` propagates through every wrap/aggregate site and is consumed via `resolveDecisionCategory()`. The crash-exclusion score filter intentionally keeps its literal check — that is the crash signature stamped by the inline rejection path, not a gate.
- **Scoreless multi-agent command aggregation gates on categories** — previously literal `FAILED`/`PARTIAL` only, so a scoreless agent with a custom `completion.vocabulary` negative aggregated to `COMPLETE`.
- **Scoreless negatives gate mixed commands and workflow phases** (ship-cycle findings, code-auditor `SEM-COM/H` + anxiety-reader `SEM-INC/H`). A scoreless child has no channel into an aggregate score, so previously: a passing scored validator masked a scoreless executor's negative in a mixed command, and a workflow phase with scoreless-negative children gated `passed` (null aggregate score passes `evaluateGate` unconditionally). Both boundaries now gate scoreless negatives categorically, the phase honoring its declared `on_fail` posture. SCOPE LINE (deliberate, documented in both sites): *scored* negatives flow through the score gate — the scored-lens-negative case (categorical negative alongside a passing score, e.g. DISORDERED@82) is an open aggregation-semantics question routed to the composition-aggregation spec, not silently decided.
- **Missing-vocabulary classification is no longer silent** — a non-empty decision resolving `neutral` (neither core register nor definition vocabulary — almost always a missing `decisions.vocabulary`/`completion.vocabulary` block) now logs a warning at stamp time, since the neutral stamp is authoritative downstream. Closes the run #52 fail-open-telemetry recommendation.

### Security

- **Vocabulary maps can no longer remap the core decision register** (CWE-345). `buildVocabularyMap` accepted definition-controlled entries targeting stable core strings, and `classifyDecision` checks the vocabulary map before the core register — so a definition declaring `decisions.vocabulary.positive: "FAIL"` made a literal `FAIL` classify, stamp, and propagate as `positive` through every downstream gate (up to `allGatesPassed: true`) with no warning. The prior literal-string comparisons in the executors caught this incidentally; category threading removed that accidental defense, so the guard is now explicit: entries whose value is a core-register string (`PASS`/`SHIP`/`COMPLETE`/`EXPLORED`/`FAIL`/`FAILED`/`BLOCK`/`WARN`/`HOLD`/`PARTIAL`) are ignored, and the core register classifies them correctly. Custom vocabularies (HARMONIOUS, BEWITCHED, …) are unaffected; redundant agreeing declarations (`positive: "PASS"`) lose nothing.
- **LLM-origin decision strings are sanitized before log interpolation** (CWE-117). The new missing-vocabulary warning interpolated the model-produced (prompt-injection-influenced) decision string verbatim; it is now control-character-stripped and length-capped before logging so it cannot forge log lines or inject ANSI/structured-log payloads.

### Added

- `ExecutionResult.decisionCategory` — optional normalized category, populated at all producing sites: `CommandExecutor.wrapAgentResult` (agent passthrough), `CommandExecutor.aggregateResults` (aggregation outcome), `WorkflowExecutor.aggregate` (derived from phase outcomes, so WDL-remapped SHIP/HOLD/BLOCK strings stay gateable), `WorkflowExecutor.wrapAgentResult`, the pipeline inline-agents/steps stage synthesizers, and the pipeline result itself (`buildResult`, where CANCELLED is deliberately `neutral`).
- `resolveDecisionCategory(result)` (exported) — aggregation-safe category resolution: prefers the stamped `decisionCategory` (only the producing executor had the definition's vocabulary in hand), falls back to `classifyDecision(decision)` over the core registers.

### Dependencies

- Bump `@uluops/ops-sdk` 5.6.0 → 5.7.0 (exact pin). Type/`OpsClient` surface consumed by `SubmissionClient` and `AnalysisSummaryExtractor` remains compatible — no threading changes; build and full suite green against the new version.

### Design Notes

- Unstamped custom decision strings still resolve `neutral` — the fallback boundary is explicit and tested. Producers must stamp; consumers must resolve. SCOPE.md's "Error propagation across layers" tension moves from Unexamined to Partially examined (decision propagation closed; thrown-error propagation remains open).
- **Verdict coloring is not halting:** a negative-verdict stage keeps `status: 'completed'`, and pipeline `depends_on` gates on completion — downstream stages still run after an upstream FAIL verdict (only thrown/skipped stages block dependents; the pipeline-level decision is still correctly negative). Verdict-gating a downstream stage requires an explicit `condition` on `stages.<id>.decisionCategory`, which fails open if the upstream stage crashed. A pipeline-level `on_failure` posture does not exist yet.
- **Mixed-version contract:** `decisionCategory` is optional, so results produced by 0.29.x (or hand-built without the stamp) fall back to `classifyDecision` over the raw string — custom-vocabulary negatives from unstamped results resolve `neutral` and do not gate. Custom-negative gating is only as strong as the producing side's version.
- **Gate polarity is deliberately asymmetric:** executor gates fail open on ambiguity (must resolve `negative` to block), submission's `allGatesPassed` fails closed (must affirmatively resolve `positive`). An ambiguous result flows through stages but is never reported as a pass. Documented at `SubmissionClient.isPositiveDecision`.
- Consumers relying on the old literal `PASS|SHIP` fallback should note: scoreless `COMPLETE` commands and WDL-remapped positive workflow decisions now correctly report `allGatesPassed: true` (Aporia A3 closed for non-PASS positives).

## [0.29.1] - 2026-07-07

### Changed

- **Absent params in condition expressions are `false`, not unknown** (spec D5 amendment). Within the `params` namespace, absence is a value: a bare `params.x` with `x` unset evaluates `false` (so `!params.x` is `true`), `params.x == <literal>` is `false`, and `params.x != <literal>` is `true`. Ordering comparators over an absent param remain unknown (fail-open). Stage/step path absence keeps fail-open unknown semantics — there absence signals a typo or missing stage, where running-anyway is the safety property. Aligns engine gating with the rendered-markdown/harness path (unset params read as false) and stops params-gated agents from dispatching on every engine run. Origin: first live engine run dispatched `frontend-validator` against a frontend-less target because `params.frontend || <detect>` failed open (tracker issue `e9399a31`).

## [0.29.0] - 2026-07-07

### Added

- **Engine execution of PDL stage `steps:` blocks, behind an opt-in** (`allowStageSteps` config / `ULUOPS_ALLOW_STAGE_STEPS=true`; default off). New internal `StepsExecutor` runs steps sequentially via `sh -c` honoring the full PDL step contract (timeout, retries, `retry_delay`, `continue_on_error`, `always_run`, `expect_empty`, `expect_match`, per-step `env`, `working_dir`). Per-step results surface on `StageResult.steps`. Confinements: secret-class env vars scrubbed from the step environment; `step.env` keys overriding `LD_*`/`DYLD_*`/`NODE_OPTIONS`/`PATH` rejected; `working_dir` realpath-contained to the target root; `retries` capped at 10 and `retry_delay` at 60s; `{{ params.x }}` substitutions shell-quoted (CWE-78) with unresolved templates failing the step. (pdl-steps-execution-spec-v0_1_1 Phase 2; pre-impl run #49 PROCEED.)
- `ExecutionInput.params` — run-parameter channel consumed by step-command template substitution (`{{ params.x }}`, `{{ params.x || fallback }}`; `target` implied). Condition-expression evaluation over params is Phase 3.
- Exported types `StepDefinition` and `StepResult`; `StageDefinition.type` widened with `'steps'`; `workflows?`/`commands?` typed `@reserved` on `StageDefinition`.

### Added (Phase 3 — condition evaluation)

- **Condition-expression evaluator** (`src/executor/conditions.ts`): three-valued (Kleene) evaluation of `||`/`&&` compositions, unary `!` negation, bare-path truthiness, and comparators over `params.<name>`, `stages.<id>.<field>`, `stages.<id>.steps['<name>'].<field>`, and the legacy `<id>.<field>` form. Unresolvable paths (missing stage/param, unsupported `trigger.`/`context.` namespaces) yield unknown → FAIL OPEN (run + warn); fail-closed is deferred to a corpus-audited PDL v1.3.0 decision (spec OQ3). Expressions longer than 512 chars (`MAX_CONDITION_LENGTH`) are likewise treated as unknown → fail open.
- **Per-agent `condition` gating**: inline-agent entries (`stage.agents[].condition`) are evaluated against prior-stage results and run params before dispatch — unmet conditions mean the agent is not dispatched and not scored (no fabricated result). This is what makes detection preflights actually gate: verified against post-implementation's real conditions (type-safety dispatches on `Detect TypeScript == DETECTED`; mcp/frontend validators gate off).

### Changed

- **`stage.condition` semantics flipped to run-gate (PDL-spec alignment)** — the stage runs when the condition holds and is skipped (`condition_not_met`) when it is definitively false. The engine previously read `condition` as skip-if-true, inverted relative to the PDL spec and the rendered markdown; the old grammar never successfully parsed any corpus condition, so no existing pipeline depended on the inverted reading. `skip_if` (deprecated) keeps skip-if-true semantics.
- **Steps-only pipeline stages no longer fabricate `score: 100`** — without the opt-in they pass through as `decision: PASS` with a `null` score pair, excluded from pipeline-level score aggregation. Pipeline averages that previously included the synthetic 100 will shift down; `depends_on` chains over preflight stages are unaffected (stage remains `completed`). Root cause: steps-block investigation run #48 (G1) — the fabricated 100 inflated averages, incremented `stagesPassed`, and satisfied downstream gates for work that never ran.
- **Stages with no executable content now fail loud** — a stage with no `ref`, no `agents`, and no `steps` (e.g. a multi-entry `workflows:`/`commands:` array the engine cannot run) throws `PipelineError` instead of auto-passing (spec D7).
- **Single-entry `workflows:` arrays are hoisted** — `normalizePipelineSection` infers `type: 'workflow'` and hoists the entry's `ref` so the stage executes (un-breaks `api-server-validate`'s validation stage; entry `args` are not threaded — pre-existing gap). Steps-only stages are inferred as `type: 'steps'`.
- `StageResult.type` mapping made total: `agents`/`steps`/untyped stages map to `'command'` in results (public union unchanged).

### Design Notes

- The D2 interim posture (null score but `completed`/`PASS` for unexecuted steps stages) deliberately retains one dishonesty — a PASS that verified nothing — to avoid cascading `depends_on:[preflight]` skips across the 30 detection pipelines. Full honesty arrives when steps execute under the opt-in. See pdl-steps-execution-spec-v0_1_1 D2.

## [0.28.2] - 2026-07-06

### Dependencies

- **Advanced the `@uluops/*` pins to the sdk-core 0.15.0 coherent set:** `sdk-core`
  `0.14.0` → `0.15.0`, `ops-sdk` `5.4.0` → `5.6.0`, `registry-sdk` `0.38.0` →
  `0.39.0`. sdk-core 0.15.0 adds the streaming transport (`requestStream`/`getStream`);
  core does not consume it, so this is a pin-alignment patch — it collapses the tree
  to a single `sdk-core@0.15.0` (no nested duplicate) and carries no consumer-facing
  API change. `request()` behavior is unchanged.

## [0.28.1] - 2026-07-03

### Fixed

- **Off-vocabulary record severities no longer kill the tracking save**
  (tracker issue `9e15b469`). Cognitive lens agents emit register-style
  severities (`structural`, `epistemic`, `tactical`, …) in their analysis
  records; the SDK's input validation rejects the whole `save_run` when any
  record's `severity` is outside `critical/high/medium/low/info` — one
  off-vocabulary record meant the entire run went unrecorded (observed live
  on both `laozi-analyst` and `anxiety-reader`). All record tiers now funnel
  through a sanitizer at extraction: enum values are case-normalized, and
  anything else is coerced to `null` with the original preserved as
  `data.rawSeverity` — the save always goes through, and no signal is lost.

## [0.28.0] - 2026-07-02

`systemMetrics` means cognitive measurements again — execution telemetry
separated out of analysis data.

### Changed

- **`AnalysisSummaryExtractor` no longer merges the execution envelope into
  `systemMetrics`** (tracker issue `762f58be`; system-metrics-contract spec
  v0.1.2 D4). `systemMetrics` now carries the agent's cognitive measurements
  only — analysis-block `system_metrics`, else structured-output
  `domainMetrics`, else **`null`** (a run with no cognitive metrics has no
  system metrics). Tokens/model/duration were always redundant here — they
  travel first-class on `agents[]` via `SubmissionClient.resultToAgent`.
  `costUsd` (derivable from tokens + pricing) and `toolCallCount` (execution
  fact) are dropped from analysis data.
- **Extraction facts move to `epistemicAssessment`** as
  `extraction_confidence` / `extraction_method` — they are epistemic facts
  about the parse. Merged after resolution across both branches; the agent's
  own keys always win; results with undefined extraction fields contribute
  nothing (an empty merge stays `null`).

### Design Notes

- Consequence: `epistemicAssessment` is non-null for any summary whose result
  carries extraction facts (previously null without an agent epistemic
  block); `systemMetrics` is nullable (previously always an envelope-bearing
  object). Downstream tracker rows written by ≤0.27.0 carry the old envelope
  — no backfill (spec D5); the ops-api ingest floor (1.65.0) annotates
  wrong-shaped values but deliberately does not strip these all-scalar keys.

## [0.27.0] - 2026-07-02

Adopts `@uluops/sdk-core@0.14.0` across the SDK tree and exposes its structured
security-event channel through core's config.

### Added

- **`UluOpsConfig.onSecurityEvent`** — a structured security-event handler
  forwarded to both underlying SDK clients (registry + submission), so it covers
  security-relevant events across all of core's UluOps API traffic: a rejected
  credential (`auth_failure`), a blocked upstream redirect (`redirect_rejected`,
  a possible-MITM signal), a failed token refresh, or a credential swap. Notably
  it surfaces events on the **best-effort tracking-submission path**, where a
  failure is otherwise softened into a non-fatal log line. Best-effort and
  fire-and-forget (a throwing handler never breaks a run). The `SecurityEvent`
  union and its member types are re-exported from the package root for typing
  handlers. This is the first SDK operational callback core exposes — justified
  because it is security telemetry, not operational tuning.

### Dependencies

- **Bump `@uluops/sdk-core` 0.13.0 → 0.14.0, `@uluops/ops-sdk` 4.0.0 → 5.4.0,
  `@uluops/registry-sdk` 0.36.0 → 0.38.0.** Adopts the sdk-core security-observability
  release (redirect hardening via `redirect: 'manual'`, `baseUrl` embedded-credential
  rejection, sanitized `requestId`) across core's entire SDK dependency tree, so
  everything core resolves at runtime is on a single, current sdk-core. The ops-sdk
  5.0.0 breaking change (`maxScore` nullability) affects types core uses internally
  and does not re-export — no core behavior change.

## [0.26.0] - 2026-06-28

### Added

- **Cross-harness token components** (additive, non-breaking). `cached_input_tokens` on
  `UsageMetrics`; `cachedInputTokens` + `reasoningOutputTokens` on `ExecutionMetrics`
  (joining the existing `thinkingTokens`), aggregated by `sumTokenMetrics`. reasoning/thinking
  are subsets of GROSS output — stored, never re-added to `totalEffectiveTokens`.
- **`harness` on `ExecutionMetrics`** — `@uluops/core` emits `'uluops-core'` (vendor-derived;
  core runs OpenAI/Google, not a constant `claude-code`). Canonical vocabulary §2.4 (G4).

### Changed

- **Cached-input disentangle (§3.2).** OpenAI `cachedPromptTokens`, Google
  `cachedContentTokenCount`, and the generic-provider cached scan now populate the new
  `cached_input_tokens` instead of aliasing into `cache_read_input_tokens`. `cache_read_input_tokens`
  now holds only genuine Anthropic-style cache reads. **Behavioral** for OpenAI/Google cache fields.
- **`total_effective` now subtracts cached input** — `calculateEffectiveTokens` →
  `(input − cached_input) + output_gross + cache_creation` (clamped at 0). Completes the
  v0.25.1 `+ thinking` removal; together they **lower** stored `total_effective` for
  OpenAI/Google runs (the live sample 17922 → 9335). See cross-harness-token-normalization-spec §3.2/§4.1.

## [0.25.1] - 2026-06-28

### Fixed

- **`total_effective_tokens` no longer double-counts Google thinking tokens.** `calculateEffectiveTokens` added `+ thinking_tokens` on the premise that Google charges thoughts "separately from output." Verified live against `gemini-3-flash-preview`, this is false: the Vercel AI SDK folds thoughts **into** `res.usage.outputTokens` (`outputTokens = text + thoughts`, with `reasoningTokens` a subset). Adding `thinking_tokens` therefore counted them twice. The term is removed; the effective total is now `input + output + cache_creation` (output already gross — reasoning and thinking are both inside it). `thinking_tokens` remains a recorded component on `ExecutionMetrics`. **Behavioral:** Google runs' `total_effective_tokens` drop by their thinking amount (previously over-counted); non-Google runs are unaffected (`thinking_tokens` is Google-only). A separate, cascade-scoped fix (subtracting cached input) will lower Google/OpenAI effective further.

## [0.25.0] - 2026-06-26

### Changed

- **Analysis recordId generation now targets 100 characters (was 20).**
  `AnalysisSummaryExtractor.safeRecordId` preserves an agent-provided or failure-code
  recordId verbatim when it is ≤ 100 chars, so semantic, namespaced IDs (e.g.
  `foundations-api-aristotle-20260626`) survive instead of being hashed away. IDs over
  100 chars still fall back to a bounded deterministic `r-<hash>`. The universal
  output-schema `recordId` description is updated to match. Mirrors ops-api migration
  058 and the SDK/MCP request schemas; kept as a local constant to avoid coupling
  `@uluops/core` to a specific ops-sdk version.

## [0.24.3] - 2026-06-24

### Fixed

- **Workflow `command:` steps no longer block on agent/command name collisions.** `WorkflowExecutor.executeStep` resolved a `command:` step *untyped* ("resolve, then route by actual type") to support WDLs that use `command:` for agents. But a name published as BOTH an agent and its per-agent invocation command — every cognitive-lens analyst (`aristotle-analyst`, `popper-analyst`, …) — made that untyped resolve ambiguous (`Multiple definitions named "X" found (agent, command)`), blocking every phase. This was latent and ecosystem-wide (the executor path is identical for local and remote workflows); it surfaced only once 0.24.2 let locally-resolved workflows reach execution instead of failing earlier. Command-steps now resolve **command-first** and fall back to the agent definition only when no command by that name exists — preserving the documented `command:`→agent support without the ambiguity throw.

## [0.24.2] - 2026-06-24

### Fixed

- **Locally-resolved workflows no longer silently BLOCK.** `RegistryClient.normalizeLocally()` passed the raw parsed YAML straight through (`structuredClone`) without applying the authoring→runtime transforms that the remote path gets server-side. A locally-resolved (`localDefinitions` / `--local-definitions`) **workflow** therefore reached `WorkflowExecutor` with WDL `steps[]` instead of `commands[]`/`agentRefs[]`; `executePhase` calls `phase.commands.map()` on `undefined`, every phase is caught as a blocked phase, and the workflow returns `Decision=BLOCK`, score 0, 0 agents run — looking like it executed and failed. Workflows were the only definition type affected (agents render via the API fallback; pipeline stages key off `agents[]` presence). Local resolution now applies the same CDL/WDL/PDL normalization as the registry: WDL `steps[].command`→`commands[]`, `steps[].agent`→`agentRefs[]`, `condition`→negated `skip_if`, `gate.aggregate` default; CDL `invokes.agent`→`agents[]`; PDL stage-type inference; plus structural validation (malformed local definitions now throw `ConfigurationError` instead of failing deep in execution).

### Design Notes

- The normalization transforms are a **faithful port** of `@uluops/definition-factory`'s `src/normalization/` module into `src/registry/normalize.ts`, NOT a dependency. `@uluops/definition-factory` is private IP (rendering engine, templates, scoring/translation) and `@uluops/core` publishes publicly to npm, so a dependency edge would force the factory's install tree public. Only the mundane authoring→runtime field mappings are reproduced; none of the factory's IP is involved. Keep the ported module in sync with the factory source (drift between local and server normalization reintroduces exactly this class of local≠remote bug).

## [0.24.1] - 2026-06-23

### Fixed

- **`TrackingError` is now exported from the package root.** 0.24.0 defined `TrackingError` (in `src/types/execution.ts`) and added it to the `src/types` sub-barrel, but the package root (`src/index.ts`) re-exports types explicitly and was not updated — so `import { TrackingError } from '@uluops/core'` failed to resolve for consumers. Add it to the root execution export. 0.24.0 is otherwise functionally complete; upgrade to 0.24.1 to reference the type by name. (Caught by the `@uluops/cli` tracking-failure render before it shipped.)

## [0.24.0] - 2026-06-23

### Added

- **Typed `trackingError?: TrackingError` on `AgentResult` and `ExecutionResult`** (alongside the retained `trackingFailed?: boolean`). When a run's result-submission to the tracker fails — `402 PROJECT_LIMIT`, `SUBSCRIPTION_REQUIRED`, 401/403/429, 5xx, network, timeout — the failure is no longer collapsed to a bare boolean: `trackingError` carries a stable machine `code` (the contract), `statusCode`, human-readable `message`, `requestId`, and structured `details` (e.g. `upgradeUrl`, `currentCount`, `limit`). Mirrors the `DegradationMarker` typed-marker convention — `code` is matched on, `message` is not. **Non-fatal**: the agent run still resolves successfully; only recording failed. Populated in `UluOpsClient`'s existing submission catch from the SDK API error. Lets consumers (e.g. `@uluops/cli`) surface the upgrade prompt instead of silently dropping the dashboard link.

## [0.23.0] - 2026-06-22

### Changed

- **`AgentResult.score`/`maxScore`, per-category `score`/`maxScore`, and `Finding.pointsEarned`/`pointsPossible` are now `number | null`.** Generators and executors produce artifacts, not scores — they emit `null` instead of a fabricated `0`/`100`. The pair-resolution invariant holds: **`score === null` iff `maxScore === null`**. Validators are unaffected — a present score keeps its scale. **Breaking for TypeScript consumers** that read these fields as `number`: narrow against `null` before arithmetic/formatting (the type now surfaces cases previously masked by fabrication). `agentOutputSchema` relaxes `score`/`maxScore` to `z.number().nullable()` — **no `.min/.max`** (a structured-output spike found Anthropic rejects numeric range constraints and OpenAI strict rejects `.optional()`); the 0-100 range is now enforced at the `AgentExecutor` mapping with a clamp + warn.
- **Null is preserved end-to-end, not re-fabricated.** Permissive parsing (`OutputNormalizer`/`OutputExtractor`) no longer synthesizes `0`/`100` for scoreless output — real extracted category scores keep their `100` scale, the ERROR sentinel scores `null`. Pipeline/Workflow crash synthetics emit `null`; `CommandExecutor` **excludes** scoreless results from aggregation (no longer folded in as `0`). `SubmissionClient` sends `score: null` with the scale omitted, omits `summary.averageScore` when scoreless (the tracker computes the average over scored agents or stores null), and preserves null on read instead of coercing to `0`.

### Added

- `_AssertScoreShapedFieldsNullable` compile-time guard in `outputSchemas.ts` — hard-fails the build if any score-shaped field drifts from `number | null`.
- Value-level `null`-iff invariant warning + out-of-range score clamp/warn at the `AgentExecutor` mapping (range enforcement's new home).

### Design Notes

- **Why `null`, not `0`.** The change preserves the distinction between *"scored zero"* (a real low score) and *"did not score"* (a generator/executor). Fabricating `0`/`100` conflated them; `null` keeps them separable for analytics, gating, and lineage. Origin: Zhuangzi finding on `-uluops-core` (EPI-OVR/M, run `f7f3d858`).

## [0.22.7] - 2026-06-16

### Dependencies

- **Bump `@uluops/registry-sdk` 0.34.0 → 0.35.0, `@uluops/ops-sdk` 3.1.0 → 3.3.0, `@uluops/sdk-core` 0.12.0 → 0.13.0** (all exact). The registry/ops SDKs at these versions re-pin `@uluops/sdk-core` to `0.13.0`; core's own direct `sdk-core` pin moves in lockstep so the whole tree resolves a **single** `sdk-core` copy (avoids two error-class identities and the resulting `instanceof` breakage across the SDK boundary). Runtime fixes pulled in from `sdk-core` 0.13.0: `retries: 0` now makes one attempt and surfaces the real typed error instead of a contextless `Error('Request failed')`; a 401 with credentials present yields an actionable `UnauthorizedError` (server reason preserved + guidance); `isApiKey()` enforces the minimum key length. No core API change. 716 tests green against the new SDKs.

## [0.22.6] - 2026-06-16

### Internal

- **Locked the `buildAnalysisRecords` tier precedence.** The record-derivation cascade (analysis-block → structured-output → exploration-maps → recommendations) is first-non-empty-wins, with each tier the primary source for a different agent class — so the ordering is a contract, and a reorder/removal silently changes the persisted record shape for that class. Documented the cascade semantics + per-class mapping on the method, and added "record tier precedence" boundary tests (T1>T2, T2>T3, T3>T4; T1>T4 was already covered) so any future tier change is a loud failure rather than silent data loss. No behavior change. (tracker 30ac11b3, STR-INC/L)

## [0.22.5] - 2026-06-16

### Design Notes

- **Documented why `DEFAULT_CAPABILITIES.structuredOutput` is default-deny.** Models absent from the registry (unregistered explicit `provider:modelId`, or an alias with no model object) fall back to these defaults; `structuredOutput: false` is intentional — with no capability data, assuming structured-output support produces hard API errors when wrong, whereas text extraction works for any model emitting a JSON fence (and is non-destructive since the Option B fix). Added a source comment so the deliberate default isn't "fixed" to `true`. No behavior change. (tracker 8caa7b45, PRA-FRA/L)

## [0.22.4] - 2026-06-16

### Internal

- **Config resolution extracted to pure, directly-testable functions.** `resolveConfig`/`resolveAIConfig` (plus `parseMaxConcurrency`/`parseAllowedTools`) moved from private `UluOpsClient` methods to module-level functions that take an explicit `env` argument (defaulting to `process.env`). No public API change — neither is re-exported from the package entry; behavior is identical (the constructor still calls `resolveConfig(config)`). This replaces ~25 brittle `UluOpsClient` tests that introspected the mocked `RegistryClient` constructor's arguments to observe resolved config — they now assert the pure function's return value against an explicit env, decoupled from collaborator wiring and immune to global-env pollution. Added HTTPS-enforcement, localhost-allowance, and offline-no-key behavioral cases. (tracker 385650e4, EPI-GRN/M)

## [0.22.3] - 2026-06-16

### Fixed

- **Analysis analytics no longer silently lost when raw output is truncated.** `AnalysisSummaryExtractor` regexes the closing ```json analysis fence out of `rawOutput`, but `rawOutput` is capped at `MAX_RAW_OUTPUT_BYTES` (512 KiB) in `AgentExecutor` for storage/display. A report exceeding the cap is clipped at the end, dropping the closing fence — so `analysis_summary`/`analysis_records` would vanish on an otherwise successful run. The extractor now falls back to the untruncated `rawJson.analysis` (captured by `OutputExtractor` from the full output) when the fence is absent, eliminating the boundary entirely. Non-truncated runs are byte-for-byte unchanged (the `rawOutput` fence remains the primary path). (tracker d03bdb43, EPI-OVR/M)

## [0.22.2] - 2026-06-16

### Security

- **Preflight backslash rejection (honoring the 0.8.2 claim).** The `command` preflight metacharacter blocklist now rejects backslash (`\`), closing line-continuation and word-level obfuscation in command templates. The 0.8.2 changelog documented this guard as added, but it was never present in the regex (`/[;|&`\n\r]|\$\(/`); the code now matches the documented security guarantee. No legitimate preflight command (`test`/`git`/`grep`/`find` existence checks) uses an unquoted backslash, and quoted `$ARGUMENTS` backslashes are stripped before the check, so this is a no-op for valid commands.

### Dependencies

- Bumped `@uluops/registry-sdk` `0.32.1` → `0.34.0`.

## [0.22.1] - 2026-06-16

Documentation, transparency, and developer-experience hardening — the resolved output of four `consumer-validate` passes (60 findings fixed and verified). No change to the execution model; the only behavioral deltas are warning-noise reduction and a friendlier error class on the typed-resolve not-found path.

### Changed

- **Documentation sweep.** Added `@param`/`@returns`/`@throws` across the primary `UluOpsClient` execution methods and submission wrappers, all four executor `execute()` methods, `RegistryClient.resolve()`, `AIProvider.generate()`, `OutputExtractor`, `SubmissionClient`, `ModelCatalog`, and `TokenBudgetTracker`; added `@example` to `runAgent`, `describe`, `classifyDecision`, `buildVocabularyMap`, `RegistryClient.resolve`, and `OutputExtractor.extractWithMetadata`; added interface-level JSDoc to exported ADL schema types. README now documents the exported constants, `resolutionMarkersFromLegacy`, `PipelineHandle`, `ExecutionMetrics`/`DegradationPhase`/`DegradationSeverity`/`AIGenerateResult`, the `ULU_API_KEY` fallback, and links `ARCHITECTURE.md`; SCOPE.md corrected to describe caller-pinned fail-closed integrity verification.
- `CommandExecutor` now throws the typed `ExecutionError` (instead of a raw `Error`) for the empty-agent-refs defensive assertion.
- **Typed definition resolution now throws `ConfigurationError` (not a raw `NotFoundError`) when a definition is missing.** `runAgent`/`runCommand`/`runWorkflow` previously surfaced the underlying SDK `NotFoundError`; they now match the untyped `run()` path with a message pointing to `client.list()`/`ULUOPS_API_KEY`.
- `SubmissionClient` no longer eagerly constructs the underlying `OpsClient` when tracking is disabled and no API key is configured — removes misleading "No credentials found" warnings during offline usage.
- Registry not-found errors now point to `client.list()` and `ULUOPS_API_KEY` for remediation; the render-unavailable warning now reads "(non-fatal — using raw YAML fallback)"; the tracking-failure warning now includes a `trackingEnabled: false` suppression hint; `RegistryClient.list()` logs a debug line at the start of its remote attempt so offline retry/backoff is distinguishable from a hang.

### Removed

- **`PipelineState` and `ResolvedExecutionContext` are no longer exported.** Both were internal-only types (pipeline-execution tracking state and merged agent execution context); the public surfaces are `PipelineHandle` and `ExecutionOptions`/`AgentResult` respectively. (Type-only removals.)

### Fixed

- Removed a stale `dist/validation/ValidationClient.js` artifact from the published tarball.
- Tagged the README Architecture ASCII diagram fence with a language identifier and added `text` tags to the `ARCHITECTURE.md` chain-trace blocks.

### Internal

- New test: typed-resolve 404 wrap (`ConfigurationError` with `client.list()` guidance). Suite → 707.

## [0.22.0] - 2026-06-15

Execution completeness & typed degradation markers (Tier 1). Gives every core-executed agent run a **completeness** signal — `complete` / `partial` / `failed` — distinct from the agent's decision, so a confident-looking report built on incomplete coverage is no longer indistinguishable from a clean run. Spec: `uluops-specifications/specs/drafts/plans/execution-completeness-spec-v0_2_1.md`. Addresses run `8dde22ed` issues #2b (`c60fc3c4`), #3 residual (`5aa1ff44`), #6 (`f76b8b50`).

### Added

- **`DegradationMarker` type** (`src/types/degradation.ts`): `{ code, phase, severity, detail? }`. `code` is a stable, namespaced machine token (the contract); `detail` is human-only and explicitly not a contract. `phase` is `resolution` | `execution`; `severity` is `info` | `degraded` | `critical`.
- **`AgentResult.degradationMarkers`** and **`AgentResult.completeness`** (`Completeness = 'complete' | 'partial' | 'failed'`). Completeness is *derived* from marker severities (`deriveCompleteness`): any `critical` → `failed`; any `degraded` → `partial`; else `complete`. The engine observes completeness; agents never self-report it.
- **Execution-phase markers**, new this release:
  - `budget.forced-wrap-up` (degraded) — the context-budget latch was engaged at run end (`TokenBudgetTracker.forcedWrapUp`, set on latch / cleared on hysteresis release, so a recovered run is not flagged).
  - `steps.near-exhaustion` (degraded) — the tool loop was cut at the step ceiling (`finishReason === 'tool-calls'`) with output already present. Detected via `finishReason`, not a step-count comparison, because the effective ceiling is `maxSteps + (structuredOutput ? 2 : 0)`. The empty-output form remains a thrown `MaxStepsExhaustedError`.
  - `extraction.failed` (critical, confidence 0) / `extraction.low-confidence` (degraded, `0 < c < EXTRACTION_CONFIDENCE_THRESHOLD`).
- **Exports:** `deriveCompleteness`, `resolutionMarkersFromLegacy`, and the degradation types from the package root and `@uluops/core/types`.

### Changed

- **`AgentResult.degradations: string[]` is now `@deprecated`** but unchanged in behavior — it remains the byte-exact legacy alias (old colon-style strings, resolution-phase only). The typed `degradationMarkers` are derived from it (`resolutionMarkersFromLegacy`), reconstructing the dynamic `runtime:missing-<field>` form and preserving order/duplicates. Removal is deferred (Tier 2).
- **No change to recording or gating.** The submission transform does not map the new fields and `SubmissionClient.isPositiveDecision` is untouched — completeness is observational in this release. Persistence, analytics exclusion of degraded runs, and gating integration are deferred to Tier 2.

### Internal

- New tests: `deriveCompleteness` rule table, `resolutionMarkersFromLegacy` byte-exact mapping, `TokenBudgetTracker.forcedWrapUp`, AIProvider latch-sets-tracker-flag, and AgentExecutor completeness/marker cases. Suite → 706.
- Pre-implementation-architect reviewed (PROCEED, 88/100); required amendments folded into spec v0.2.1 before implementation.

## [0.21.1] - 2026-06-15

Resilience hardening for the agent execution engine, addressing three high-severity findings from forecaster run `8dde22ed` (project `-uluops-core`). All three share one failure shape: a resource guard (retry / context-budget latch / step ceiling) that degraded toward silent, confident-looking wrong output instead of an explicit incomplete signal.

### Added

- **Global LLM-call concurrency limiter (SEM-INC/H).** A shared `Semaphore` (`src/ai/Semaphore.ts`) now gates **every** `AIProvider.generate()` call, so total in-flight LLM requests are bounded across the whole engine regardless of how wide any single fan-out is — workflow topological levels, parallel phase steps, and inline pipeline agents all draw from the same pool. This prevents unbounded fan-out × per-request retry from collectively sustaining a provider rate limit (the protective retry inverting into the dominant stressor). Configurable via `UluOpsConfig.maxConcurrency` → `ULUOPS_MAX_CONCURRENCY` env var → `DEFAULT_MAX_CONCURRENCY` (8). This is a global cap, distinct from the per-workflow `max_parallel` knob which only governs one fan-out layer. The `Semaphore` is internal (not part of the public export surface).
- **`MaxStepsExhaustedError` (PRA-FRA/H).** New typed error (`src/errors/index.ts`, code `MAX_STEPS_EXHAUSTED`, extends `ExecutionError`) exported from the package root. `AgentExecutor.execute` now throws it when the model produces empty output **and** `finishReason === 'tool-calls'` — i.e. the tool loop was cut at the `maxSteps` ceiling while the model still wanted to call tools. Previously this empty output extracted to a low-confidence default decision (typically `FAIL`), indistinguishable at the result layer from a crash. The error carries `steps` and `finishReason`; callers can branch on `instanceof MaxStepsExhaustedError` or `error.code` to surface "raise maxSteps / narrow the target" guidance. A normal `stop` finish with empty text still flows through graceful extraction unchanged.

### Changed

- **Context-budget wrap-up latch is now releasable via hysteresis (PRA-FRA/H).** `buildBudgetPrepareStep` latches wrap-up on at 80% of the resolved-window budget and now releases it once context falls back below 70% (previously the latch was permanent for the remainder of the run). After provider-side context eviction — e.g. Anthropic context management clearing old tool uses — input size genuinely drops, and tool calls are re-enabled instead of forcing premature wrap-up for a run that has plenty of room again. The 10-point band prevents flapping at the boundary. (Decoupling "gathered-enough" from "out-of-room" and emitting a forced-wrap-up coverage marker remain open, tracked separately.)
- **`ExecutionError.code`** is typed as the broader `UluOpsErrorCode` union (previously the bare `'EXECUTION_ERROR'` literal) so `MaxStepsExhaustedError` can override it with a more specific code. No runtime behavior change.

### Internal

- New `DEFAULT_MAX_CONCURRENCY` constant; `maxConcurrency` added to `UluOpsConfig` (optional) and `ResolvedConfig` (required, defaulted in `UluOpsClient`).
- New tests: `Semaphore.test.ts` (concurrency bound, release-on-throw, FIFO drain, non-positive clamp), AIProvider latch-reset hysteresis, and AgentExecutor maxSteps-exhaustion throw + negative case. Suite → 690.
- The universal output schema's `.nullable()` convention (PRA-FRA/H from the same run) was reviewed and **accepted as-is**: it is a hard OpenAI strict-mode constraint, the null→undefined remap is small and centralized, and the compile-time sync guard is a feature. Already documented in `src/parser/outputSchemas.ts`; routing evolution belongs in the model-capability catalog instead.

## [0.21.0] - 2026-06-15

### Changed

- **Non-destructive extraction-confidence handling (Option B).** A correctly-parsed `decision` is no longer overwritten just because a low-confidence extraction method (e.g. 0.5 regex on structured text) produced it. The decision always reflects the actual parsed value; extraction trust is expressed separately via `extractionConfidence` / `extractionMethod` on the result. Whether a low-confidence result passes a gate is decided downstream by `SubmissionClient` (extraction-confidence threshold), not by erasing the decision in `AgentExecutor`. Removes the previous `EXTRACTION_FAILED` sentinel overwrite.
- **Capability-gated structured-output-with-tools (Option C).** Whether a request uses structured output when tools are present is now driven by the model catalog's `structuredOutputWithTools` capability flag rather than a provider-name branch. Models that reject structured output and tool calling in the same request (e.g. Google/Gemini) are marked `structuredOutputWithTools=false` at model sync and fall back to free-form extraction; absence of the flag means allowed.

### Internal

- Locked `@uluops/registry-sdk` to `0.32.1` (the `structuredOutputWithTools` capability field).

## [0.20.0] - 2026-06-14

### Added

- **Caller-pinned integrity verification at `resolve()`.** `RegistryClient.resolve(name, version?, type?, opts?)` accepts `{ expectedHash?, expectedPromptHash? }` and verifies the resolved definition against the caller's pins — fail-closed — on **every** return path (cache hit, local, remote). Pins come from a trusted, independent channel; verification uses the shared `@uluops/sdk-core` hash util so it matches the registry's stored hashes by construction. Pins are not part of the cache key — verification is per-call and the shared content cache is verified on every hit.
- **`IntegrityError`** (`src/errors/index.ts`, code `INTEGRITY_ERROR`) with `kind: 'yaml' | 'prompt' | 'unavailable'`, expected/actual, and definition name/version. `unavailable` covers a prompt pin on a definition with no frozen rendered prompt (WDL/PDL, local, content-gated, schema-stale) — never a silent pass. Exported from the package root.
- **`ExecutionOptions.expectedHash` / `expectedPromptHash`**, forwarded by `runAgent` into resolve. The YAML pin covers source + config (and fully covers WDL/PDL execution); the prompt pin is required for full agent/command executed-prompt integrity.
- **`ResolvedDefinition.promptHash` / `translatorVersion`** — surfaced from the registry so callers can pin the prompt and detect a retranslation restamp.

### Changed

- **Remote resolution now executes the FROZEN rendered artifact (`def.runtimeMd`), not a live re-render.** `resolveRemote` sets `runtime.prompt = def.runtimeMd` (the published, hashed, safety-scanned prompt that `prompt_hash` certifies) and drops the unconditional `render.get` round-trip. A live re-render is used **only** when `runtimeMd` is null (schema-stale / translation-failed rows), recording a `runtime:live-rerender-fallback` degradation; if that re-render also fails, resolve surfaces a clear error rather than an empty prompt. **Behavior change:** a definition whose factory improved since publish executes the same prompt until it is retranslated (correct content-addressing). A non-fatal belt-and-suspenders check flags `prompt-hash-inconsistent` when the registry's own `runtime_md`/`prompt_hash` disagree.
- **Remote agents now honor their declared `defaults`/`config`.** `resolveRemote` populates `runtime.defaults`/`config` from the verified YAML (mirroring local rendering), fixing a latent bug where remote agents ignored their `defaults.model`/temperature/maxTokens and fell back to CLI options / `DEFAULT_MODEL_ALIAS`. This also makes the YAML pin meaningfully cover the execution config.
- **`resolveLocal` hashes via the shared `computeHash`** (normalized) instead of a raw `crypto` SHA-256, so a local definition's `hash` matches the registry scheme and can be pinned.
- Bump `@uluops/sdk-core` to `0.12.0` (shared hash util).

## [0.19.0] - 2026-06-13

### Added

- **Per-model context-budget reconciliation.** The agent execution engine now sizes its context-budget guards against the resolved model's *real* context window (registry `limits.context`, surfaced via `@uluops/registry-sdk@0.32.0`) instead of a single static 200k. New `deriveContextBudget()` helper (`src/ai/contextBudget.ts`) applies the rule: an explicit operator `contextBudget` caps everything (`min(operator, window)`); otherwise the full model window is used; otherwise it falls back to `DEFAULT_CONTEXT_BUDGET` (200k) when the window is unknown. `ResolvedModel` now carries `contextWindow` (copied from `limits.context` at every resolution path; `0`/null treated as unknown). The derived budget drives both the 80% wrap-up guard and the 50% Anthropic eviction trigger, and is shared with the in-context `TokenBudgetTracker`.

  Fixes the failure where sub-200k models (many GPT/Gemini at ~128k) had their wrap-up guard sitting *above* the hard limit — the run died on a provider HTTP 400 context overflow instead of degrading gracefully (tracker SEM-INC/H, PRA-FRA/H from run `8dde22ed`).

- **Behavior change for large-window models.** Default-model runs on 1M-window models (e.g. `claude-opus-4-6`/`4-7`/`4-8`) now use up to the full 1M window (wrap-up at ~800k) unless an operator `contextBudget` is set. Set `contextBudget` to control cost/latency on large-window models.

### Changed

- `ResolvedConfig.contextBudget` is now optional (`number | undefined`). Undefined means "operator did not set one" — the engine then prefers the model window. The 200k default was moved out of `UluOpsClient` config resolution and into `deriveContextBudget` as the fallback, so an unset budget is distinguishable from an explicit `200000`.

### Internal

- Bumped `@uluops/registry-sdk` to `0.32.0` (exact) for the `Model.limits` field.
- New tests: `contextBudget.test.ts` (derivation rule table), `ModelCatalog` window-copy cases, AIProvider window-sized eviction, and AgentExecutor end-to-end budget threading. Suite → 666.

## [0.18.5] - 2026-06-05

### Added

- **`UluOpsClient.describe()` now accepts optional `version` and `type` parameters.** Forwards them to `RegistryClient.resolve()` so callers can disambiguate definitions whose names exist across multiple types (e.g., `socrates-explorer` registered as both `agent` and `command`). Previously the method took only `name`, leaving consumers — including `@uluops/cli`'s `ulu exec describe` — unable to act on the SDK's own "Specify type explicitly" error guidance. Backward compatible: both new params are optional and unused calls behave identically.

### Internal

- New test in `UluOpsClient.test.ts` verifies `describe(name, version, type)` forwards all three positional args to `registry.resolve`.

## [0.18.3] - 2026-06-02

### Added

- **`AgentExecutor` now supports report mode via `ExecutionOptions.reportMode`.** When set to `true`, the structured output schema is omitted from the AI SDK `generate()` call, freeing the model to produce free-form text (e.g., publication-quality reports). Without this, OpenAI's strict `json_schema` mode forces JSON-only output regardless of any prompt directive — see `agent-reporting-spec-v0_1_1.md` Phase 4 for the full rationale. Default is `false`; non-report-mode invocations are unaffected.

### Changed

- **`OutputExtractor.extractFromCodeFence` regex extended with discriminator-first chain.** Mirrors the `AnalysisSummaryExtractor` change from 0.18.2: prefers the disambiguated `\`\`\`json analysis` fence over the plain `\`\`\`json` fence, with legacy fallback. Necessary because v0.18.2's directive in `@uluops/cli`'s `--report` mode instructs agents to use the discriminator at the end of a prose report — and `OutputExtractor` is the primary parser populating `score`/`decision`/`categories`. Without this, report-mode runs produced `score: 0, decision: "UNKNOWN"` even when the discriminator was correctly emitted. Non-report-mode invocations continue to use the plain fence via fallback, fully backward compatible.

### Internal

- `ResolvedExecutionContext` now includes `reportMode: boolean` (resolved from `ExecutionOptions.reportMode ?? false` in `resolveContext`). Existing consumers that construct `ResolvedExecutionContext` literals must now provide this field; consumers that go through `resolveContext` are unaffected.

## [0.18.2] - 2026-06-02

### Changed

- **`AgentResult.rawOutput` truncation cap raised from 32 KiB to 512 KiB.** Constant introduced as `MAX_RAW_OUTPUT_BYTES` in `executor/AgentExecutor.ts`. Publication-quality reports (33–208 KB observed empirically when `@uluops/cli`'s `--report` flag is used) were previously clipped — frequently mid-JSON, which also broke `AnalysisSummaryExtractor.parseAnalysisBlock` regex matching. Lifting the cap strictly improves both the report-on-disk flow and the analysis-block extraction flow that feeds tracker submissions. 512 KiB bounds pathological output (e.g., runaway loops) while leaving comfortable headroom for normal reports.
- **`AnalysisSummaryExtractor.parseAnalysisBlock` regex extended to match `\`\`\`json analysis` discriminator with fallback to plain `\`\`\`json`.** Necessary for report-mode invocations from `@uluops/cli` 0.12.2+, where the agent's prose may contain illustrative `\`\`\`json` blocks before the canonical analysis fence. The discriminator gives the extractor an unambiguous anchor; legacy non-report-mode invocations continue to use the plain fence unchanged.

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

<!-- Version comparison links -->
[Unreleased]: https://github.com/Uluops/uluops-core/compare/v0.22.1...HEAD
[0.22.1]: https://github.com/Uluops/uluops-core/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/Uluops/uluops-core/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/Uluops/uluops-core/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/Uluops/uluops-core/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/Uluops/uluops-core/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/Uluops/uluops-core/compare/v0.18.5...v0.19.0
[0.18.5]: https://github.com/Uluops/uluops-core/compare/v0.18.3...v0.18.5
[0.18.3]: https://github.com/Uluops/uluops-core/compare/v0.18.2...v0.18.3
[0.18.2]: https://github.com/Uluops/uluops-core/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/Uluops/uluops-core/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/Uluops/uluops-core/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/Uluops/uluops-core/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/Uluops/uluops-core/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Uluops/uluops-core/compare/v0.15.2...v0.16.0
[0.15.2]: https://github.com/Uluops/uluops-core/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/Uluops/uluops-core/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/Uluops/uluops-core/compare/v0.13.0...v0.15.0
[0.13.0]: https://github.com/Uluops/uluops-core/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/Uluops/uluops-core/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/Uluops/uluops-core/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/Uluops/uluops-core/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/Uluops/uluops-core/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/Uluops/uluops-core/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Uluops/uluops-core/compare/v0.8.2...v0.10.0
[0.8.2]: https://github.com/Uluops/uluops-core/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Uluops/uluops-core/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Uluops/uluops-core/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Uluops/uluops-core/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Uluops/uluops-core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Uluops/uluops-core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Uluops/uluops-core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Uluops/uluops-core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Uluops/uluops-core/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Uluops/uluops-core/releases/tag/v0.1.0
