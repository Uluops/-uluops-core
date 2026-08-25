# Changelog

All notable changes to `@uluops/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). In addition to the standard `Added`/`Changed`/`Deprecated`/`Removed`/`Fixed`/`Security` sections, some entries use a few informational sections — `Internal` (test/CI/build-only changes), `Supply chain` / `Dependencies`, `Design Notes`, and `Migration` — which carry no consumer-facing API impact.

## [Unreleased]

## [0.42.0] - 2026-08-23

> **Cut as a MINOR, not a patch — deliberately.** `UsageMetrics.input_tokens` changed
> meaning without changing signature, so nothing downstream fails to compile. Under 0.x
> a caret range treats minor as the breaking boundary, so `@uluops/cli`'s `^0.41.0`
> will NOT absorb this on a plain `npm install` — it forces an explicit, reviewed pin
> bump instead. Shipping a value-semantics break as a patch would reproduce exactly the
> silent-drift failure mode this release exists to correct. (`uluops-registry-api` and
> `uluops-docs` carry exact pins and are unaffected either way.)

### Fixed

- **Token accounting reported only the LAST step of a multi-step tool loop.** `AIProvider`
  read `generateText`'s `result.usage`, which the AI SDK documents as *"the token usage of the
  last step"*; `result.totalUsage` is *"the total token usage of all steps"*. An agent loop runs
  up to `DEFAULT_MAX_STEPS` steps, so every multi-step run silently discarded all but the final
  step's tokens — and with them the cost. Now reads `totalUsage`, falling back to `usage` for
  callers and mocks that predate it.

  The tell was an impossible signature: a run reporting cache **reads** with zero cache
  **writes**. Measured live 2026-08-22 on `claude-haiku-4-5`; after the fix the same shape of
  run reports 4,654 cache-write and 37,232 cache-read tokens together, as one loop must.

- **`input_tokens` carried a cache-INCLUSIVE total, inflating effective tokens and cost.**
  AI SDK v6 reports `usage.inputTokens` as the provider's `inputTokens.total`, which includes
  cache reads and cache writes for every provider. Core read it as though it were uncached
  input — the v5 shape — so `calculateEffectiveTokens` added `cache_creation` a second time
  and `computeCostUsd` charged both cache pools at the full input rate *on top of* their own
  cache rates.

  `mapUsage` now normalizes `input_tokens` to be cache-exclusive, preferring the SDK's exact
  `inputTokenDetails.noCacheTokens` and falling back to subtracting a provider-reported cached
  figure when a provider sends no details. `noCache` is uniform across providers: Anthropic
  reports it as its own `input_tokens`; OpenAI and Google as `prompt − cached`.

  Measured live 2026-08-22 on `claude-haiku-4-5`: an isolated cache-read step of 12 genuine
  effective tokens was reported as 9,916. On a real 8-tool-call `security-analyst` run the
  same defect inflated the aggregate by 3.34x (17,876 → 59,762).

  This also repaired a latent OpenAI defect with the same root: `extractOpenAIUsage` compensates
  by reading `providerMetadata.openai.cachedPromptTokens`, and that field **does not exist in
  v6** (zero occurrences in `@ai-sdk/openai` 3.0.33), so OpenAI's compensation had silently
  stopped applying. Normalization no longer depends on it.

- **Structured-output runs that did not finish with `'stop'` failed the whole run.**
  `result.output` is a THROWING GETTER, not a property: the SDK resolves an output only
  when the last step finished `'stop'`, and the getter raises `NoOutputGeneratedError`
  otherwise. Core read it unconditionally, so any structured-output run ending in
  `'tool-calls'` (the step ceiling), `'length'` (max output tokens), `'content-filter'`,
  `'error'`, or `'other'` threw — and the fallback tested only
  `NoObjectGeneratedError.isInstance`, which is a **different class with a different
  symbol marker** and returns false. The run collapsed into an opaque `SdkApiError(0)`.

  Consequence: `MaxStepsExhaustedError` and the `steps.near-exhaustion` degradation
  marker were **unreachable on every non-report-mode run**, because those diagnose
  exactly the `'tool-calls'` finish this defect turned into a hard failure. Core now
  guards on the same condition the SDK uses, and catches `NoOutputGeneratedError` in the
  fallback as a belt-and-braces second line.

- **Retry exhaustion never mapped to its underlying cause.** `isRetryError` tested
  `error.name === 'RetryError'`, but the SDK prefixes every error name with `AI_` — the
  runtime value is `'AI_RetryError'` (verified live 2026-08-23). The branch never fired,
  and because `RetryError` carries no `statusCode` of its own it also missed the
  `APICallError` branch, so a run rate-limited into exhaustion surfaced as
  `SdkApiError(0)` and callers backing off on `RateLimitError` saw nothing. Now uses
  `RetryError.isInstance()` and **unwraps to the last underlying attempt**, so a 429
  exhaustion maps to `RateLimitError`, annotated with the attempt count and the SDK's
  `reason` (`maxRetriesExceeded` / `errorNotRetryable` / `abort`).

- **Timeouts never mapped to `TimeoutError`.** The mapper matched `error.name ===
  'AbortError'`, but `AbortSignal.timeout()` — which is what core installs — aborts with
  a `DOMException` named **`'TimeoutError'`** (verified live 2026-08-23). That branch was
  dead and every timeout became `SdkApiError(0)`. Now matches the same name set the
  SDK's own `isAbortError` guard uses (`TimeoutError` / `AbortError` / `ResponseAborted`).

- **`isAPICallError` was a structural check that both over- and under-matched.**
  `'statusCode' in error` matched core's own `SdkApiError`, registry/HTTP client errors,
  and any third-party error carrying that field — remapping them as provider failures,
  including handing an unrelated 404 the "your model catalog is stale" diagnosis. It also
  matched a real `APICallError` whose `statusCode` was `undefined`, producing "Provider
  returned HTTP 0". Now uses `APICallError.isInstance()`, which is symbol-branded and
  therefore correct across the **nine copies of `ai`** installed in this workspace, where
  `instanceof` would fail across module realms.

- **The render-fallback warning gave the wrong remedy for a rejected key.** 401 and 403
  were collapsed into one "Render API key lacks render access — Request render access for
  this key" message. That is correct for **403** (valid credential, insufficient
  permission) and wrong for **401**, where the credential was not accepted at all and no
  entitlement grant would help. The two now carry distinct diagnoses, matching the
  separation core's own `mapError` already draws. The 401 text names the most common real
  cause: a rotated key that a long-running shell never picked up, since a process keeps
  the environment it started with.

  Observed in practice — every live run during this work rendered from raw YAML and was
  marked `completeness: 'partial'` because the shell's `ULUOPS_API_KEY` predated a
  rotation, while the entitlement wording pointed at permissions instead of the key.

- **OpenAI reasoning tokens were never recorded.** `extractOpenAIUsage` read
  `providerMetadata.openai.reasoningTokens`, which does not exist in `@ai-sdk/openai`
  3.0.33 — reasoning moved to the unified `usage.outputTokenDetails.reasoningTokens`
  (`completion_tokens_details.reasoning_tokens` → `outputTokens.reasoning`). Its sibling
  `cachedPromptTokens` moved likewise. Verified live 2026-08-22 against `gpt-5-nano`:
  `providerMetadata.openai` carried only `{responseId, serviceTier}` while the provider
  reported 512 reasoning tokens on one call and 384 on the next.

  `mapUsage` now reads the unified `outputTokenDetails.reasoningTokens` and routes it by
  provider — `thinking_tokens` for Google, `reasoning_tokens` otherwise — since both
  providers funnel internal reasoning through the same field (Google's
  `thoughtsTokenCount` also lands in `outputTokens.reasoning`). The metadata extract tiers
  are retained as fallbacks for older provider builds and now use `??=` so they can never
  override the unified value. `mapUsage` takes an optional `provider` argument for this.

  Effective tokens and cost were NOT affected — reasoning is a subset of gross
  `output_tokens` and was always counted there. What was lost was the breakdown: on a real
  `code-validator` run against `gpt-5-nano`, 5,952 of 8,188 output tokens (73%) were
  reasoning and the field read empty. Google was unaffected throughout, because
  `providerMetadata.google.usageMetadata` still exists — so the two providers had silently
  diverged on the same metric.

- **The fixes above held at their citations and not at their CLASS — a second audit found
  four more instances, three reproduced by executable probe.** The recurring shape in this
  release is *a change that is correct on the primary path and silently wrong on a
  fallback, error, or degraded path.* It recurred inside the fix for its own fourth
  occurrence. What follows is the sweep, not four more citations:

  - **`sawUsage` tested the usage WRAPPER, not the numbers, so the "no fabricated $0"
    guard could not fire for the case it names.** `step.usage` is a REQUIRED field
    (`ai/dist/index.d.ts` `readonly usage: LanguageModelUsage`) which the SDK materializes
    through `createNullLanguageModelUsage()` — every member `undefined` — whenever a
    provider response carries no usage block. All three bundled providers do this. So
    `if (usage)` was a tautology meaning "a step finished", and the fallback's
    `sawUsage ? computeCostUsd(…) : undefined` returned a **real 0** for a multi-step run
    that reported nothing. That 0 passes `sumCostUsd`'s finiteness check and sums cleanly
    into a pipeline total. The one test covering it exercised only the ZERO-step case,
    where the flag stayed false for an unrelated reason — it passed vacuously. Presence is
    now read from `inputTokens`/`outputTokens`, and a genuinely reported `0` stays
    distinguishable from nothing reported.

  - **`stepTotalsToUsage` fabricated `noCacheTokens: 0`, which forced `mapUsage` down its
    EXACT normalization branch on the fallback.** The accumulator's `?? 0` destroyed the
    absent-vs-zero distinction that the branch immediately downstream depends on, so the
    whole input pool was priced at $0 for any provider reporting `inputTokens` without
    token details — the `ai.additionalProviders` population the LEGACY branch exists to
    serve. Measured against the success path on identical usage: **$0.045 against a true
    $0.495, a 91% understatement reported as a defined number.** `StepTotals` now records
    per-pool presence separately from value and emits `undefined` for anything unreported,
    mirroring the SDK's own null-usage shape.

  - **`buildFallbackResult` was a SECOND, REDUCED construction path.** It called `mapUsage`
    with one of the three arguments the success path passes, so on every degraded result:
    all four provider extract tiers were dead (Google thinking tokens landed in
    `reasoning_tokens`; an unknown provider whose cache pool arrives only in metadata went
    unpriced — the same defect again), and **both drift instruments this release added,
    `providerWarnings` and `usageShapeDrift`, were absent entirely** — dark precisely on
    the path where drift bites. Steps now carry `providerMetadata` and `warnings` forward,
    and the fallback builds through the same extraction as the success path. This is the
    structural fix: the other three were symptoms of there being two paths to keep correct.

  - **`MaxStepsExhaustedError` threw away a fully-billed run's usage.** The throw follows a
    SUCCESSFUL `generate()` whose tokens and cost are in hand, and the error carried only
    `steps` and `finishReason`. Three rejection handlers then synthesized
    `{inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, model: 'unknown'}` and
    continued with it. A step-ceiling run is **by construction the longest run the engine
    produces** — the maximum-cost class — so the fabricated zero erased the largest single
    cost core can incur, and `sumTokenMetrics` folded it into the run total. The error now
    carries optional `billedMetrics`, and the new `crashMetrics` helper reads them.

  - **Stage and phase cost roll-ups DROPPED crashed children instead of propagating
    unknown.** `sumCostUsd`'s contract reserves `undefined` for "a crash whose usage went
    unreported", and that polarity was implemented correctly at the agent level (crash
    placeholders omit `costUsd`) and broken one layer up. A thrown stage has no `result`,
    so `.filter(m => m != null)` silently dropped it; a blocked phase carries
    `commands: []`, so flat-mapping over commands dropped it too. Both collapsed
    *failed-after-billing* into the same shape as *skipped* — and the survivors' partial
    sum was presented as the run total. Failed stages and blocked phases now contribute an
    explicitly unpriced child; `skipped` still contributes nothing, because nothing ran.

- **Registry price operands reached the cost multiply unvalidated.** `ModelCost` declares
  `input`/`output` as required `number`s, but that is a compile-time claim over untrusted
  network JSON — `@uluops/registry-sdk` validates none of it at runtime. A row with a null
  or non-numeric rate made `usage.output_tokens * cost.output` NaN, and a NaN cost
  JSON-serializes to `null`, blanking an entire pipeline's recorded spend. This is the same
  failure the token-side finiteness guard prevents, **at the other operand of the same
  expression** — the guard was applied to the tokens and not to the rates. New
  `sanitizeModelCost` validates at the seam; unusable rates yield `undefined` (unpriced,
  honest-absent), never zero rates. Unusable *optional* cache rates are dropped
  individually, falling back to the full input rate as already documented.

- **`sumTokenMetrics` had no finiteness guard while its sibling `sumCostUsd` gained one in
  the same commit** — and the two share every call site. `inputTokens` and
  `totalEffectiveTokens` had no guard at all; the rest used `?? 0`, which reads like a
  numeric guarantee and is not one (it passes NaN and Infinity through). One NaN child
  turned the run's whole token total into NaN, which serializes to `null`.

- **A throw during result ASSEMBLY escaped `generate()` unmapped.** Narrowing the `try` to
  the provider call alone (this release, above) was correct — a throw there is not a
  generation failure and must not be reported as a zero-cost fallback. But leaving assembly
  bare traded one defect for another: `result.output` is a throwing getter and `mapUsage`
  runs there too, so callers received a raw `AI_NoOutputGeneratedError` instead of a core
  error type, and the billed usage was still lost — as a rejection this time rather than as
  a fabricated zero. Assembly now has its own `try` that maps the error and preserves the
  accumulated usage.

- **`detectUsageShapeDrift` now asserts PRESENCE of the keys an extract tier depends on**,
  rather than being satisfied by any overlap with a list that also contains benign envelope
  keys. Previously one surviving key — `responseId`, `usage` — suppressed the warning for
  every key that vanished beside it, which is exactly how the v6 OpenAI rename went
  unreported. A new `DEPENDED_ON_USAGE_KEYS` map names the load-bearing fields per provider;
  `openai` is deliberately empty (its block carries no usage fields in v6), and providers
  declaring nothing fall back to the overlap test. The warning now names which fields went
  missing. *(This was recorded as "not fixed" in the Design Notes below when the section was
  written; it is fixed. The note is kept for the reasoning that led there.)*

- **`budget.forced-wrap-up` no longer reports a brake that could not engage.** On an
  Anthropic structured-output run — core's default `structuredOutputMode: 'jsonTool'` —
  the provider hard-overrides `toolChoice`, so the wrap-up brake is inert; the latch marked
  it anyway, `collectExecutionMarkers` emitted a `severity: 'degraded'` marker, and
  `deriveCompleteness` returned `'partial'`. **Every Anthropic structured-output run
  crossing 80% context was stamped degraded for an event that never occurred, on the
  dominant provider path.** Repairing the brake itself means changing structured-output
  strategy and remains a separate decision (Design Notes below); what is withdrawn here is
  the false claim. The budget crossing is still logged at `warn`, and the message now names
  the reason the brake could not act. An explicit non-`jsonTool` `structuredOutputMode`
  restores both the brake and the marker. README documents the limitation in two places —
  the config reference and the degradation-marker contract — since `providerWarnings`
  cannot surface a core-internal override.

- **Third sweep of the same class — six more instances, two of them AF-006 criticals.** A
  third code-auditor pass found the class again, and the sharpest instance was inside the
  object the previous round had just edited:

  - **A thrown phase contributed a fabricated `0` to the workflow score.**
    `createBlockedPhase` returned `{ commands: [], score: 0 }`; the previous release fixed
    `commands: []` for the cost roll-up, wrote a positive-control test for it, and left
    `score: 0` **two lines below in the same object literal**. `aggregate()` filters
    `skipped` and `aborted` but not `blocked` — the crash case — so the fabricated zero
    entered the weighted average. Measured: a workflow whose one real phase scored 90
    reported **45** when a sibling phase threw a network timeout. The PipelineExecutor
    sibling guards this exact case and explains why in an eight-line comment. Now `null`,
    which `aggregateScores` already filters.

    An *authored*-empty phase still scores 0 deliberately — it must block at its gate
    rather than pass unexamined — and a test now pins that distinction, because the two
    cases look identical (`commands: []`) and have opposite correct answers.

  - **All four provider-metadata extract tiers assigned raw external numbers.**
    `mapUsage`'s own doc states the rule — *"Provider payloads are EXTERNAL data; `?? 0`
    reads like a numeric guarantee and is not one"* — and it was enforced, and tested, only
    on the SDK-standard path, while these tiers **are** the legacy/unknown-provider fallback
    route this release exists to correct. Measured: `cacheReadInputTokens: -5000` against
    10,000 reported input produced `input_tokens: 15000` (a 50% inflation) and **$0.0435
    against a true $0.030** — finite the whole way, so both `sumCostUsd`'s and
    `sumTokenMetrics`' finiteness guards passed it straight through. A NaN produced a NaN
    cost, blanking a whole run's spend.

- **The sequential branches of both executors lost every already-billed result on a crash.**
  `CommandExecutor.executeSequentially` and `WorkflowExecutor.executePhase`'s non-parallel
  arm had no per-item containment, while their parallel siblings had used
  `allSettled` + a crash placeholder since issue 77febff2. **Sequential is the default
  dispatch mode**, so the unhardened twin was the common path. Both now build the
  placeholder through one shared factory — two call sites that must agree are two chances
  to disagree — and fail-fast is preserved exactly: no item after the crash is dispatched,
  and the all-failed throw now governs both branches rather than living inside the parallel
  arm (that placement was itself part of how they drifted).

- **The token-budget tracker treated a null-usage step as a zero-size context window.** The
  `budgetTracker.update(usage.inputTokens ?? 0, …)` call sits **three lines above** the
  `StepTotals` accumulator that received the absent-is-not-zero fix, reading the same
  `usage` object. `update()` assigns `currentContextTokens` unconditionally, so one
  null-usage step reset the tracked window to 0 — `get_token_budget` then told the model
  `usedTotal: 0, remaining: <full budget>` mid-run, `isOverThreshold` read false, and an
  eviction spanning that step became undetectable. A step reporting no numbers carries no
  information about the window, so the tracker is now left alone.

- **`cachedInputTokens` and `reasoningOutputTokens` never reached the tracker.** Both are
  populated on `ExecutionMetrics` and declared on the wire (`ops-sdk` `TokenUsage`), and
  `extractTokens` dropped both. An OpenAI reasoning run's entire reasoning pool was
  invisible to anything reading a run back. This also falsified a justification recorded
  elsewhere in the codebase — that `costUsd` need not be sent because it "is derivable from
  tokens + pricing". It is not derivable from a token set with the cache-served pool
  removed.

- **`harness` was set, documented, producer-tested, and never written.** The engine stamps
  `harness: 'uluops-core'` on every `ExecutionMetrics`, `types/execution.ts` documents it as
  emitted, a test asserts it at the producer — and the submission mapping omitted it, so
  every run this package produced was indistinguishable on the wire from one produced by
  any other harness. The producer test passed identically whether the mapping line existed
  or not: the test-suite form of this same class.

- **`crashMetrics` used `instanceof` at the one seam where real money survives a crash.**
  `errors/index.ts` already warns against `instanceof` for any error crossing a package
  boundary, because two copies of this package in one tree mean two class identities and a
  silent false negative. New identity-free `hasBilledMetrics()` tests the stable `code`
  discriminant instead.

- **`budget.brake-inert`** — a new `info`-severity degradation marker. Withdrawing the false
  `budget.forced-wrap-up` (above) was right, but replacing a false claim with *silence*
  trades one reporting defect for another: `types/degradation.ts` rests the PASS+partial
  decision on invariant (1), *"every coverage reduction emits a marker; nothing degrades
  silently"*, and a caller whose configured cost ceiling provably did not apply needs to
  know. **`info`, not `degraded`, deliberately** — nothing was cut short, so the run really
  is `complete`; marking it `degraded` would re-introduce the exact false `partial` just
  removed. What failed is the caller's cost ceiling, not the agent's coverage.

- **`detectUsageShapeDrift`'s doc block claimed both "fixed" and "recorded as a decision to
  make" about the same live code.** Both halves were true of different providers and
  neither said so. It now states the boundary: presence-of-depended-on-keys is asserted for
  anthropic and google; **`openai` still uses the old overlap test**, because its
  depended-on set is legitimately empty in v6 — so *the exact drift that motivated this
  detector remains undetectable for the exact provider it happened to*. Closing that needs
  an instrument watching the unified usage shape, not a tuning of this one.

- One reported finding was **rejected after investigation, not adopted**: that
  `aggregatePhaseScore` returning `0` for a command-less phase is a fabricated zero. It is
  a deliberate, twice-tested contract — an authored-empty phase must block at its gate. The
  rationale is now recorded at the line so the next reader does not re-open it.

- **Fourth sweep — and the approach changed, because finding instances one at a time was
  not converging.** A fourth code-auditor pass found the class again, in the same method as
  the fix shipped the round before:

  - **A null-usage step silently released the wrap-up brake and reported a recovery that
    never happened.** `buildBudgetPrepareStep` read `lastStep.usage.inputTokens ?? 0` — the
    *third* reader of this same object to need the absent-is-not-zero correction, and 450+
    lines from the sibling reader that got it in the previous commit. Measured: after
    latching at 85,000/100,000, one null-usage step drove `contextSize` to 0, released the
    latch, **withdrew the `budget.forced-wrap-up` marker** (so `deriveCompleteness`
    reported `'complete'` for a run whose coverage really was cut), disengaged the brake so
    the caller's cost ceiling lapsed above 80%, and logged *"Context budget recovered
    (0/100000)"*. The sibling guard was also tightened: it gated on "either field present",
    but `inputTokens` **is** the window measurement, so a step reporting only output tokens
    would still have zeroed it.

  - **The PRIMARY reasoning source was unguarded while all four of its FALLBACKS had just
    been guarded.** `base.thinking_tokens = unifiedReasoning` took a raw external number,
    and the truthiness test `if (unifiedReasoning)` read a **measured zero** as "not
    reported", letting the `??=` legacy tier win. Measured: unified `reasoningTokens: 0`
    alongside `providerMetadata.openai.reasoningTokens: 777` reported **777** — a number
    nobody measured, on a run that explicitly reported none. That also falsified the
    documented invariant that `??=` "can never override the unified value". The wire path
    for this field was opened in the same release, so it now reaches the tracker.

  - **A blocked phase discarded the billed work the thrown error was carrying.**
    `executePhase` throws `WorkflowError(…, { partialResult })` holding crash placeholders
    with real `billedMetrics`; `createBlockedPhase` replaced them with `commands: []`,
    severing that channel one layer above every site that populates it. Measured: an
    all-crashed workflow reported `totalEffectiveTokens: 0` while the caught error held
    49,000. `buildPartialResult` likewise carried no `metrics` and no `score`, so a workflow
    that threw lost every completed phase's spend — the more work a run had finished, the
    more it lost.

  - **`CommandExecutor`'s all-crashed throw still lived only in the parallel arm**, so one
    underlying failure had two observable outcomes — and two different tracking outcomes —
    selected purely by dispatch mode. Hoisted to the dispatch site, as the workflow twin
    already was. *(The error message changed from `All parallel agents failed:` to
    `All agents failed:`, since it no longer describes only parallel dispatch.)*

  - **`runAgent()` never tracked a run that threw.** `trackIfEnabled` sat after the await.
    `MaxStepsExhaustedError` is by construction the maximum-cost run class, and this release
    taught it to carry `billedMetrics` and wired three aggregation sites to read them —
    while the outermost boundary, where a user calls `runAgent()` directly, had no consumer
    at all. The original error is always rethrown; a tracking failure never replaces it.

  - Smaller, same shape: a skipped phase reported `score: 0` (it never ran — now `null`,
    and externally visible on `result.phases[]`); `stepCrashPlaceholder` wrote
    `toolCallCount: 0` **over** the spread, overwriting a measured count on the run class
    that by construction made the most tool calls (now a default under it); and the
    assembly-failure log asserted *"reporting the usage that was already billed"*
    unconditionally, which is false on the non-structured-output path where the error is
    mapped and rethrown — a false state in a log line, on the path that `try` exists to
    protect.

- **`scripts/audit-fabricated-values.mjs` — the class is now enumerated mechanically rather
  than discovered one instance per review.**

  Four audit passes each found this class again, each one ring further out. The most
  expensive instance sat two lines below a line that had just been fixed; another was 450+
  lines away in the same method reading the same object. Review — human or agent — kept
  finding *instances* and never enumerated the *set*, which is what an instrument aimed at
  where you already believe the answer is can do.

  The script enumerates four mechanically-detectable shapes: `?? 0` on a measured value;
  a truthy test on a measured value (a reported `0` read as "not reported"); a numeric
  literal `0` for a measured field in a synthesized object; and an external value assigned
  without passing a clamp. Every site must be fixed or carry `// FABRICATION-OK: <reason>`;
  a waiver without a reason is rejected, because the reason is the point.

  **It ships with a `--control` mode that plants known-bad input and fails if any rule does
  not fire** — and that control earned its place immediately: on first run it reported that
  rule C never fired, because the probe put the field inline while the rule targets a field
  on its own line. A check that has never failed is indistinguishable from one that cannot.

  Wired as `npm run check:fabrication` (and `check:fabrication:control`). Current state:
  **0 unwaived sites**, 21 waived with written reasons — accumulator seeds, log formatting,
  array lengths where absence and zero genuinely coincide, event counts that carry no price,
  and the documented "nothing is known" branch in `crashMetrics`.

- **Fifth sweep — the class was in the wrong place, and the instrument was the thing that
  needed auditing.** The fourth-pass enumerator was pointed at the auditor, which found 13
  coverage blind spots hiding 8 real sites, one waiver bleeding onto a line its reason did
  not describe, two waivers asserting things false of the code, and — most importantly —
  **the class living somewhere the four rules structurally could not see.**

  The framing error was mine and it is the same one, one level up: clamp discipline was
  extended to *provider payloads* and stopped there. The class is **unclamped external
  input**. Model tool arguments and definition-authored config are external input too.

  - **A model-supplied `timeoutMs: 0` disabled the operator's shell timeout entirely and
    reported a clean exit.** `Math.min(x ?? d, d)` is a ceiling with no floor, and Node's
    `child_process` treats a timeout of `0` as NO TIMEOUT. Measured against the built code
    with a control: at a 2,000 ms operator ceiling, a model omitting the field had its
    5-second command killed at 2,004 ms; a model sending `0` ran the full 5,011 ms to
    completion and reported `{type:'exit', exitCode:0}`. That falsifies this file's own
    load-bearing comment — *"the model can only LOWER the timeout … never raise it"* — at
    the smallest legal value, and the bash tool it guards grants full host OS access, so
    this was the operator's only liveness control over it. Negative and NaN reached
    `execFile` and threw `ERR_OUT_OF_RANGE`, reported to the model as `exitCode: 1` — a
    configuration fault presented as a failed command. Both bounds are now clamped on both
    sides via `clampModelBound`.

  - **Unvalidated authored score weights fabricated a score, and one of them FAIL-OPENED a
    gate.** `weights[item.key] ?? 1` read definition YAML/JSON raw. Measured with true
    scores of 90 and 95 (93 unweighted): a `NaN` weight reported **0**, failing every gate;
    an `Infinity` weight produced **NaN**, and because `NaN < threshold` is `false` **the
    gate PASSES** a run with no valid score, which then JSON-serializes to `null`. YAML makes
    `.nan` and `.inf` directly authorable. Unusable weights now degrade to the neutral
    weight `1` — the same weight an unlisted key already gets — so one malformed entry costs
    the weighting rather than the aggregate.

  - **`contextBudget` was unvalidated**: `0` latched the wrap-up brake on step 1 so the
    agent could never call a tool (while reporting a forced-wrap-up marker and `partial`
    completeness — a real degradation with a false stated cause), and `NaN` made every
    threshold comparison false, leaving the brake **silently inert with no
    `markBrakeInert()` call**. That is precisely the gap `budget.brake-inert` was added to
    close, reopened one layer up.

  - The OpenAI shell adapter **truncated output silently** while its Anthropic twin has
    appended a `[truncated — N chars total]` marker since it was written, so a model could
    not distinguish "no output" from "output discarded". `crashMetrics` and both blocked-phase
    recovery sites reported `durationMs: 0` for children that consumed real wall-clock. And
    the latent truthy test on an upstream score is now an explicit null check.

- **The enumerator was hardened against every blind spot the audit found, and its control
  now carries the adversarial variants permanently.**

  `MEASURED` gained prefix wildcards and the non-provider external inputs (`weight`,
  `timeoutMs`, `maxOutputLength`, `budget`). Rule C matches inline objects and last
  properties, not just line-start-with-trailing-comma. Rule B models the whole truthy
  family — negation, `&&` guards, ternaries, `> 0` presence tests — not just `if (x)` and
  `x || undefined`. Rule D covers optional chaining, bracket access, object properties and
  `return`, and no longer skips bare declarations (the exemption through which the
  unified-reasoning defect escaped). The whole-line `CLAMPS` exemption is gone — a clamp
  must guard *that value*, not merely appear on the same line. **The waiver window is scoped
  to the contiguous comment block directly above a line**, so it can never cover a sibling
  it does not describe.

  The control now plants 12 adversarial variants and fails if **any single one** goes
  uncaught, rather than only checking that each rule fired somewhere. It earned that
  immediately, twice: it caught rule D not firing because rule B was false-positiving on a
  TypeScript optional property (`x?: number` parsed as a ternary) and masking it, and it
  caught a multi-line object's opening line being miscounted as known-bad.

  Current state: **0 unwaived sites, 29 waived with written reasons.**

- **Sixth sweep — the class was never "provider payloads". It is EXTERNAL INPUT, and the
  guard is now organised by provenance.**

  Audit pass 6 (77/100, AF-006) diagnosed the framing error precisely, and it applied to the
  guard as much as to the code: the static check written after pass 5 enumerated by FIELD
  NAME and had been extended with exactly the four names pass 5 cited (`timeoutMs`,
  `maxOutputLength`, `weight`, `budget`). `max_results`, `start_line`, `max_depth`,
  `context_lines`, `step.timeout` and `step.retries` were never in view — not judged safe,
  never met. **A name list is an OPEN set and cannot terminate; provenance is a CLOSED set.**

  Before rebuilding on that claim, an independent agent was asked to FALSIFY the provenance
  enumeration rather than review the fix. It found the claim wrong in five ways — three
  missing channels, one mislocated, three miscounted — which is why the rewrite rests on a
  verified surface instead of an asserted one.

  New criticals, all measured:

  - **`max_results: Infinity` is Zod-valid and removed the 50-match search bound entirely** —
    the loops break on `results.length >= maxResults` — sending unbounded tool output into
    the context window, billed as input tokens on every later step of a BYOK run. `0` and
    `-5` broke on entry and told the model **"no matches" for a search never performed**.
  - **`list_files` reported "... and 8 more files" in a directory of seven** (`max_results:
    -1`), "and 5.5 more files" (`1.5`), and with `NaN` suppressed even the overflow marker —
    reporting an **empty directory**.
  - **`retries: .nan` meant the command NEVER RAN.** `maxAttempts` became NaN, `attempt <=
    NaN` was false, the loop body never executed — and `return lastResult!` pushed
    `undefined` through a non-null assertion into `stepResults[]`, where PipelineExecutor
    read `.status` off it. `step.timeout` was likewise unclamped while its two siblings on
    the next two lines were not.
  - **An externally SIGKILLed process was reported to the model as a timeout.** Node
    distinguishes them (`{killed:true,signal:'SIGTERM'}` vs `{killed:false,signal:'SIGKILL'}`)
    and the `|| err.signal` disjunct swept both up, so the model received "Command timed out
    after Nms" — a duration nobody measured, for an event that did not occur, which it would
    rationally answer by asking for a longer timeout. maxBuffer overflow returns a STRING
    error code, so `typeof err.code === 'number'` was false and it fabricated `exitCode: 1`
    for a command whose real status was never observed.
  - **`z.number()` ACCEPTS `Infinity`.** Verified against the pinned zod 3.25.76 with a
    control proving the probe is not vacuous (`NaN` IS rejected). `outputSchemas.ts` had 8
    `z.number()` uses and ZERO constraints — on the STRUCTURED-OUTPUT path, which
    `OutputExtractor` treats as extraction confidence 1.0 *because the SDK validated it*. So
    an unconstrained schema conferred a trust it did not verify, and `Infinity < threshold`
    is `false`, so it fail-opened a gate. `.finite()` is now on every numeric field.
    **Range is deliberately still NOT enforced there** — `AgentExecutor` clamps to [0,100]
    *and warns*, a division a test pins explicitly, and a schema reject would replace a
    visible warning with a silent degrade.
  - **`parseFloat('Infinity')` and `Number('Infinity')` return `Infinity`** and survive the
    usual `!isNaN(...)` guard, so the same fail-open arrived through model PROSE on the
    text-extraction rung. Sixteen coercions in `parser/` and `analysis/` now route through
    `parseExternalNumber`.
  - **A library consumer is external.** `new TokenBudgetTracker(NaN)` made
    `isOverThreshold()` permanently false and `markBrakeInert()` unreachable — a budget that
    silently does not exist. Two waivers had justified this with "deriveContextBudget rejects
    such budgets upstream", true of one in-package call path and false of the type. Note the
    constructor accepts `0`: that is a tested contract meaning "no budget", and collapsing it
    into the malformed cases would be over-generalizing the class until it swallows an
    intentional value — the mirror image of this release's own defect.
  - **`config.maxConcurrency` bypassed the validator its env twin had** — the env path went
    through `parseMaxConcurrency`, the programmatic path went through nothing.
  - Cancellation: un-run stages are now RECORDED as skipped (they used to vanish, so
    "cancelled at stage 2 of 6" was indistinguishable from "a 2-stage pipeline"), and a stage
    throwing *after* `cancel()` no longer overwrites `cancelled` with `failed` — a
    user-initiated stop was being reported as a pipeline failure.

- **`src/utils/externalValue.ts` — ONE seam, replacing three.**

  `clampModelBound`, `usableWeight` and `usableBudget` were written on three separate passes
  for three separate citations. That trio WAS the citation pattern in miniature: three
  implementations of one idea, none aware of the others. They now derive from
  `finitePositive`; adding a fourth would have been the seventh repetition.

- **`scripts/audit-external-inputs.mjs` replaces the name-based guard, and can DISCOVER.**

  Two halves. The **inventory** lists entry points in a numeric context and requires each to
  be routed or waived — that half can only confirm. The **census** records per-channel entry
  point COUNTS in a committed baseline and fails when one moves, so a new `JSON.parse`, a new
  service client or a new tool argument announces itself. *The surface moving is how every
  one of the six audit passes actually began*, and that is now a gate rather than a discovery.

  The predecessor is kept, marked superseded, because its header records why a name list
  cannot work — reasoning that cost six passes to learn.

  Two self-corrections worth recording: the census initially reported "surface unchanged"
  **with no baseline to compare against** — a check claiming success when it had not run,
  which is the exact defect class, in the instrument. It now reports `DRIFT NOT CHECKED`.
  And the inventory was first written to demand a waiver on all 84 entry points, including
  service CALLS that fabricate nothing; a gate that reports 84 things, 70 needing no action,
  is one people learn to scroll past. Census counts everything; inventory demands action only
  where a number is produced.

  Current state: **75 entry points across 7 channels, 11 in numeric contexts, none unguarded.**

- **Seventh sweep — the instrument was broken by demonstration, not by argument.** Audit
  pass 7 (64/100, AF-006) planted a new, fully unguarded model-tool-args entry point while
  folding an existing one behind a helper, and the gate reported *"surface unchanged; none
  unguarded", exit 0.* Reproduced here before acting. Two structural causes:

  - **The census compared per-channel scalar COUNTS**, so a removal and an addition in one
    channel net to zero. It detected net cardinality, not new entry points — and a refactor,
    which is precisely when new entry points appear, is exactly when sites move.
  - **`--control` returned before the census code was ever reached.** The only half claiming
    to find unknown-unknowns had NO positive control — this repo's own "a check that cannot
    fail proves nothing" doctrine violated inside the tool written to enforce it.

  Both fixed: the baseline now stores **per-site fingerprints** (file + channel + normalized
  text, deliberately excluding line numbers so a comment insertion is not surface change),
  and the control plants a net-zero refactor and fails if it does not register as +1/-1.

  **Two more channels were missing, and one was named in this package's own seam module.**
  `externalValue.ts`'s provenance header lists *"public API arguments"* as channel 6; the
  instrument had seven channels and that was not among them — the seam and the guard,
  written in one sitting, disagreed about what the surface is. Both of this pass's new
  criticals live in the channel that was dropped. The other miss was **AI-SDK provider
  responses**, which arrive SDK-typed with no parse call: `src/ai/AIProvider.ts` — 1,757
  lines, the ORIGIN of this entire defect class — contributed **1 of 75** census entries.

  Adding them took the measured surface from **75 to 132 entry points**; `AIProvider` went
  from 1 to 33.

  Also fixed: channel attribution was order-dependent (`break` after the first match meant
  `Number(process.env['X'])` counted as `string-to-number` and silently decremented
  `process-env`, so a cosmetic rewrite could fabricate or mask drift), and the control probe
  is now removed in a `finally` so a throw cannot leave a file in `src/` that breaks `tsc`.

- **`Semaphore(NaN)` deadlocked the engine permanently, and the constructor comment named
  that exact failure.** *"a zero/negative limit would deadlock"* — it guarded 0 and negative
  and not the third value. `Math.max(1, Math.floor(NaN))` is NaN, `acquire()`'s `NaN > 0` is
  false, so every caller queues forever. Measured: `availablePermits: NaN`, `run()` never
  settles. **Not a rejection — a hang**, with no error, no timeout and no diagnostic.
  Reachable from outside, since `AIProvider` and `ResolvedConfig` are both exported.

- **`read_file` reported a line range that never existed — and the reproduction was cited as
  FIXED in the comment above it.** `externalLineNumber` rejects NaN, negatives and fractions,
  but two valid positive integers can still name a range the file does not have. Measured on
  a 5-line file, both with `is_error: undefined`: `start=100,end=200` returned
  `"[Lines 100-5 of 5]"` over an empty body, and `start=3,end=2` returned `"[Lines 3-2 of 5]"`.
  The value was validated; the RELATIONSHIP between two values was not.

- **`TokenBudgetTracker.update()` was the constructor's defect one method over.** A public
  method on a root-exported class taking raw numbers. `update(NaN, 10)` made
  usedTotal/remaining/percentUsed all NaN — serializing to `null` — and `isOverThreshold`
  permanently false, so the brake was unreachable and `markBrakeInert()` never fired: the
  constructor's own documented failure mode, verbatim, on the adjacent entry point. And not
  merely telemetry — `ToolAdapter` returns `getStatus()` to the MODEL as `get_token_budget`.

- **Two waiver reasons corrected.** Both `TokenBudgetTracker` guards justified themselves
  with *"deriveContextBudget rejects such budgets upstream"* — false of a class whose
  constructor deliberately PRESERVES `budget: 0` as a tested contract. The guards were right;
  their stated reason cited a rejection this class goes out of its way not to perform. The
  real consequence the old reason obscured is now recorded: with budget 0 the brake never
  engages and `markBrakeInert()` is never called.

### Design Notes

- **UNRESOLVED, flagged rather than decided: two score aggregators disagree.**
  `aggregateScores` returns `0` when items ran but none produce scores; `aggregatePhaseScore`
  returns `null` for the same input. Under `evaluateGate` that is not cosmetic — **0 BLOCKS
  and null PASSES** — so an all-generator panel fails its gate in a pipeline or command and
  passes it in a workflow.

  Evidence pulls both ways, which is why it is recorded at both sites rather than corrected:
  `PhaseResult.score` and `CommandResult.score` are both `number | null` documented *"null
  for scoreless (generator/executor) commands"*, and the score-nullability spec says do not
  coerce to 0 — but a test pins `returns 0 when all items have null scores`, and changing it
  alters gate semantics for every pipeline and command rather than a single value. That is a
  behavioural decision about what a scoreless panel means at a gate, not a mechanical repair.

### Changed

- **`UsageMetrics.input_tokens` is now CACHE-EXCLUSIVE** — a semantics change with no signature
  change, so nothing downstream fails to compile. Consumers computing their own totals must
  **stop** subtracting a cached figure from it; doing so now undercounts. `total_effective` is
  `input + output + cache_creation`, unchanged in meaning and now correct in value.

- **The bash tool told the model a failed command had succeeded.** `executeShellAsString`
  (the Anthropic bash-tool adapter) returned `stdout || stderr || '(no output)'` for every
  command that ran, byte-identical for exit 0 and exit 1 — it returns a bare string and had
  nowhere to put the exit status, so it dropped it. `npm test` failing came back as the test
  report with no indication the suite had failed, and a silent failing command
  (`grep -q pattern file`, exit 1) came back as a literal `(no output)`, which reads as
  success. A non-zero exit now returns `Command failed with exit code N` ahead of the output,
  so truncation cannot remove it. Success output is unchanged and carries no banner. The
  OpenAI adapter was never affected — its structured `outcome` has carried the exit code
  since it was written.

- **A command that never STARTED was reported as a command that ran and failed.** A spawn
  failure — `cwd` missing (`ENOENT`), unreadable (`EACCES`), not a directory (`ENOTDIR`), fds
  exhausted (`EMFILE`) — arrives with a STRING `code`, fell through to the residual branch,
  and was classified `termination: 'exited'` with a fabricated `exitCode: 1`. The model was
  then told its command had failed and would go on to debug the command rather than the
  environment that could not run it. New `termination: 'spawn-failure'`, discriminated by
  PROVENANCE rather than by an errno list: a numeric `code` is the child's exit status, a
  string `code` is Node's own error identifier and means the child never ran. That
  distinction is closed and countable; the set of possible errno strings is not, and grows
  with libuv. `ShellResult.termination` gains a member — widening a union that consumers
  read, not one they construct.

- **A scoreless panel now reports NO score instead of a fabricated `0`, and therefore PASSES
  its gate instead of failing it.** `aggregateScores` returns `number | null`; it returns
  `null` when nothing scorable was supplied — an empty item list, or one where every item
  scored `null` (a panel of generators/executors, which do not score by design). It
  previously returned `0`.

  This is a **gate-semantics change**, not just a value change. Both consuming gates —
  `WorkflowExecutor.evaluateGate` and `PipelineExecutor.gateFailed` — are fail-open on a
  null score and gate on any number, so a stage or phase whose agents all came back
  scoreless used to fail at `0 < threshold` and now passes. That is what both gates already
  documented in prose ("scoreless stages are fail-open for the threshold check"); the
  fabricated `0` was defeating the contract those comments describe. The case that changes
  in practice is an **inline-agents stage of generators under a `gate.threshold`** — command
  stages already fail-opened, because `CommandExecutor` guards the call.

  What did NOT change: `WorkflowExecutor.aggregatePhaseScore` still scores an
  **authored-empty phase** (`commands: []`) `0`, and `aggregate` still scores an
  **authored-empty workflow** (`phases: []`) `0`, so a definition that asks for nothing
  cannot pass a gate unexamined. Those two layers hold the definition and can tell
  "nothing was asked for" from "nothing scored"; the shared util cannot — callers shape the
  array before it arrives — so it declines to guess. The util and
  `aggregatePhaseScore` now agree on every case except that one, which had been flagged
  UNRESOLVED in comments at both sites since 2026-08-24.

  Consumers reading `score` off a `WorkflowResult`, `PipelineResult` or `CommandResult` see
  no signature change — all four result types already declared `number | null` — but a value
  that was `0` may now be `null`, and stored run data can now distinguish "every agent
  scored zero" from "no agent scored". Anything computing arithmetic on the field without a
  null check was already unsound and will now surface it.

- **`cached_input_tokens` no longer participates in effective-token arithmetic.** AI SDK v6
  dissolved the provider-shape difference that motivated the §3.2 disentangle: Anthropic cache
  reads and OpenAI/Google cached input now both arrive as `inputTokenDetails.cacheReadTokens`.

  **It is still PRICED, however.** On the legacy-metadata path — a provider reporting no
  `inputTokenDetails`, reachable via `ai.additionalProviders` — this field carries the
  cache-served pool, and cost prices whichever of it and `cache_read_input_tokens` is present.
  An intermediate revision of this release dropped it from cost entirely, which made those
  tokens free (normalization removes them from `input_tokens`, so nothing else charged them);
  that undercount was caught by the ship gate and corrected before publish. Recorded here
  because a reader diffing 0.42.0 against itself would otherwise find the two states
  contradictory.

### Added

- **`AIGenerateResult.providerWarnings`** — the AI SDK reports settings it could not
  honor (`temperature is not supported when thinking is enabled`, clamped `max_tokens`,
  unknown context-management strategy, cache-breakpoint limits) on `result.warnings`.
  Core discarded that array entirely. It now surfaces on the result and logs at `warn`.

  This matters more than it looks: provider option schemas parse with a plain Zod object
  in **strip** mode — no `.strict()`, no `.passthrough()` — so an unknown or renamed
  option key is silently dropped before the request is built. It does not error and it
  does not warn. A provider warning is therefore the ONLY runtime evidence that a setting
  did not take effect, which makes this the missing instrument for the entire class of
  defect this release is about.

- **`ExecutionMetricsLike`** — exported from the package root to name the shape of
  `MaxStepsExhaustedError.billedMetrics`, so a consumer reading that field can type it. It
  is an **alias** of `ExecutionMetrics`, not a second declaration.

  > It shipped in review as a hand-written structural copy, justified by keeping the errors
  > module dependency-free at the bottom of the import graph. **That justification was
  > false** — `types/execution.ts` imports nothing from `errors/`, and `errors/index.ts`
  > already type-only-imports four sibling result types. There was no cycle to avoid. The
  > copy had *already* drifted before it shipped, omitting `harness?: string`, which is the
  > entire argument against hand-maintained duplicates: the copy quietly stops describing
  > the thing it copies and nothing fails. Caught by a reviewer who tested the stated
  > justification instead of accepting it — recorded because the failure was the
  > *reasoning*, not the code.

- **README accuracy pass on the export surface.** `MaxStepsExhaustedError.billedMetrics`
  now appears in the error table and the error-handling example; `ExecutionMetricsLike` in
  the Advanced Exports block; `provider.warnings` in the degradation-marker vocabulary; and
  `DEFAULT_TEMPERATURE` in the Exported Constants block — the last of these shipped in
  0.41.0 and was simply never listed, so it is a docs fix rather than a new export.
  *(A review pass initially reported `DEFAULT_TEMPERATURE`, `isApiErrorLike` and
  `ApiErrorLike` as new root exports in this release; checked against `main`, all three were
  already exported in 0.41.0. Only `ExecutionMetricsLike` is new.)*

### Design Notes

> **Amended before release.** Finding 1's *reporting* half and the
> `detectUsageShapeDrift` weakness below were both fixed in the same version — see Fixed
> above. What remains genuinely undecided is finding 1's *behaviour* half (the brake
> itself) and finding 2. The original text is kept because the reasoning that classified
> these as decisions rather than repairs is the useful part.

- **Two provider-behaviour findings recorded, NOT fixed — both need a decision.**

  1. **`structuredOutputMode: 'jsonTool'` voids the context-budget wrap-up on Anthropic.**
     Selecting `jsonTool` makes the Anthropic provider append a JSON response tool and
     hard-override the caller's `toolChoice` with `{type:'required'}` — the value from
     `prepareStep` is never referenced on that branch. So `buildBudgetPrepareStep`'s
     `toolChoice: 'none'`, core's only mid-run cost brake, is a **no-op for every
     Anthropic structured-output run** — the dominant path. Worse, `TokenBudgetTracker`
     still latches `forcedWrapUp`, so the run **reports a forced wrap-up that never
     happened**. OpenAI and Google are unaffected (they implement structured output via
     a response format, not a tool), so the brake works on two providers and silently
     does not on the third. Fixing it means changing the structured-output strategy on
     Anthropic, which is a behaviour and cost decision, not a mechanical repair.

  2. **Context eviction is inferred from a token delta while the provider states it
     exactly.** `TokenBudgetTracker.update` flags eviction from a >5% step-over-step drop
     in input tokens — the comment correctly notes that was the only uniform signal in
     v5. In v6, Anthropic reports
     `providerMetadata.anthropic.contextManagement.appliedEdits[].clearedInputTokens`,
     the measured value. The heuristic is both false-positive-prone (any window shrink)
     and false-negative-prone (evictions under the threshold), and the `evictedTokens`
     figure in the `context.evicted` marker is an estimate standing in for a number the
     provider hands over.

- **`detectUsageShapeDrift` is satisfied by ANY overlap, and that is why this drift went
  unreported.** The check is `keys.some(k => recognized.includes(k))`, so one surviving key
  suppresses the warning for every key that vanished beside it. `responseId` was on the
  recognized list and survived; `cachedPromptTokens` and `reasoningTokens` — the only two
  fields the extract tier consumed — did not. The instrument reported "shape is fine" about
  a metadata block that no longer contained anything it read.

  `RECOGNIZED_USAGE_KEYS.openai` has been corrected to the fields v6 actually emits, so it
  no longer implies this detector is watching fields that are gone. The any-overlap
  weakness itself is **recorded, not fixed**: a correct detector would assert that the keys
  a tier depends on are present, which changes the warning contract and what counts as
  noise. Lower stakes now that `mapUsage` reads the unified usage shape and treats metadata
  as fallback, but the weakness is structural rather than incidental.

### Internal

- **139 tests added for the class sweep, each carrying a POSITIVE CONTROL.** The previous
  round's failure was not that its tests were absent — it was that they passed vacuously
  (the `sawUsage` test covered only the zero-step case, where the flag stayed false for an
  unrelated reason). Every new test here was run against the reverted code and confirmed to
  FAIL first: reverting `sawUsage` to the wrapper test, fabricating `noCacheTokens: 0`,
  restoring the reduced fallback path, casting `CallWarning` instead of narrowing, dropping
  two of the three abort names, reverting each of the two cost roll-ups, and latching the
  wrap-up unconditionally. The control assertions are recorded in each test's comment.

  > **Ten targeted mutations, not an exhaustive sweep — and the distinction is the whole
  > lesson.** The first eight were chosen by the same author who wrote the fixes, so they
  > tested what that author already believed was load-bearing; an instrument aimed at where
  > you believe the answer is can only confirm. A reviewing agent then probed two sites this
  > list had not thought to try — **the `billedMetrics` argument at the exhaustion throw
  > site, and the assembly `try`/`catch` around `buildGenerateResult`** — and **both mutants
  > survived the full 1,164-test suite**. Each sits at a site this very entry names as a
  > headline fix: the underlying helpers (`crashMetrics`, `MaxStepsExhaustedError`) were
  > unit-tested in isolation while the WIRING between them was not, which is the same
  > citation-versus-class shape the release exists to close, one level up in the test suite
  > rather than in the source. Both gaps are now covered end-to-end and both mutants die.
  > The count is recorded as *targeted*, deliberately: a mutation set is evidence about the
  > mutations you ran, never about the ones you did not think of.
  >
  > **That held again, twice more.** A later review found `sanitizeModelCost` unwired at all
  > three of its call sites passing the *entire* suite — a helper with eight unit tests and
  > no coverage able to tell wired from unwired. Rather than fix the one site and wait for
  > the next report, every call site this release introduced was then swept mechanically,
  > which surfaced **three more survivors** (all three `crashMetrics` consumers). And on the
  > round after that, one newly-written test still survived its own mutation because it
  > asserted `isFinite` and `>= 0` where the unguarded value was 11,000 — finite and
  > positive, so the assertion could only ever confirm. Fixed by asserting the exact number.
  >
  > The shape has a name now, and it is the same one as the source-level defect, one level
  > up: **a helper proven correct and not proven CONNECTED is not proven** — and an
  > assertion that cannot distinguish the two answers is not a test.

- **Coverage closed on two branches flagged as untested.** The `CallWarning`
  `'unsupported'`/`'compatibility'` discriminants — which carry `feature`/`details` and no
  `message`, so a cast renders them `"undefined"` — and the `'AbortError'` /
  `'ResponseAborted'` members of the abort-name set, of which only `'TimeoutError'` was
  exercised (removing the other two would have passed the suite untouched).

- **The `'ai'` test mock is now PARTIAL.** It was a total mock, so the SDK's error
  classes did not exist in the test environment at all. That forced every error-mapping
  test to fabricate lookalikes (`Object.assign(new Error(), {statusCode})`,
  `error.name = 'RetryError'`) — which matched only because core's guards were equally
  structural. The mock and the guards agreed with each other and both disagreed with the
  SDK, so two mapping branches were dead while their tests stayed green. Real
  `APICallError` / `RetryError` / `DOMException('…','TimeoutError')` instances are now
  used, and the guard fixes above were confirmed by watching each restored branch fail
  before it passed.

- The `scripts/live-costusd-e2e.mjs` "hand computation" was a term-for-term
  transcription of `computeCostUsd`, so it could only ever prove the engine agreed with
  a copy of itself. It reported "matches exactly" on 2026-07-26 while both sides carried
  the cache-inclusive input total. Updated to the corrected formula, with the tautology
  documented in the file — an independent oracle would price the provider's own
  `usage.raw`, which core does not surface yet.

- Added the first unit tests for `mapUsage`. Every prior token test hand-constructed a
  `UsageMetrics` and so bypassed this function entirely, which is the structural reason the
  v5→v6 change in `inputTokens` semantics went undetected by a green suite. The new fixtures
  are verbatim v6 usage objects captured from live calls, including a control asserting that
  `input_tokens` is never the cache-inclusive total.

## [0.41.0] - 2026-08-21

> **0.38.0, 0.39.0 and 0.40.0 have no entries because they were never released.** All three
> were intermediate publishes to the local Verdaccio registry during validation of this same
> body of work — each install iteration needed a fresh version to resolve cleanly — and none
> reached npmjs. npm's latest was 0.37.1; everything below ships as 0.41.0, the first public
> release since. Recorded rather than silently renumbered, because a gap in the version
> sequence otherwise reads as a lost release.

### Added

- **`ResolvedModel.registered`** (`boolean`, **required**) — whether the model was found in the
  registry catalog. `false` means no catalog row existed and `tier`/`capabilities` are fabricated
  defaults; the model may still be valid at the provider (private or preview access), which is why
  such models are still allowed through.

  The field exists to make a provider 404 explainable. Two unrelated causes previously arrived
  identically at the error mapper, because `ModelCatalog.resolveExplicit` fabricates a
  `ResolvedModel` for unregistered models and discarded the fact that it had done so:

  | catalog row | provider says 404 | correct diagnosis |
  |---|---|---|
  | present | yes | the local catalog is **stale** — model retired upstream, not yet re-synced |
  | absent | yes | likely a **wrong name** or an account without access; there was never a row to be stale |

  All five construction sites now state their answer explicitly. The offline baked-in alias
  fallback reports `false` deliberately: the registry was unreachable, so registration is genuinely
  *unknown*, and claiming `true` would let a stale-catalog message be shown on the strength of a
  lookup that never happened.

  > **Judgment call, flagged rather than buried: this field is REQUIRED, and `ResolvedModel` is
  > publicly exported (`src/index.ts`).** Consumers that merely *read* a `ResolvedModel` are
  > unaffected; any consumer that *constructs* one will fail to compile until it adds the field.
  > Required was chosen over optional on purpose — a defaulted `false` would silently mislabel
  > registered models as typos, which is the exact failure being fixed. Under 0.x this rides a
  > minor bump; note that every consumer pinning `^0.x` is minor-locked and will not receive it
  > without an explicit re-pin.


- **`RunSubmissionResponse.repairedRecommendations`** (optional `number`) — the count of
  recommendations `sanitizeRecommendation` had to repair (coerce an invalid required field,
  omit an invalid optional field, or truncate an oversize one) before sending. Previously the
  cost of a repair was recorded only as one `logger.warn` per recommendation and then went out
  of scope entirely — no counter, no metric, no run-level aggregation. That gap is part of how
  242 invented failure codes reached the datastore undetected across many releases (see the
  `isCanonicalMode` fix below, this same release). Populated on both the tracking-enabled and
  tracking-disabled (`trackingEnabled: false`) response paths. Additive optional field on a
  public type — minor bump, not breaking.
- **`DEFAULT_TEMPERATURE`** exported from the package root (value `0`, unchanged) — pure
  extraction of a value that was previously a bare `0` literal at three call sites
  (`AgentExecutor.resolveContext`, `AIProvider`'s debug log and generation options). No
  behavior change. Whether generator/explorer agent types should get a nonzero temperature
  floor instead of inheriting the validator-tuned default is an open policy question, not
  addressed here.

  > This entry originally read "exported from `constants.ts`", which was true of the module and
  > false of the package: the symbol was missing from `src/index.ts` (unlike its six siblings)
  > and there is no `./constants` subpath in the `exports` map, so no consumer could reach it.
  > Caught pre-publish by verifying against a real installed tarball rather than reading the
  > source. Now genuinely reachable from `@uluops/core`.

- **`isApiErrorLike` / `ApiErrorLike` exported from the package root.** Previously reachable
  only via the `./errors` subpath, which is not where a consumer looks — and the proof of that
  is in this repo's own ecosystem: `@uluops/cli` hand-reimplemented an identical interface and
  guard, with matching rationale comments, because it could not import this one from the main
  entry point. A guard that exists to stop people writing a broken `instanceof` check has to be
  reachable from where they are actually importing.

### Changed

- **`ModelNotFoundError` now names the valid options instead of only pointing at a method.**
  The message previously read *"Not found as alias, tier, or provider:modelId. Use
  catalog.listAliases() to see available aliases."* — correct, but it made the reader run an
  extra async call to diagnose what is usually a typo. It now inlines the valid tiers (a static
  const, so free) and the available aliases.

  The alias list requires a registry round-trip and is therefore **best-effort**: if that call
  fails, the original `ModelNotFoundError` is preserved and the message falls back to the
  discovery-method hint. Masking "your model name is wrong" with "the registry is down" would
  send the reader after a different problem entirely — guarded by a test that mutation-fails if
  the enrichment error is allowed to propagate. Consumers matching on the exact message string
  should note the prefix `Cannot resolve model "<input>"` is unchanged.

- **Structured output: provider enforcement semantics changed on BOTH providers.** This is a
  behavior change, not only a fix, and it produces no compiler error and no failing test on the
  consumer side — which is why it is recorded here rather than left to the source comments that
  already explain it.

  - **OpenAI now runs with `strictJsonSchema: false`** (`AIProvider.buildOpenAIOptions`, applied
    only when the caller has not specified it). A consumer who was relying on OpenAI strict mode
    to *reject* a response that does not match the schema no longer gets that rejection — malformed
    shapes now arrive for the parser to handle instead of erroring at the provider. This weakening
    is the price of the Anthropic fix below and is deliberate; if you depended on strict-mode
    rejection as a validation boundary, that boundary has moved into your own code.
  - **Anthropic now uses `structuredOutputMode: 'jsonTool'`.** The SDK's default path emits the
    deprecated `output_format`, which Anthropic rejects with HTTP 400 before the model ever runs —
    structured output was entirely broken on Anthropic, not degraded.
  - **23 fields in `agentOutputSchema` moved from `.nullable()` to a null-tolerant `.optional()`.**
    The wire contract is unchanged for producers: an explicit `null` is still accepted and is
    normalized to `undefined` (via `z.preprocess`, because a bare `.optional()` *rejects* explicit
    `null` and would have turned working runs into `ExecutionError`). What changed is the emitted
    JSON Schema — 29 union-typed params dropped to 6, under Anthropic's limit of 16, which is what
    made the 400 fixable at all. Six score-shaped fields stay `.nullable()`, guarded by a
    compile-time equality assertion: `null` means "scoreless" there and `undefined` would be
    ambiguous.

  Guarded by `test/parser/schemaUnionBudget.test.ts`, which converts the schema through
  `@ai-sdk/provider-utils`' `zodSchema()` — the exact JSON Schema the SDK sends — and asserts the
  union count stays under 16. It counted 29 before the fix, matching Anthropic's error digit for
  digit, so it is a guard that has been watched fail.


- **`AIProvider.mapError` now has a 404 branch.** Previously 404 fell through to the generic
  `SdkApiError(status, 'Provider returned HTTP 404: …')`, which named neither cause above and gave
  the operator nothing to act on. The branch now reports which case applies, and explicitly tells
  the reader *not* to go hunting for a typo when the model came from the catalog. When no
  `ResolvedModel` is available the message says provenance is unknown rather than guessing.

  Verified by three tests including a control asserting the two messages **differ** — an assertion
  no collapsed-branch implementation can satisfy. Confirmed by mutation: forcing both branches to
  one message turns 2 tests red.



- **`WorkflowError.context.partialResult` and `PipelineError.context.partialResult` are now
  typed instead of `unknown`.** `WorkflowError.context.partialResult` is
  `Partial<WorkflowResult> | CommandResult[] | undefined` — heterogeneous across its five
  construction sites in `WorkflowExecutor.ts`: the outer catch passes a `Partial<WorkflowResult>`
  (it omits required fields like `version`/`decision`/`score`, hence `Partial`, not the full
  type); the all-steps-failed-in-a-phase path passes the completed `CommandResult[]` directly;
  three sites pass `undefined`, so the field is now optional to match. `PipelineError.context
  .partialResult` is `PipelineResult | undefined`. `ExecutionError.partialResult` deliberately
  stays `unknown` — no producer in this package populates it (all six construction sites pass a
  message only, and `MaxStepsExhaustedError` explicitly passes `undefined`); it is not unioned
  with the new `PartialExecutionResult` type so callers don't get a false sense that it's
  populated. A new exported `PartialExecutionResult` type
  (`AgentResult | CommandResult | WorkflowResult | PipelineResult`) backs the two populated
  fields. README and `examples/error-handling.ts` updated to match — the `ExecutionError`
  guidance to "check `error.partialResult`" is removed as inaccurate, and the `WorkflowError`
  guidance now states the real `Partial<WorkflowResult> | CommandResult[] | undefined` shape.
  Consumers doing property access on `WorkflowError.context.partialResult` after an
  `Array.isArray()`-unsafe narrowing will now see a type error and need to guard both arms —
  intentional, since that access was already unsafe at runtime before this release, just
  unflagged by the compiler.
- **`RegistryClient` now re-normalizes server-provided `normalized` output** through the local
  normalization port (`registry/normalize.ts`) before use, instead of trusting it verbatim. The
  port has been a deliberate superset of the `@uluops/definition-factory` module the registry
  API calls since at least 2026-07-07 (it carries the PDL single-entry `workflows[]` → `ref`
  hoist, which the factory does not yet have) — server-normalized output that needed that rule
  silently kept its un-hoisted shape, which then threw at `executeRefStage` and dropped that
  stage and every stage depending on it, while the run still reported completed. Every rule in
  the port is guarded on the target field's absence, so re-running it over already-normalized
  output is a verified no-op for every rule the two implementations share — this is a top-up,
  not a fallback (no `degradations` entry is pushed). **Behavior delta:** `normalizeLocally`
  also runs `validateWorkflowStructure`/`validatePipelineStructure` and converts
  `DefinitionValidationError` → `ConfigurationError`, so a malformed *server* response that
  previously flowed through and crashed downstream now throws cleanly (as `ConfigurationError`)
  at resolve time instead.
- **Engine-synthesized results now carry a self-identifying placeholder version.** Aggregated
  pipeline stages, steps-only pipeline stages, and crashed parallel workflow steps have no
  backing definition, but previously emitted `version: '1.0.0'` (indistinguishable from a real
  1.0.0 release) or `version: ''` (a literal empty string on the wire). They now emit
  `version: '1.0.0-synthesized'` — deliberately non-parseable as a real release — and
  `SubmissionClient` filters that sentinel (alongside the existing `'unknown'` sentinel) before
  the `agents[]` payload reaches the tracker, so `definitionVersion` is omitted rather than sent
  as fabricated or empty identity.

- **`npm run typecheck` now covers `test/` as well as `src/`, and CI runs it.** Test files had never
  been typechecked in this package's history: `tsconfig.json` excludes `test`, `typecheck` was a bare
  `tsc --noEmit` that inherited that exclusion, `vitest` declares no `typecheck` block, and nothing in
  CI or `prepublishOnly` invoked `typecheck` at all. A new `tsconfig.test.json` covers `src/**/*` +
  `test/**/*`; `typecheck` now targets it, and it runs in CI (between Lint and Test) and in
  `prepublishOnly`. Turning it on surfaced **135 pre-existing type errors**, all now fixed — including
  tests importing types that no longer exist (`ValidatorAgentResult`, `ExecutorAgentResult`), fixtures
  missing fields their types had since made required, a fixture asserting a model status
  (`'active'`) that was never in the vocabulary, and the `priority` defect above. **Consumers are
  unaffected** — no shipped code changed. Contributors will now see these errors at `npm run
  typecheck` and in CI rather than never. (tracker `608388fa`)

### Fixed

- **`examples/error-handling.ts` failed to demonstrate its own first branch.** The
  `UluOpsClient` constructor resolves config eagerly and throws `ConfigurationError` when no API
  key is present — the most likely outcome of running the file cold, and the first case the
  example's `catch` chain teaches. Construction sat *above* the `try`, so that path produced an
  unhandled stack trace instead of the handler being demonstrated. Moved inside.
- **`examples/run-agent.ts` printed the entire rendered agent prompt on any failure.** The file
  had no top-level `catch`, so Node's default uncaught-exception printer dumped the whole error
  object — including `requestBodyValues.system` — burying a one-line "check your API key" under
  kilobytes of YAML. Now catches and prints `error.message`.


- **`startPipeline` ran async pipelines with no timeout and ignored `ai.modelOverride`.**
  `UluOpsClient.startPipeline` called `PipelineExecutor.start(resolved, input)` with no
  third argument, while its two siblings — `runPipeline` and the `pipeline` branch of
  `run()` — both pass `{ timeoutMs: config.timeout, model: config.ai.modelOverride }`.
  `PipelineExecutor.start` already declared and threaded an `options` parameter; nothing
  downstream needed to change. **Behavior delta:** an async pipeline started via
  `startPipeline` now honors `config.timeout` (previously unbounded) and
  `config.ai.modelOverride` (previously ignored on inline-agent stages). A caller relying on
  `startPipeline` running unbounded regardless of configured timeout will now see it time
  out. `executeRefStage` and `WorkflowExecutor.execute` were deliberately left untouched —
  neither currently accepts an options parameter, and widening either is a design decision
  the timeout-precedence spec has not yet made.
- **Shell-tool timeout inherited the overall agent run budget instead of using its own
  default.** `AIProvider.createProviderShellTool` declares a `timeoutMs = 30_000` default,
  but its only caller (`AgentExecutor.setupTools`) always passed `context.timeoutMs` — the
  agent's *run* budget, not a shell-call budget — making the declared default dead code. A
  30-minute agent run authorized a single 30-minute `bash` call; a 5-minute run capped
  *every* shell call at 5 minutes. Extracted the default to
  `constants.ts#SHELL_COMMAND_TIMEOUT_MS` (30s, unchanged value) and added
  `ExecutionOptions.shellTimeoutMs` so callers can override the shell-call budget
  independently of the run timeout.
- **`sanitizeRecordType`'s blank-fallback case was indistinguishable from a genuinely
  declared `evidence_finding`.** Analysis records land on `evidence_finding` from four
  distinct paths (Tier 4 recommendation-derived, Tier 3 exploration-map-derived, a real
  declared value, and the blank/missing-type fallback), and nothing named which. Tier 3/4
  were already recoverable from their `data` key signature (`sectionType`/`sectionLabel` vs.
  `priority`/`failureMode`/`taxonomyVersion`) — the remaining ambiguous pair is now
  disambiguated too: the fallback branch writes `data.recordTypeSource: 'fallback-blank'`
  when there was nothing to preserve (a genuinely blank or missing type), leaving a real
  `evidence_finding` declaration untouched. See SCOPE.md's new "Inherent Tensions" row —
  pre-2026-08-20 rows predate the marker and remain permanently unattributable between the
  two; that is an accepted, irreversible consequence, not an open defect.
- **`AnalysisSummaryExtractor` silently dropped data at four more sites with no signal.**
  Continuing the `warnings` channel introduced earlier in this release (exploration-map
  section-cap truncation): Tier-2 `analysisRecords` entries missing
  `recordType`/`recordId`/`title` (pre-sanitizer filter), exploration-map sections with an
  off-vocabulary `type`, `domainMetrics` entries missing `key`/`value`, and
  exploration-map-derived records past the 100-record cap now each push one aggregate
  warning per site per run (never per item) instead of disappearing with no trace. No
  change to what gets persisted — Tier-2's filter still drops the same records; only the
  drop is now observable via `extract().warnings` / `logger.warn`.
- **Submission payload total-data-loss on large runs.** `@uluops/ops-sdk`'s
  `SaveRunInputSchema` enforces `.max(100)` client-side, before any HTTP call, on
  `analysisRecords`, `agents`, and each exploration map's `sections`. Core accumulated all
  three with no ceiling of its own — a pipeline with many stages/agents, or an explorer
  producing a large map, could exceed 100 and throw a `ZodError` that lost the **entire run's**
  analysis and agent data, not just the excess. Each is now capped at 100 with a
  `logger.warn` naming the total produced and the number dropped (truncate-and-warn, per this
  file's existing `sanitizeRecommendation` policy: never let a ceiling become a
  submission-aborting throw).
- **preflight command metacharacter guard rejected its own quoting function's output.**
  `shellQuote()` emits `'…'\''…'` for a target path containing an apostrophe; the metachar
  guard stripped single-quoted spans with `/'[^']*'/g` and then tripped on the leftover bare
  `\` from that escape sequence — rejecting every command preflight check for a legitimately-
  named target directory. The guard now validates the command **template**, before
  `$ARGUMENTS` substitution, rather than the substituted string it previously saw exclusively;
  only `command` is shell-interpreted among the substituted fields, and it always routes
  target-derived text through `shellQuote()`, so template-only guarding is both correct and
  sufficient. Fail-closed the whole time, so no security exposure — this is a false-rejection
  fix, not a hardening.
- **`OutputNormalizer` let a literal `null` in LLM JSON reach fields typed `string |
  undefined`.** `??` only sanitizes non-terminal operands — `a ?? b ?? c` falls through to `c`
  unchanged when `c` is `null`. Four fallback chains ended on an unchecked terminal operand
  (`Issue.filePath`, `Issue.failureCode`, the `locations[]`-array `filePath` variant,
  `ArtifactResult.contentType`), so e.g. `{"file": null}` in an agent's JSON output produced
  `filePath: null` instead of `undefined`. Guarded with a new `asStr()` terminal-operand check.
- **README Prerequisites overstated the supported Node.js floor.** Said "Node.js 18+"; the
  engines field (and CI matrix) has required `>=20.3.0` since 2026-08-11. The README ships to
  the npm package page regardless of the `files` allowlist, so a Node 18 user following it would
  install and immediately hit `EBADENGINE`. Now reads "Node.js 20.3+", matching `package.json`.
  Documentation only — the supported range itself is unchanged.
- **`maxConcurrency` was documented as a process-wide ceiling; it has always been
  per-instance.** `AIProvider`'s doc comment, `Semaphore`'s doc comment, `ResolvedConfig`'s
  field comment, and two README sites all said "global"/"across the whole engine". There is
  exactly one `AIProvider` construction site (`UluOpsClient`'s constructor), and the semaphore
  is a plain instance field — nothing in this package coordinates across instances. A host
  constructing multiple `UluOpsClient`s (e.g. one per tenant or per request) in one process
  admits N × `maxConcurrency`, not `maxConcurrency`, and can overrun its provider's rate limit
  as a result. Docs corrected to state the guarantee is per-`AIProvider`/per-`UluOpsClient`
  instance; the underlying behavior is unchanged, so this narrows a documented guarantee a
  consumer may have relied on — flagged here because the type signature carries no evidence of
  the correction.
- **The bash tool's shell provider could diverge from the model actually generating.**
  `AgentExecutor.setupTools` resolved the shell tool's model with
  `options?.model ?? runtime.defaults?.model ?? config.ai.modelOverride ?? DEFAULT_MODEL_ALIAS`
  (override checked last), while the generation path (`resolveContext`'s
  `budgetModelInput`, mirrored in `AIProvider.generate`) resolves with
  `config.ai.modelOverride ?? context.model` (override checked first, unconditional). An
  operator setting `modelOverride` to an OpenAI model on a bash-enabled agent declaring
  `defaults.model: sonnet` got an Anthropic-shaped shell tool wired to an OpenAI-generating
  run. `setupTools` now takes the already-resolved `context` and uses the same
  `config.ai.modelOverride ?? context.model` idiom, so the precedence exists in one form
  instead of two that can desynchronize.
- **A model-supplied shell timeout/output cap could raise the operator-configured ceiling
  instead of only lowering it.** `executeShellAsOpenAIResult` (OpenAI shell tool adapter)
  used `action.timeoutMs ?? defaultTimeoutMs` and `action.maxOutputLength` (uncapped when
  absent) — both fallbacks, not ceilings, so a model-supplied `timeoutMs` above the operator
  default was honored verbatim. This is the exact hazard `SHELL_COMMAND_TIMEOUT_MS` (this
  same release, above) was introduced to close, but the constant only reached the *caller*
  (`AgentExecutor`); the enforcement site in `shellExecutor.ts` still let the model raise its
  own limit. Both now clamp with `Math.min(modelValue ?? default, default)`; the OpenAI
  output cap now also matches the Anthropic branch's `MAX_SHELL_OUTPUT` (100KB) hard cap
  instead of having none. A below-ceiling model-supplied value is still honored — this is a
  ceiling, not a new floor.
- **`StepsExecutor`'s `expect_match` had no guard against catastrophic-backtracking
  patterns.** Only a compile-failure catch existed; a pattern that compiles fine but
  backtracks catastrophically (e.g. `(a+)+$` against pathological input) could hang the step
  indefinitely. Added the same length cap (200 chars) and nested-quantifier/alternation
  heuristics `ToolHandler.search_content` already uses against LLM-supplied patterns,
  extracted to a shared `src/utils/regexSafety.ts` so the two call sites can't drift apart.
  Severity is bounded: `StepsExecutor` is unreachable unless the operator opts in via
  `allowStageSteps: true` (default `false`), and that opt-in already grants the definition
  arbitrary shell execution — this closes a consistency gap, not a first-order vulnerability.
- **A stage `depends_on` a forward-declared or nonexistent stage id skipped every run with no
  diagnostic.** `PipelineExecutor.checkStageDependencies` only checked whether a dep id was
  already `status: 'completed'` in `stageResults` — it never distinguished "not yet completed"
  from "can never complete." Two cases were unsatisfiable forever: a `depends_on` pointing at a
  stage declared *later* in the array (stages run in authored array order; a later stage cannot
  have completed yet), and a `depends_on` naming an id that does not exist anywhere in the
  pipeline (typo, or a stage removed during editing). Both landed in the same silent
  `createSkippedStage(..., 'dependencies_not_met')` path as a legitimate failed/skipped-upstream
  cascade, with no `logger.warn` call anywhere on the route — the pipeline reported `status:
  'complete'`, `decision: 'PASS'` while an authored stage silently vanished into `skipReason`.
  `checkStageDependencies` now takes the full stage list and emits a distinct `logger.warn`
  identifying which case fired (forward dependency vs. unknown dependency) before the skip is
  recorded; the legitimate failed/skipped-cascade case remains silent, unchanged. This is
  diagnostics only — the skip behavior itself is unchanged, and no topological reordering was
  introduced (deliberately: reordering stages would change which stages have completed when
  `condition:` expressions evaluate, a PDL-version decision, not a bug fix).
- **`RegistryClient`'s render-fallback warning couldn't distinguish "key not entitled to
  render" from "render API unavailable," and repeated once per definition.** `tryRenderViaAPI`
  logged the same "Render API unavailable (non-fatal — using raw YAML fallback)" message for
  every failure, including `SdkApiError` 401/403 — an entitlement problem, not a transport
  fault — and `formatErrorMessage()` discards `statusCode`, so the two were indistinguishable
  from the log alone. The message also didn't state the consequence (the agent's prompt is raw
  YAML instead of rendered instructions, and the result is marked `completeness: 'partial'`).
  Read `statusCode` directly at this call site (without widening the shared
  `formatErrorMessage` helper, which has other callers) to branch on 401/403 vs. everything
  else, reworded both branches to name the cause/consequence/remedy, and deduplicated to one
  `warn` per client instance per branch — a pipeline resolving many local definitions with an
  under-entitled key previously repeated the identical warning once per agent.
  `examples/run-agent.ts` updated to match the new wording. Degradation markers
  (`render:api-unavailable`, `completeness: 'partial'`) are unchanged — this narrows the log
  message and its volume, not the structured signal downstream code reads.
- **`ExecutionInput.params`'s doc comment said condition-expression evaluation over `params`
  "is Phase 3 of pdl-steps-execution-spec"** — future tense, describing an unshipped capability.
  Phase 3 (condition evaluation) shipped in this same release (`conditions.ts#PARAMS_PATH_RE`,
  wired at `PipelineExecutor.ts`'s stage/agent `condition:` evaluation) — the comment had not
  been updated since, so IDE hover text told consumers to hand-roll param-based gating the
  engine already does. Reworded to state the shipped behavior and the D5 absent-param-is-false
  semantics, with a pointer to `conditions.ts` for the full three-valued rule.


- **`Recommendation.priority` omitted `'high'`, a value the wire accepts.** `priority` was typed
  `'critical' | 'suggested' | 'backlog'` at `types/command.ts` and `types/execution.ts`, while the
  ops-sdk wire vocabulary is `PRIORITIES = ['critical', 'high', 'suggested', 'backlog']`.
  `Recommendation` is exported from the package root, so a TypeScript consumer setting
  `priority: 'high'` — legitimate, accepted by the tracker, and passed through untouched by
  `sanitizeRecommendation` at runtime — got a spurious compile error and had to cast. Widened both
  declarations to include `'high'`. **No runtime behaviour changes**; this only stops the type
  rejecting a value the system already supported. The adjacent `severity` field was already correct
  (it matches `SEVERITIES` exactly), which is what identified this as an omission rather than a
  deliberate narrowing. Found by typechecking the test suite for the first time — see below.
## [0.37.1] - 2026-08-19

### Dependencies — `@uluops/registry-sdk` 0.47.1 → 0.49.0 (registry-api ADR-013 activation prerequisite)

Core is the transitive carrier of the SDK into `uluops-registry-api`'s tree and a registry
reader in its own right. With this bump, definition reads tolerate the drop-aware
deep-analysis fields: `deep.errorReason` validates as shape rather than a closed enum (the
old pin **threw** on any reason it didn't know — `unrepresentable_findings` shipped
server-side 2026-08-18), and `deep.droppedFindings` survives parsing instead of being
strip-mode deleted. No API change in core itself. Latent until the registry's deep worker
activates; consumers should be on ≥0.37.1 before it does.

### Fixed — the "off-taxonomy" warning tested shape, not taxonomy

`SubmissionClient` warned when `failureMode` did not match `/^[A-Z]{3}$/` and called the
result *"off-taxonomy"*. That regex accepts `ZZZ`, `QQQ` and every other three-letter string —
so the warning stayed **silent for exactly the values it named**, and that shape is the
mechanism by which 242 invented codes reached the datastore.

It now checks membership via `isCanonicalMode` from `@uluops/taxonomy`. Measured:

| value | old (shape) | new (membership) |
|---|---|---|
| `STR-ZZZ` | silent | **warns** |
| `SEM-VAL` | silent | **warns** |
| `STR-OMI`, `EPI-SCP` | silent | silent |

Membership is only defined on the fully-qualified code — `INC` is both `STR-INC` and
`SEM-INC` — so the bare mode is qualified using `failureDomain` from the same payload. With no
domain there is nothing to decide against and the shape check remains the most that can be
said.

**Nothing is rejected, which is why this could tighten here and cannot elsewhere.** The check
only appends to `repairs` and sends the value unchanged. Systems spec §7.3 defers membership
enforcement because *enforcing* it rejects data; that concern does not apply to a diagnostic.

### Fixed

- **One malformed recommendation field can no longer destroy an entire run submission.**
  `RecommendationInputSchema` validates *client-side* inside `ops-sdk`, before any HTTP
  call, so a single bad value used to throw a `ZodError` that aborted the whole
  `runs.save` payload — every agent's recommendations and all analysis records for that
  run. One agent's typo could delete nine other agents' output.

  Four fields of one taxonomy code had four different policies on four consecutive lines:
  `failureCode` stripped silently, `failureDomain` and `severity` thrown, `failureMode`
  unvalidated. All recommendation fields now go through one repair pass with a single
  policy: **repair or omit only what the wire would reject** (so nothing can abort the
  save), **never drop a value the wire would have accepted** (imperfect data beats none),
  and **warn on every repair**, naming the field and the offending value.

  Concretely: a malformed `failureDomain` or `severity` is omitted instead of thrown; a
  malformed `failureCode` is still omitted but now says so; an off-taxonomy `failureMode`
  is *kept* (the wire accepts any string ≤50) with a warning that it will not join against
  the taxonomy downstream; an invalid `priority` — required on the wire, so it cannot be
  omitted — is coerced to `suggested`, the neutral middle of the vocabulary, rather than
  losing the run; over-length `title`, `description`, `category`, `filePath` and `agent`
  are truncated to their wire maxima.

  **`SubmissionClient`'s constructor now takes a `Logger` as a second argument.** It is
  constructed internally by `UluOpsClient`, so this is not a breaking change for normal
  use; it is one for anyone instantiating `SubmissionClient` directly.

  The local `failureCode` regex was replaced by the SDK's own exported schemas
  (`FailureCodeSchema`, `FailureDomainSchema`, `SeveritySchema`, `PrioritySchema`), so the
  client can no longer drift from the contract it is validating against.

- **`AnalysisSummaryExtractor.extract()` documented a `@throws` contract it has never
  honoured.** The JSDoc on this publicly-exported method (`src/index.ts:23`) declared
  `@throws {Error} if the analysis block JSON is malformed (propagated from JSON.parse)`.
  It does not throw — `parseAnalysisBlock` catches and returns `null`, and there is no
  `throw` statement anywhere in the module. The doc contradicted the module's own stated
  purpose: `safeStringify`'s comment notes that this "runs on the save path of every agent
  run — a throw here would fail the whole save, which is the exact failure class this
  module exists to prevent."

  **Consumer impact is the inverse of what it looks like.** Nobody's code breaks, but
  anyone who wrote a `try`/`catch` around `extract()` on the strength of that line has
  been defending against an impossible failure, and anyone who assumed malformed analysis
  JSON would surface loudly has been getting silence. The doc now states the real
  behaviour and names the degradation path: a null block falls through to `result.rawJson`
  via each consumer's own fallback (`systemMetrics` → `extractDomainMetrics`, records →
  the Tier 2/3 cascade, `epistemicAssessment`/`auditImplications` take `rawJson` as a
  second source, `explorationMaps` reads `rawJson` only), so a malformed fence costs no
  data on the structured-output path and is already surfaced as an `extraction.failed`
  degradation marker on the text path.

  No behaviour changed. This is a correction to a false contract, not a fix to the code
  it described.

- **Pipeline stage averages no longer discard a legitimately-evaluated score of 0.** The
  inline-agent crash filter in `PipelineExecutor` was `r.decision !== 'FAIL' || (r.score ?? 0) > 0`
  and is now `r.score != null`.

  **This changes numbers, with no signature change and no compiler error, so read it here or
  not at all.** A stage containing an agent that legitimately evaluated its target as a total
  failure — `{decision: 'FAIL', score: 0}` — previously excluded that agent from the stage
  average as though it had never run. A stage of `[PASS@90, FAIL@0]` scored **90**; it now
  scores **45**. Stage scores can therefore *drop* on this release without any agent behaving
  differently, and a `threshold` gate that passed on such a stage may now fail. That is the
  correct reading: a real worst-case score is data, not an absence.

  The filter's stated intent — keep one crash from poisoning a stage average — is preserved
  and now rests on the property that actually distinguishes a crash. `executeInlineAgents`
  stamps a rejected agent `score: null` ("Null pair, not fabricated 0/100"), so nullity is the
  crash signature; the decision string is not. The old comment asserted that literal `'FAIL'`
  *was* the crash signature, and that premise was false two ways: `FAIL` is core validator
  vocabulary (`sdk-core` `classifyDecision`: PASS/WARN/FAIL), and `AgentExecutor` stamps
  `parsed.decision ?? 'FAIL'`, so any agent that merely omits a decision is labelled FAIL
  without crashing.

  This is the second and last site of the crash-as-zero class; the first
  (`AgentExecutor`'s `parsed.score ?? 0`) was fixed in 0.23.0's nullable-score work. The
  filter now matches `CommandExecutor`'s `scoredResults`, so all three aggregation sites
  finally agree, and it is belt-and-braces rather than the sole defence — `aggregateScores`
  applies the same null guard internally.

  Custom-vocabulary negatives are unaffected: `[PASS@90, EXPOSED@50]` scored 70 before and
  scores 70 now.

### Internal

- **The interpreter-eval preflight test now tests the interpreter guard.** It previously fed
  bare `node -e`, `python3 -c`, `bash -c` and `bun --eval`, all of which are rejected by the
  *allowlist* check that runs first — so every payload died at the wrong branch, and the
  assertion `.rejects.toThrow(PreflightError)` could not tell the two apart because every
  guard in the module throws that same class. The guard could have been deleted outright with
  the suite still green. Payloads now wrap the interpreter in an allowlisted base command
  (`command bash -c …`, `which node -e …`) so they reach the guard, and the assertion matches
  the message `'disallowed interpreter eval'`, matching how the allowlist and metacharacter
  tests are already pinned. Verified by neutralising the guard and confirming all four
  assertions fail. No production behaviour changed — the guard was working; it was untested.

- **Rejection-branch coverage added for the four preflight guards that had none** —
  `$ARGUMENTS` shell-quoting (CWE-78), logical path traversal, symlink escape, and unknown
  check type. `preflight.ts` implements eight guards while its header documents four, which
  is much of why these went untested. 22 tests → 62.

  Each new test was verified by mutation: the guard it covers was disabled in turn and the
  matching test confirmed to fail. That caught one of the new tests being vacuous — a target
  directory named `star*` passes `test -d $ARGUMENTS` even unquoted, because the glob
  expands to the directory itself, so the case held whether or not `shellQuote` ran. It now
  creates a second matching entry so the unquoted expansion yields two words and the
  assertion can actually fail.

  The `$ARGUMENTS` tests key on `>` rather than on `;` or `|`. Redirection is the
  discriminating character: it is absent from the metacharacter blocklist
  (``/[;|&`\n\r\\]|\$\(/``), so the metacharacter guard cannot backstop it and only
  `shellQuote` prevents the injection. The assertions check the filesystem for a stray file
  rather than merely the absence of a throw, since a successful redirection is the injection.

  Both traversal guards also gained a passing control — a legitimate nested path, and a
  symlink pointing *inside* the target — so neither test could be satisfied by a guard that
  simply rejected everything.

  One behaviour is pinned as fail-closed rather than correct: a target path containing an
  apostrophe is refused by the metacharacter guard, because `shellQuote` emits `'it'\''s'`
  and the guard's quoted-span stripping leaves a bare backslash. Safe, but it contradicts
  the claim at `preflight.ts:184-185` that shellQuote's backslashes are stripped before the
  check. Filed; the test asserts the current rejection so a future fix has to flip it
  deliberately.

## [0.37.0] - 2026-08-11

### Changed

- **BREAKING — `engines.node` raised from `>=18.0.0` to `>=20.3.0`.** Node 18 was never
  actually supported; the declaration was false and had been for some time. Every
  `@uluops/*` dependency in this package's own tree already requires `>=20.3.0` —
  `@uluops/ops-sdk@5.13.0`, `@uluops/sdk-core@0.15.0`, `@uluops/registry-sdk@0.47.1` — so
  an install on Node 18 produced `EBADENGINE` warnings for the dependencies and then failed
  in test. The bump makes the declared contract match the one that was already being
  enforced by the tree.

  **What a consumer sees:** installing on Node 18 now warns on `@uluops/core` itself rather
  than only on its dependencies. Nothing that worked stops working — Node 18 installs were
  already broken, just not at a layer that named this package. On a `0.x` version a minor is
  the breaking slot, so caret-pinned consumers are minor-locked and will not receive this
  automatically; that is deliberate.

### Internal

- **CI matrix `[18, 20, 22]` → `[20, 22, 24]`.** The 18 entry had been failing on `main` and
  was testing a configuration the dependency tree cannot satisfy — a red that carried no
  information. Node 24 is added because it is current LTS and was previously untested; the
  floor (20) and 22 remain, so the matrix now spans exactly the supported range and nothing
  outside it.

### Security

- **Four high-severity advisories resolved** via `npm audit fix` — all patch-level, no
  package added or removed, no change to `package.json` dependencies:
  `brace-expansion` 1.1.16→1.1.18 / 2.1.2→2.1.4 (DoS, GHSA-mh99-v99m-4gvg and
  GHSA-rgw5-rvv9-x895), `js-yaml` 4.3.0→4.3.1 (quadratic CPU in `!!omap`, GHSA-5p4m-2wfm-xmqj),
  `nanoid` 3.3.16→3.3.18 (GHSA-2v37-7h3g-55p8), `postcss` 8.5.22→8.5.26. All are dev-tooling
  transitives (eslint, vite); none is reachable from published runtime code.

  `npm audit --audit-level=high` — the gate CI runs — now exits clean. One **low**-severity
  `esbuild` advisory remains (GHSA-g7r4-m6w7-qqqr, arbitrary file read via the dev server on
  Windows). It is left unfixed deliberately: it requires a breaking upgrade, affects only the
  dev server on a platform this package is not developed on, and is below the CI threshold.
  Recorded here so its absence from a future audit is a decision someone made, not a fact
  someone assumed.

## [0.36.0] - 2026-08-09

### Dependencies

- **`@uluops/ops-sdk` 5.10.0 → 5.13.0** (exact pin). Additive across all three minors, with
  no change to the per-record contract this release's sanitizers are written against —
  verified field by field before bumping: `recordType` `min(1).max(50)`, `recordId`
  `min(1).max(100)`, `title` `min(1).max(500)`, `classification` `max(50).nullish()`,
  `data` `z.record(z.string(), z.unknown())`, array capped at 100. Every constant in
  `AnalysisSummaryExtractor` still mirrors its counterpart exactly.

  What the range brings: `clusterKey` on `RecommendationInput` (5.12.0, within-run
  convergence) and `mergedIntoIssueId` on issue responses (5.13.0), which makes "where did
  this issue go?" answerable in one call instead of ending at `status: merged`.

### Fixed

- **`recordType` is no longer narrowed against a client-side vocabulary, and the
  four extraction tiers now apply one policy instead of two.**

  `AnalysisSummaryExtractor` held a 47-value `VALID_RECORD_TYPES` set and coerced
  anything outside it to `evidence_finding` — silently, preserving the original
  nowhere, and **only on Tier 2** (structured output). Tier 1 (the JSON code fence)
  passed the identical value through untouched. The same finding therefore survived
  or was flattened depending purely on which channel the agent emitted it through.

  **This is a behaviour change with no signature change**, which is why it is
  recorded here rather than being visible in a diff a consumer would notice:
  `recordType` keeps its type and its bounds, and starts carrying values that
  previously never reached the tracker. Anything reading the field should expect a
  materially wider set. Records whose type used to arrive as `evidence_finding` will
  now arrive as whatever the agent actually declared.

  The set was a vestige of an enum the platform had already removed on purpose.
  ops-api widened `recordType` from `z.enum(...)` to a bounded string so
  "registry-defined agents can introduce new record types without requiring an API
  release to extend the enum" (`ops-uluops-api/CHANGELOG.md:1743`; same rationale at
  `ops-uluops-mcp/src/types/schemas.ts:71-78`). Re-narrowing it here contradicted
  that decision and destroyed the distinction on the way to a `VARCHAR(50)` column
  that was always willing to store it. Measured on the 2026-07-31 corpus: **307
  distinct record types stored, 271 of them outside the set, on 58.5% of all rows.**

  Replaced by `sanitizeRecordType`, applied uniformly to every tier at the same seam
  as `sanitizeRecordSeverity`. It enforces the storage contract and nothing else —
  trim, lowercase, and a 1–50 char bound. Anything unusable becomes
  `evidence_finding` with the original preserved in `data.rawRecordType`, the same
  courtesy severity already received via `data.rawSeverity`.

  Two further defects fixed in passing:
  - **Tier 1 applied no bound at all.** An empty or over-50-char type went straight
    to an API requiring `min(1).max(50)`, whose rejection failed the *entire save*,
    not just the offending record. Now bounded like every other tier.
  - **Tier 4's type selection was dead code.** It read
    `VALID_RECORD_TYPES.has(rec.failureDomain)`, but `failureDomain` is
    `STR|SEM|PRA|EPI` and no domain was ever a member of that set, so the branch
    could never be taken. Behaviour is unchanged (`evidence_finding`); the
    unreachable condition is gone.

  Lowercasing is new normalization, not a pass-through: `Fear` and `fear` would
  otherwise persist as distinct types, distinct dashboard badges and distinct filter
  results. The convention is snake_case throughout and the stored corpus is already
  uniformly lowercase.

  Note this does not by itself tell any agent *which* types to emit — the
  `[record_type from vocabulary]` placeholder in rendered prompts still points at a
  vocabulary with no source (`record_types` is in 0 of 249 definitions and 0 of 4 ADL
  schema versions). This change stops **this writer's four tiers** destroying what agents
  emit through them. It does not cover the harness/MCP `save_run` path, where the
  orchestrator itemizes records by hand and submits without normalization — so a
  normalized/unnormalized split now exists between core-written and hand-written rows.

- **Non-string record types and titles no longer become fabricated values.**

  `recordType` and `title` arrive from `JSON.parse` of model output and can be any JSON
  type. Both were stringified before being bounded, so `{}` became `"[object Object]"` —
  inside every downstream bound, and stored as though the agent had declared it. That is
  worse than the behaviour it replaced: the old path sent the non-string to the API and got
  a loud `ZodError`, whereas a fabricated value is silent and lands in the corpus this
  normalization exists to make measurable.

  Both are now type-checked before bounding, with the original kept in `data.rawRecordType`
  / `data.rawTitle` via a throw-safe stringify (guarded against circular structures, capped
  at 200 chars).

  **Corrected in the same cycle:** the first version of this fix covered Tier 1 only.
  `extractStructuredRecords` still did `String(r.recordType)` and `String(r.title)`, which
  erased the JSON type before the sanitizers could inspect it — so Tier 2 kept fabricating
  while Tier 1 was clean, which is precisely the per-channel divergence the entry above
  indicts. Tier 2 now forwards these fields unconverted and the sanitizers are the single
  place they are typed and bounded.

- **`title` and `classification` are now bounded, closing the last two unguarded fields.**

  The ops-sdk validates the *entire* `analysisRecords` array client-side before the network.
  A single over-length value therefore threw a `ZodError` and lost **the whole run's
  analysis**, not the offending record. `recordId` had been defended since it was added
  (`safeRecordId`), and `severity` and `recordType` were defended above — `title` and
  `classification` were the two left raw, which made the guarantee only as strong as its
  weakest field. Measured before the fix: `title` was a bare pass-through on Tier 2 and
  Tier 4, and `classification` was unbounded on every tier.

  The two are treated differently on purpose:
  - **`title` is prose**, so an over-length one is truncated to the 500-char bound with the
    full text preserved in `data.rawTitle`. A clipped title still identifies the finding.
  - **`classification` is categorical**, so an over-length one becomes `null` with the
    original in `data.rawClassification`. A truncated category is a *different* category,
    and silently inventing one is worse than declaring none — the same reasoning
    `sanitizeRecordSeverity` already applies to an off-vocabulary severity.

  A blank or missing title falls back to `(untitled record)`, since the field is required
  and non-empty at the API; a blank classification is simply `null`, since it is optional.

  All four sanitizers now run at one seam in `buildAnalysisRecords`, so every tier gets
  identical treatment by construction rather than by remembering.

- **`data` is normalized to a plain object, closing the last field in the contract.**

  Measured against the SDK's own `z.record(z.string(), z.unknown())`: a plain object is
  accepted and **every other shape is rejected** — arrays *including `[]`*, `null`,
  `undefined`, and primitives alike. So this was not shape-mangling, it was another
  whole-save killer.

  The array case was live, not hypothetical. The structured-output contract expresses data
  as `[{key, value}]` entries, and the conversion existed only inside
  `extractStructuredRecords` — so Tier 2 handled it and **Tier 1 did not**, making a fenced
  record carrying the entries shape a save-killer. The conversion moved to
  `sanitizeRecordData`, which also handles the non-entries array the old inline version
  silently turned into `{undefined: undefined}` by mapping absent `.key` fields. Entries
  convert, other arrays and primitives are preserved under `rawData`, empty array and null
  become `{}`.

  **`sanitizeRecordData` runs FIRST and the order is load-bearing.** Every other sanitizer
  preserves its rejected value by spreading `record.data`, and spreading an array yields
  `{0: …, 1: …}`. Normalizing data up front is what makes those spreads safe. This is
  enforced by a test that fails when the call is moved later, rather than asserted in a
  comment.

## [0.35.0] - 2026-07-22

### Changed

- **`classifyDecision` module re-exported from `@uluops/sdk-core/decisions`**
  (implementation moved there; all `@uluops/core` import paths unchanged).
  Rationale: the module is pure and dependency-free, and register consumers
  like the ops API need it without this package's AI-SDK stack (OQ-1b,
  save-run-decision-semantics spec v0.2.1).
- **Register extension via sdk-core 0.16.0** (issue `44a7a67c`):
  `APPROVED`/`PROCEED` → positive, `BLOCKED` → negative. Behavior change:
  `SubmissionClient.isPositiveDecision` now reports `allGatesPassed: true`
  for APPROVED/PROCEED results (previously neutral → fail-closed `false`),
  and executor gating treats BLOCKED as negative. Intended corrections —
  these are genuine gate verdicts, previously desynced from ops-api's
  interim register.

### Dependencies

- `@uluops/sdk-core` → **0.16.0** (decisions module home).

## [0.34.0] - 2026-07-19

### Changed

- **`RunSubmissionResponse.allGatesPassed` and `RunHistoryEntry.allGatesPassed`
  widen to `boolean | null`.** These types re-expose values read from the ops
  API, whose read shape is nullable since `@uluops/ops-sdk@5.10.0`: `null` =
  **NOT_A_GATE** — the run carried no gate-bearing agents (e.g. a
  cognitive-lens-only run), distinct from `false` (a gate ran and failed).
  Render `null` neutrally and exclude null runs from pass-rate computations.

### Design Notes

- **Read/write asymmetry is deliberate.** The `SubmissionClient` WRITE path
  still asserts an explicit boolean verdict via the polarity classifier
  (`isPositiveDecision`, fail-closed) — `null` is never a valid input value
  (save-run-decision-semantics spec v0.2.1, D6). Whether the submission path
  should instead omit the verdict for lens-only runs (letting the API infer
  NOT_A_GATE) is an open question deferred with that spec's Change 2.

### Dependencies

- `@uluops/ops-sdk` 5.8.0 → **5.10.0** (nullable `allGatesPassed` read schemas).

### Security

- Transitive `brace-expansion` (under `glob`) bumped to **5.0.7** via
  `npm audit fix` (lockfile-only) — remediates GHSA-3jxr-9vmj-r5cp (high,
  DoS via exponential-time expansion). The advisory published between this
  version's local validation and its npm publish, tripping the
  `prepublishOnly` audit gate.

## [0.33.0] - 2026-07-10

Two branches merged: `fix/core-top10-second-pass` (gating-semantics decisions, composite confidence, type-safety refactors) and `fix/core-top10-third-pass` (dx error-contract batch, usage shape-drift signal). 20 tracker issues closed. Three 0.30.0 Design Notes are superseded below (marked ⤳).

### Changed — BEHAVIOR

- **PASS + partial is a decided, gate-satisfying state** (issue fdaa0b24, decision 2026-07-10). An agent that could not touch the full file span but found no issues in what it covered has passed the scope it covered; gates treat the decision as-is and never downgrade on completeness. The decision record (with its two load-bearing invariants: every coverage reduction emits a marker; completeness stays distinguishable wherever consumed) lives in `types/degradation.ts`.
- **Scored-lens-negative caps the aggregate at WARN** (issue d60c2ea2, decision 2026-07-10; ⤳ supersedes the 0.30.0 "routed to the composition-aggregation spec" scope line). A scored child whose vocabulary-declared decision resolves `negative` (e.g. DISORDERED@82) caps a multi-agent command at `WARN`/`conditional` and a passed workflow phase at `warned` — never an unqualified pass, never a hard fail. Closes the scored/scoreless asymmetry where a lens gated only if it happened to omit a score.
- **Crashed parallel command agents now fail the command** (issue 77febff2, decision 2026-07-10). A rejected agent in `sequential: false` execution synthesizes a negative-category, null-score placeholder result (PipelineExecutor inline-agent / WorkflowExecutor parallel-step parity) — the scoreless-negative guard then fails the command instead of letting survivors stamp `PASS` over a partially-crashed panel. Survivors' work and scores are preserved; the crash surfaces as a critical recommendation; all-crashed still throws `ExecutionError`.
- **Verdict-gating conditions fail closed on a crashed gate stage** (issue 10908362; ⤳ supersedes the 0.30.0 "fails open if the upstream stage crashed" note). Result fields of a stage that EXISTS but never completed (crashed/skipped) are now known-absent in condition evaluation: `stages.gate.decisionCategory == 'positive'` is `false`, `!=` is `true`, bare truthiness is `false`; ordering comparators stay unknown. The typo fail-open (unknown stage id → run + warn) and field absence on a COMPLETED stage are unchanged. Verdict-coloring-is-not-halting stands; a pipeline-level `on_failure` posture remains a PDL-spec question.
- **Short `ulr_` API keys fail at the config boundary** as `ConfigurationError` (`key too short (min 20 chars)`, key redacted) instead of sdk-core's `ValidationError` from inside client construction (issue 309875ff). `resolveConfig` mirrors sdk-core's exported `MIN_API_KEY_LENGTH`.
- **Malformed local agent YAML fails loud and named** (issues 34c6e6ec / 2563691d). A local `.agent.yaml` with no top-level `agent:` section, or missing `agent.interface`, throws `ConfigurationError` naming the file and the missing section — previously the former silently resolved to an empty-prompt runtime and the latter crashed as a raw `TypeError` in `buildAgentConfig`. The remote path is unchanged (registry-validated at publish; degrades defensively).

### Added

- **`ExecutionResult.extractionConfidence`** — on composite results (command/workflow/pipeline) this is the WORST child's extraction confidence, propagated through all three AgentResult→CommandResult conversion sites plus workflow/pipeline aggregation (issue e037aa98). The submission gate (`isPositiveDecision`) now refuses `allGatesPassed` on a composite whose weakest child was regex-parsed below the trust threshold — a phase whose agent parsed PASS at 0.4 no longer launders through aggregation. Min, not average: one untrustworthy child taints the composite's positive verdict. New util `worstExtractionConfidence` (exported source, internal use).
- **`context.evicted` degradation marker** (degraded severity). Provider-side context management (Anthropic, 50%-of-budget trigger) previously evicted old tool results with no signal — coverage loss below the wrap-up latch reported `complete`. `TokenBudgetTracker` now detects the step-over-step context-window shrink (sticky flag, 5% jitter floor, `evictedTokens` total in the marker detail).
- **`usage.provider-metadata-shape-drift` degradation marker** (info severity — metrics quality, not verdict evidence; completeness untouched) (issue adaaa4b9). `mapUsage` reaches into undocumented provider-metadata shapes via casts; when a provider SDK renames its usage fields the casts silently resolve `undefined` and token/cache/thinking metrics read zero. Non-empty provider metadata with zero recognized keys now sets `AIGenerateResult.usageShapeDrift` and emits the marker; the warn log is deduped per provider per process. Conservative by design: absent/empty metadata is NOT drift (fields are legitimately omitted, e.g. uncached runs).
- **Offline fallback aliases for registry outages** (issue 172518e2). A cold process resolving a well-known model alias (`sonnet`/`haiku`/`opus`) while the registry is unreachable previously failed before any LLM call. `ModelCatalog` now falls back to a baked-in table on transport errors only — never on 404 (an alias the registry says doesn't exist still fails), never cached (registry recovery wins the next resolve), default-deny capabilities (structured output off), loud warn. The table is a documented decay surface: refresh alongside registry model syncs.
- **`ValidationError` / `isValidationError` re-exported** from `@uluops/core` (errors barrel + package root) so runtime 400s are instanceof-checkable through this package (issue 4d7f0946). Documented as extending `SdkApiError`, not `UluOpsError`.
- **`resolveDecisionCategory(result, onUnclassified?)`** — optional gate-boundary tripwire (issue 3e74bc69; ⤳ hardens the 0.30.0 "mixed-version contract" note). Command/workflow/pipeline gate sites now warn when a non-empty unstamped decision resolves `neutral` — the 0.29.x/hand-built blind spot where a custom-vocabulary negative silently non-gates. In-process 0.30+ producers always stamp, so a firing means a foreign or downlevel result crossed a gate. `CommandExecutor`/`WorkflowExecutor` gained optional trailing `logger` constructor params (backward compatible).
- README: **Local Definition File Naming** section — the `<name>.<type>.yaml` convention table and base-dir → subdirectory scan order (issue 0c8aea72).

### Changed — TYPES

- **`ResolvedDefinition` is now a union discriminated on `type`** (issue a9d65912). Checking `resolved.type === 'command'` narrows `resolved.definition` to `CommandDefinition` — the executors' runtime type checks narrow instead of being followed by `as XxxDefinition` casts. The type/definition correlation enters the type system at RegistryClient's two producer casts only (documented as the trust point); the `agent` variant stays Partial-tolerant (content-gated resolutions carry no YAML); `runtime` is deliberately NOT correlated (it depends on `agentType`, not `type` — a command ref can resolve to an agent runtime). New exported `ResolvedDefinitionBase`. Consumers constructing `ResolvedDefinition` literals must now match a variant; consumers that only read results are unaffected.

### Internal

- `PipelineExecutor.executeStage` decomposed into `executeAgentsStage` / `executeStepsStage` / `executeRefStage` with the shared failure envelope in the dispatcher (issue 2d5f3913). Bodies moved verbatim.
- `AnalysisSummaryExtractor.validateSectionShape` is a type predicate — the exploration-map sections double assertion is gone (issue 62c9f1dd).
- Bash-tool version-mismatch error now names both remedies, leading with the likelier direction (SDK bumped ahead → update `ANTHROPIC_BASH_TOOL_VERSION`; reverse → update `@ai-sdk/anthropic`) (issue f90fbbbc).
- Test API-key literals lengthened to ≥ `MIN_API_KEY_LENGTH` (the new config-boundary check applies to tests too).

### Design Notes

- Dispositioned as observations, not code (tracker): the AI SDK sole-callsite coupling ("the coupling is the investment", SCOPE.md), the AgentExecutor convergence funnel (trigger recorded: validate the universal schema serves a new agent type BEFORE wiring it through), and the sdk-core re-export facade + `@ai-sdk/*` dynamic-import trust boundary (deliberate, documented; its testing ask is enacted by the shape-drift detector).
- Residual, not green-lit: forwarding completeness/degradation markers over the tracker wire (ops-sdk `AgentInput` + tracker schema + migration). Invariant (2) of the PASS+partial decision currently holds in-process only; `SubmissionClient.resultToAgent` still drops completeness. Recorded on issue fdaa0b24.

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
