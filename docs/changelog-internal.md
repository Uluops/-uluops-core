# Changelog — internal notes

The `Internal` (test/CI/build-only) and `Design Notes` sections of `CHANGELOG.md`, by release. They were moved out of the shipped changelog on 2026-11-01 (docs pass, consumer-validate run #123): they carry no consumer-facing API impact, and the CHANGELOG ships in every npm install. This file is repository-only (`docs/` is not published). Entries are unchanged; each sits under the release heading it had.

## [0.56.0] - 2026-11-01

### Design Notes

- **An extractor fall-through was built for 0.56.0 and reverted before release.** It stopped a JSON
  object with no decision and no score from winning its extraction rung, so a prose `Decision:` line
  beside it would be read instead. Its premise was wrong. An agent result's decision and score are the
  gate's reading (`readAgentVerdict`), never the extractor's, so the change could not move them. What
  it did move was `extractionConfidence`, from 0.95/0.9/0.75 down to 0.5. Below 0.7 `SubmissionClient`
  refuses a positive verdict, and `extraction.low-confidence` marks the run partial. So a clean
  `Decision: PASS` beside a records-only JSON block would have saved as not passed. Found by
  wittgenstein-analyst in consumer-validate run #123 (CGC-1). A future change to the rungs moves that
  refusal and those markers, not the decision.


## [0.55.0] - 2026-10-31

### Internal

- Conformance fixtures re-copied from corpus `feat/pdl-1.6.0-r-d12` (`e539222c`): 163 cases. Four
  expectations flip to ERRORED (`absent-with-passing-score`, `absent-with-failing-score`,
  `path-fallback-only`, `path-status-fallback-only`), and nine cases are new. Against 0.54.0 the copy
  fails 23 tests; the D47 and D12 lines each fail their own tests when removed.
- OQ-3 (refs out of scope) is pinned by a `PipelineExecutor` unit test, since the fixture format has
  no ref stubs (Alex, 2026-10-31).


## [0.54.0] - 2026-10-27

### Internal

- `test/fuzz/stopVerdict.fuzz.test.ts` (P4b): the pipeline oracle is rewritten to the 1.6.0 run model
  from the spec's rules (failure modes, decision key, ERRORED for stopped and unjudgeable stages,
  abort cascade, the run verdict) and now also compares each stage's `outcome` and the run's
  `allGatesPassed`; the layout check maps a workflow's verdict to its pipeline split instead of
  equating them. Checked by breaking it: a blocking-default decision key and a dropped stop clause
  each produce mismatches (47 and 71 of 1,500 pipelines). Only the deferred `[fcancel]` class remains.
- `test/fuzz/stopVerdict.fuzz.test.ts` (P4a): the agents-stage model marks a stage failed when an agent
  is unjudgeable (D24); generated agents declare a register-token vocabulary, as do the default agents
  of `test/executor/fixtures.ts`'s registry, so the pre-launch check passes them without changing how
  they classify.
- `scripts/external-input-census.json` (P4a): three sites, each waived — the pre-check's registry
  resolve (read for vocabulary presence only), the score contract's numeric-string read, and the
  moved score-resolver probe.
- `test/fuzz/stopVerdict.fuzz.test.ts`: the pipeline model follows D3 (dependencies never skip a stage)
  and expects G5 to refuse at `start()`; 245 of its generated pipelines take that path.
- `scripts/external-input-census.json`: the old evaluator's numeric-literal parse is gone with
  ordering operators (one `string-to-number` site removed).
- `scripts/external-input-census.json`: two entry points move (the env read and the clamped
  resolution); both are seamed (`parseExternalNumber`, `externalInt`).


## [0.50.0] - 2026-10-06

### Design Notes

- **Known limit: a foreign `CANCELLED` in the same microtask as a stop.** A single-agent command
  step or ref stage whose agent rejects with `code: 'CANCELLED'` while the run signal is still live
  is a crash, but it is classified where the step or stage rejects, after propagation. A run stop
  landing inside that same microtask drain (e.g. `cancel()` called synchronously from a callback)
  records it `ABORTED`. Stops that arrive as separate events (a timer, a response, user input)
  cannot land inside that window. Tracked from the run #114 fuzz; not fixed in this release.

- **A stopped run can make its stopped agents' open issues read as resolved.** The tracker reads
  a finding absent from a run as RESOLVED (and its return as a regression); a stopped run lacks
  its stopped agents' findings, and nothing on the wire says those agents did not run. Crash
  records already had this gap. Tracked separately: it needs a wire signal and a tracker
  correlation change.


## [0.46.0] - 2026-10-04

### Internal

- `@openrouter/ai-sdk-provider` 2.10.0 is an exact **dev** dependency so the tests run against
  the real package. It is not a runtime dependency; consumers install it.


## [0.45.0] - 2026-10-03

### Internal

- **Dev-dependency advisories cleared; CI `security-audit` green again.** The job audits dev
  dependencies at `--audit-level=high` and had failed since 0.43.6 on `js-yaml` 4.3.1 (via
  eslint), `brace-expansion` (via eslint, typescript-eslint and glob's minimatch) and `esbuild`
  0.27.3-0.28.0 (via tsx and vite). `npm audit fix` moved the first two in range (`js-yaml`
  4.3.2). It cleared `esbuild` by **downgrading** to 0.27.2, below the vulnerable range, because
  tsx 4.21.0 pins `esbuild ~0.27.0`; instead the exact `tsx` dev pin moves to 4.23.15 (same
  major, `esbuild ~0.28.0`), which brings `esbuild` 0.28.2 forward. Nothing here ships in the
  package; the production audit (`--omit=dev`, part of `prepublishOnly`) was already clean.
- **Left open, below CI's threshold:** two moderate advisories in `vitest` / `@vitest/mocker`
  (GHSA-82fw-gwwq-j7x9). The only fix is vitest 5, a major upgrade, which is its own change.


## [0.44.1] - 2026-10-03

### Internal

- The `ModelCatalog` test fixture fabricated `{ status: 404 }`, a shape the SDK never produces,
  which is why 63 tests passed over the defect. Fixtures now build the real registry-sdk
  `NotFoundError`. Negative control: against the unfixed check, 19 of 63 tests fail.


## [0.42.0] - 2026-08-23

### Design Notes

- **64 `POSITIVE CONTROL:` comments across the test suite are PROSE, and only those
  exercised this session have been mechanically verified.** Each names the reversion that
  should make its test fail. One was found false during this release's ship gate — it claimed
  three tests would fail and two did — and there is no mechanism that could have found it
  other than trying it.

  > **Ranking corrected.** This entry called the prose controls *"the largest un-instrumented
  > assurance surface remaining"* and a later gate pass argued that is wrong, convincingly: a
  > false `POSITIVE CONTROL:` comment misdescribes *which* tests a reversion would break,
  > while the test underneath still executes real assertions on every one of the 1,371-test
  > runs — imprecise, not inert. An uncontrolled **gate** has nothing else covering it; if it
  > silently stops working the output is a green line reading "none unguarded" that no other
  > mechanism contradicts. The largest surface was the audit script's own guard logic, and it
  > is now controlled (see Fixed). Building a harness for the 64 was assessed and
  > deliberately not done — the risk is real but it is the cheaper one, and ranking it first
  > pointed the next reader's attention at the wrong thing.

- **Every entry-point count in this document is a point-in-time measurement, and the live
  figure is whatever `npm run check:external-inputs` prints.** This section quotes 75 (sixth
  sweep) and 132 (seventh); the committed baseline currently holds 136 across 9 channels.
  A ship-gate review flagged the three as a contradiction, and it read as one: a release
  whose subject is *a stated number that no longer describes the state* reporting its own
  headline metric three ways. They are not in conflict — each is correct for its pass, and
  the surface grew because the instrument's reach grew, which is the finding. They are now
  labelled with their pass so a reader does not have to reconstruct that. **Do not
  transcribe any of them as current.** The census is the source; the document is a log.

- **Deliberately NOT fixed in 0.42.0, ranked and recorded rather than guessed at.** The
  stage-4 audit re-ranked these against the current tree and none is critical: `cancel()`
  does not reach the shell tool, so an `sh -c` child keeps running after a cancel (bounded at
  `SHELL_COMMAND_TIMEOUT_MS`, 30 s); the local-definitions path ignores a pinned version
  (`RegistryClient.resolve` drops `version` on that branch — dev-mode affordance, mitigated
  by opt-in `verifyPins`); duplicate phase ids are reported as a dependency cycle with an
  empty offender list (fails closed at planning time, but sends the reader to `depends_on`
  where the bug is not); an empty or comment-only local YAML crashes with a raw `TypeError`
  outside `resolve()`'s documented `ConfigurationError` contract.

- **`clampModelBound`: an unusable SUPPLIED value clamps to the floor (1 ms), not to the
  operator default — and the helper's own prose says otherwise.** Two test names in
  `shellExecutor.bounds.test.ts` also describe the fallback reading. Changing the code to
  match the prose was tried and reverted: `StepsExecutor`'s "a step that sets `timeout: 0`
  is still bounded" asserts elapsed < 3,500 ms against a 4 s sleep, which a 60 s
  `DEFAULT_STEP_TIMEOUT` can never satisfy — so that call site's assertion pins the floor
  reading while its sibling's name promises the other. Both readings are safely bounded;
  they differ in whether a nonsensical authored timeout kills a command instantly or runs it
  to the sane default. Recorded for a deliberate decision rather than settled in passing.


- **RESOLVED IN THIS RELEASE — kept for its reasoning, not as an open item.** ⚠ This entry
  said "UNRESOLVED, flagged rather than decided" until 2026-08-24, by which point the
  release had decided it: `aggregateScores` returns `null` for the all-scoreless case (see
  Fixed above), the test named below is retired, and the two aggregators now agree on every
  case except authored-empty, which is deliberate and documented at both sites. A ship-gate
  review found this note still asserting the divergence was live — a stale claim sitting
  beside the state it describes, which is the exact defect shape this release is about, in
  the document that describes it. The original text follows because the reasoning that
  classified this as a decision rather than a repair is the part worth keeping.

  ~~`aggregateScores` returns `0` when items ran but none produce scores; `aggregatePhaseScore`
  returns `null` for the same input. Under `evaluateGate` that is not cosmetic — **0 BLOCKS
  and null PASSES** — so an all-generator panel fails its gate in a pipeline or command and
  passes it in a workflow.

  Evidence pulls both ways, which is why it is recorded at both sites rather than corrected:
  `PhaseResult.score` and `CommandResult.score` are both `number | null` documented *"null
  for scoreless (generator/executor) commands"*, and the score-nullability spec says do not
  coerce to 0 — but a test pins `returns 0 when all items have null scores`, and changing it
  alters gate semantics for every pipeline and command rather than a single value. That is a
  behavioural decision about what a scoreless panel means at a gate, not a mechanical repair.~~


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


## [0.37.1] - 2026-08-19

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

### Internal

- **CI matrix `[18, 20, 22]` → `[20, 22, 24]`.** The 18 entry had been failing on `main` and
  was testing a configuration the dependency tree cannot satisfy — a red that carried no
  information. Node 24 is added because it is current LTS and was previously untested; the
  floor (20) and 22 remain, so the matrix now spans exactly the supported range and nothing
  outside it.


## [0.34.0] - 2026-07-19

### Design Notes

- **Read/write asymmetry is deliberate.** The `SubmissionClient` WRITE path
  still asserts an explicit boolean verdict via the polarity classifier
  (`isPositiveDecision`, fail-closed) — `null` is never a valid input value
  (save-run-decision-semantics spec v0.2.1, D6). Whether the submission path
  should instead omit the verdict for lens-only runs (letting the API infer
  NOT_A_GATE) is an open question deferred with that spec's Change 2.


## [0.33.0] - 2026-07-10

### Internal

- `PipelineExecutor.executeStage` decomposed into `executeAgentsStage` / `executeStepsStage` / `executeRefStage` with the shared failure envelope in the dispatcher (issue 2d5f3913). Bodies moved verbatim.
- `AnalysisSummaryExtractor.validateSectionShape` is a type predicate — the exploration-map sections double assertion is gone (issue 62c9f1dd).
- Bash-tool version-mismatch error now names both remedies, leading with the likelier direction (SDK bumped ahead → update `ANTHROPIC_BASH_TOOL_VERSION`; reverse → update `@ai-sdk/anthropic`) (issue f90fbbbc).
- Test API-key literals lengthened to ≥ `MIN_API_KEY_LENGTH` (the new config-boundary check applies to tests too).

### Design Notes

- Dispositioned as observations, not code (tracker): the AI SDK sole-callsite coupling ("the coupling is the investment", SCOPE.md), the AgentExecutor convergence funnel (trigger recorded: validate the universal schema serves a new agent type BEFORE wiring it through), and the sdk-core re-export facade + `@ai-sdk/*` dynamic-import trust boundary (deliberate, documented; its testing ask is enacted by the shape-drift detector).
- Residual, not green-lit: forwarding completeness/degradation markers over the tracker wire (ops-sdk `AgentInput` + tracker schema + migration). Invariant (2) of the PASS+partial decision currently holds in-process only; `SubmissionClient.resultToAgent` still drops completeness. Recorded on issue fdaa0b24.


## [0.31.0] - 2026-07-08

### Design Notes

- **The slice is severity-sorted by the engine** (critical > high > medium > low > info > unknown, stable within tiers) because `flattenRecommendations` produces category-declaration order, not rank — trusting it as ranked would silently drop a critical finding from a late rubric category out of the top-5 (run #31 A2/F2, the pre-impl run's top finding).
- Forwarding is **one hop** (direct `depends_on` only, no transitive closure) and **inline-agent stages only** on the receiving side; forwarding into command/workflow ref executions is the workflow-twin phase (spec §3.6). Fleet grep 2026-07-08: all 68 synthesis stages are inline-agent, so Phase 1 covers every synthesis consumer.
- Labeled-absence entries (`### <stage> — no output (…)`) are reachable only in partial multi-dependency topologies — `checkStageDependencies` skips a downstream stage whenever any dependency is non-completed, so the single-dependency crash case cannot occur by construction. Kept as defensive coverage.
- Steps-only upstream stages forward nothing (their signal already flows through `condition:` expressions). Parallel sibling slices concatenate in declaration order (pinned by an ordering-contract test); siblings never see each other.


## [0.30.0] - 2026-07-08

### Design Notes

- Unstamped custom decision strings still resolve `neutral` — the fallback boundary is explicit and tested. Producers must stamp; consumers must resolve. SCOPE.md's "Error propagation across layers" tension moves from Unexamined to Partially examined (decision propagation closed; thrown-error propagation remains open).
- **Verdict coloring is not halting:** a negative-verdict stage keeps `status: 'completed'`, and pipeline `depends_on` gates on completion — downstream stages still run after an upstream FAIL verdict (only thrown/skipped stages block dependents; the pipeline-level decision is still correctly negative). Verdict-gating a downstream stage requires an explicit `condition` on `stages.<id>.decisionCategory`, which fails open if the upstream stage crashed. A pipeline-level `on_failure` posture does not exist yet.
- **Mixed-version contract:** `decisionCategory` is optional, so results produced by 0.29.x (or hand-built without the stamp) fall back to `classifyDecision` over the raw string — custom-vocabulary negatives from unstamped results resolve `neutral` and do not gate. Custom-negative gating is only as strong as the producing side's version.
- **Gate polarity is deliberately asymmetric:** executor gates fail open on ambiguity (must resolve `negative` to block), submission's `allGatesPassed` fails closed (must affirmatively resolve `positive`). An ambiguous result flows through stages but is never reported as a pass. Documented at `SubmissionClient.isPositiveDecision`.
- Consumers relying on the old literal `PASS|SHIP` fallback should note: scoreless `COMPLETE` commands and WDL-remapped positive workflow decisions now correctly report `allGatesPassed: true` (Aporia A3 closed for non-PASS positives).


## [0.29.0] - 2026-07-07

### Design Notes

- The D2 interim posture (null score but `completed`/`PASS` for unexecuted steps stages) deliberately retains one dishonesty — a PASS that verified nothing — to avoid cascading `depends_on:[preflight]` skips across the 30 detection pipelines. Full honesty arrives when steps execute under the opt-in. See pdl-steps-execution-spec-v0_1_1 D2.


## [0.28.0] - 2026-07-02

### Design Notes

- Consequence: `epistemicAssessment` is non-null for any summary whose result
  carries extraction facts (previously null without an agent epistemic
  block); `systemMetrics` is nullable (previously always an envelope-bearing
  object). Downstream tracker rows written by ≤0.27.0 carry the old envelope
  — no backfill (spec D5); the ops-api ingest floor (1.65.0) annotates
  wrong-shaped values but deliberately does not strip these all-scalar keys.


## [0.24.2] - 2026-06-24

### Design Notes

- The normalization transforms are a **faithful port** of `@uluops/definition-factory`'s `src/normalization/` module into `src/registry/normalize.ts`, NOT a dependency. `@uluops/definition-factory` is private IP (rendering engine, templates, scoring/translation) and `@uluops/core` publishes publicly to npm, so a dependency edge would force the factory's install tree public. Only the mundane authoring→runtime field mappings are reproduced; none of the factory's IP is involved. Keep the ported module in sync with the factory source (drift between local and server normalization reintroduces exactly this class of local≠remote bug).


## [0.23.0] - 2026-06-22

### Design Notes

- **Why `null`, not `0`.** The change preserves the distinction between *"scored zero"* (a real low score) and *"did not score"* (a generator/executor). Fabricating `0`/`100` conflated them; `null` keeps them separable for analytics, gating, and lineage. Origin: Zhuangzi finding on `-uluops-core` (EPI-OVR/M, run `f7f3d858`).


## [0.22.6] - 2026-06-16

### Internal

- **Locked the `buildAnalysisRecords` tier precedence.** The record-derivation cascade (analysis-block → structured-output → exploration-maps → recommendations) is first-non-empty-wins, with each tier the primary source for a different agent class — so the ordering is a contract, and a reorder/removal silently changes the persisted record shape for that class. Documented the cascade semantics + per-class mapping on the method, and added "record tier precedence" boundary tests (T1>T2, T2>T3, T3>T4; T1>T4 was already covered) so any future tier change is a loud failure rather than silent data loss. No behavior change. (tracker 30ac11b3, STR-INC/L)


## [0.22.5] - 2026-06-16

### Design Notes

- **Documented why `DEFAULT_CAPABILITIES.structuredOutput` is default-deny.** Models absent from the registry (unregistered explicit `provider:modelId`, or an alias with no model object) fall back to these defaults; `structuredOutput: false` is intentional — with no capability data, assuming structured-output support produces hard API errors when wrong, whereas text extraction works for any model emitting a JSON fence (and is non-destructive since the Option B fix). Added a source comment so the deliberate default isn't "fixed" to `true`. No behavior change. (tracker 8caa7b45, PRA-FRA/L)


## [0.22.4] - 2026-06-16

### Internal

- **Config resolution extracted to pure, directly-testable functions.** `resolveConfig`/`resolveAIConfig` (plus `parseMaxConcurrency`/`parseAllowedTools`) moved from private `UluOpsClient` methods to module-level functions that take an explicit `env` argument (defaulting to `process.env`). No public API change — neither is re-exported from the package entry; behavior is identical (the constructor still calls `resolveConfig(config)`). This replaces ~25 brittle `UluOpsClient` tests that introspected the mocked `RegistryClient` constructor's arguments to observe resolved config — they now assert the pure function's return value against an explicit env, decoupled from collaborator wiring and immune to global-env pollution. Added HTTPS-enforcement, localhost-allowance, and offline-no-key behavioral cases. (tracker 385650e4, EPI-GRN/M)


## [0.22.1] - 2026-06-16

### Internal

- New test: typed-resolve 404 wrap (`ConfigurationError` with `client.list()` guidance). Suite → 707.


## [0.22.0] - 2026-06-15

### Internal

- New tests: `deriveCompleteness` rule table, `resolutionMarkersFromLegacy` byte-exact mapping, `TokenBudgetTracker.forcedWrapUp`, AIProvider latch-sets-tracker-flag, and AgentExecutor completeness/marker cases. Suite → 706.
- Pre-implementation-architect reviewed (PROCEED, 88/100); required amendments folded into spec v0.2.1 before implementation.


## [0.21.1] - 2026-06-15

### Internal

- New `DEFAULT_MAX_CONCURRENCY` constant; `maxConcurrency` added to `UluOpsConfig` (optional) and `ResolvedConfig` (required, defaulted in `UluOpsClient`).
- New tests: `Semaphore.test.ts` (concurrency bound, release-on-throw, FIFO drain, non-positive clamp), AIProvider latch-reset hysteresis, and AgentExecutor maxSteps-exhaustion throw + negative case. Suite → 690.
- The universal output schema's `.nullable()` convention (PRA-FRA/H from the same run) was reviewed and **accepted as-is**: it is a hard OpenAI strict-mode constraint, the null→undefined remap is small and centralized, and the compile-time sync guard is a feature. Already documented in `src/parser/outputSchemas.ts`; routing evolution belongs in the model-capability catalog instead.


## [0.21.0] - 2026-06-15

### Internal

- Locked `@uluops/registry-sdk` to `0.32.1` (the `structuredOutputWithTools` capability field).


## [0.19.0] - 2026-06-13

### Internal

- Bumped `@uluops/registry-sdk` to `0.32.0` (exact) for the `Model.limits` field.
- New tests: `contextBudget.test.ts` (derivation rule table), `ModelCatalog` window-copy cases, AIProvider window-sized eviction, and AgentExecutor end-to-end budget threading. Suite → 666.


## [0.18.5] - 2026-06-05

### Internal

- New test in `UluOpsClient.test.ts` verifies `describe(name, version, type)` forwards all three positional args to `registry.resolve`.


## [0.18.3] - 2026-06-02

### Internal

- `ResolvedExecutionContext` now includes `reportMode: boolean` (resolved from `ExecutionOptions.reportMode ?? false` in `resolveContext`). Existing consumers that construct `ResolvedExecutionContext` literals must now provide this field; consumers that go through `resolveContext` are unaffected.


## [0.11.0] - 2026-05-20

### Design Notes

- Agent recording is non-fatal — if an agent name doesn't match a published registry definition, the failure is silently caught
- Direct agent runs (`runAgent`) skip per-agent recording since the top-level IS the agent
- Pipelines via `startPipeline()` are not covered by this path — the webhook and sync service paths handle pipeline-level per-agent recording via `agent_snapshots`
- See `plans/execution-recording-integrity-spec-v0_1_0.md` for the full spec and name-game analysis
