# PDL 1.6.0 conformance fixtures

The oracle for PDL 1.6.0's runtime rules. The PDL spec is normative; these files say what
each rule produces on a concrete pipeline, so core, the factory and the `pdl-executor` skill
can be held to the same answers. They were written before any runtime work (P0b), from
`uluops-specifications/specs/cross-repo/drafts/pdl-1_6_0/pdl-1_6_0-spec-v0_8_2.md`
(written against v0.6.0; the questions they raised were ruled and folded into v0.7.0, v0.8.0 and v0.8.1).
R-D12 (spec v0.9.0, 2026-10-31) flipped the absent-decision cases to ERRORED at blocking gates (D12) and
added the gate-class, `Decision:`-line, envelope and echo cases (D12, D46, D47).
Section references (`§3.2`) are to that spec. Decision references are to its §4 (`D6`), or
to the gate-decision spec where marked `gate-decision D2`.

## Layout

```
cases/<group>.cases.yaml        inputs: pipeline, params, target, stub outputs, run options
expected/<group>.expected.yaml  the oracle, keyed by case id
stubs/agents.yaml               stub agent definitions (type and vocabulary only)
targets/                        the directory tree steps run against
```

Groups: `gates`, `decisions`, `conditions`, `steps`, `run-control`, `load-errors`.

**Inputs and expectations are in separate files on purpose.** The skill is run by a model.
A model that reads a case's expected outcome while orchestrating it can drift toward that
outcome, and the run then proves nothing. A skill harness gives the orchestrator only the
case file and the stubs, and compares against `expected/` afterwards.

Run `npm run check:conformance` after any edit. It checks the files' internal consistency
(every case has exactly one expectation, stub names resolve, no stub is used twice in a
case, templates are well formed). It does not run any runtime. `--control` feeds it broken
copies and confirms each check fires.

## Case format

```yaml
cases:
  - id: gates/fail-continues          # <group>/<slug>, unique across all files
    covers: ["§3.2 failure modes", D1] # spec sections and decisions this case pins
    applies_to: [core, skill]          # which runtimes must pass it (below)
    target: dir                        # dir | file | symlink (below). Default dir.
    params: { mode: deep }             # run parameters, as the caller passes them
    run: { steps: enabled }            # run options (below). Default: steps enabled.
    stubs:                             # what each stub agent outputs in this case
      stub-gate-a: { decision: REVISE, score: 90 }
    events:                            # optional mid-run actions (run-control only)
      - { when: "stage:b:running", do: cancel }
    pipeline:                          # compact pipeline (below)
      parameters: [ ... ]
      stages: [ ... ]
    note: free text                    # why the case exists, when that is not obvious
```

### The compact pipeline

`pipeline:` holds `parameters` (the manual trigger's parameter list) and `stages`, written
as in a `.pipeline.yaml` except that a stage may leave out `name`. A harness wraps it into a
full document:

```yaml
pipeline:
  interface:
    name: conf-<slug>
    version: "0.0.0"
    displayName: "conf <slug>"
    description: "PDL conformance case <id>"
    domain: general
  triggers:
    - type: manual
      allowed: true
      parameters: <parameters, with { name: target, type: string, required: true } prepended
                   when the case does not declare target itself>
  stages: <stages, each given name: <id> when it has no name>
```

Nothing else is added. A case that needs a field outside `parameters` and `stages` does not
exist yet; add the wrapping rule here first if one ever does.

**The wrapped document is a valid PDL 1.6.0 pipeline** for every case whose outcome is not
`load_error`, and every `unknown_key` case is rejected by the 1.6.0 schema. Until P0a the
rule above omitted `displayName` and `domain`, both required by `interface`, and no case
gave its stages the required `name`, so no wrapped case validated against any PDL schema.
`check:conformance` cannot catch that (it has no JSON-schema validator); P0a found it by
validating every wrapped case against the schema, and P1's factory tests carry that check
from then on. `name` is display-only in every runtime, which is why the harness supplies it
rather than 143 cases repeating each stage's id.

### Targets

| `target:` | `params.target` is | steps run in (§3.4) |
|---|---|---|
| `dir` | `targets/project` | `targets/project` |
| `file` | `targets/project/docs/design-spec.md` | `targets/project/docs` |
| `symlink` | `targets/linked-spec.md` (a symlink to the file above) | `targets/project/docs`, the real file's parent |

The harness passes the path relative to this directory unless the case sets `params.target`
itself; the runtime resolves it (§3.4: realpath, absolute `{{ params.target }}`). A harness
that writes into the target (a skill harness writing stub output files, say) works on a
copy, never on `targets/` itself: several cases assert that a file was *not* created there.

### Run options

`run.steps: enabled | disabled`. Core runs steps only when enabled (`allowStageSteps`); the
skill and rendered commands always run them, so `disabled` cases apply to core only.

### Stub outputs

Each entry in `stubs:` takes one of five forms.

| form | the agent's output |
|---|---|
| `{ decision: D, score: N, line: L }` (each key optional) | the canonical text below |
| `{ json: <object> }` | the canonical text, with `<object>` as the JSON |
| `{ raw: <text> }` | exactly `<text>` |
| `{ timeout: true }` | nothing: the agent does not return before its timeout |
| `{ hang: true }` | nothing until the run is stopped (with `events:`) |

The canonical text is, byte for byte:

````
Conformance stub output.
Decision: L                      <- only when `line` is given
```json
<JSON.stringify(object)>
```
````

For the shorthand, `object` is `{ "result": { "score": N, "max_score": 100, "decision": D } }`,
with `score` and `max_score` left out when `score` is not given and `decision` left out when
`decision` is not given. So `{ score: 90 }` alone is an agent that scored and gave no
decision anywhere: the absent case.

A stub whose actual output differs from its fixed text makes that case **inconclusive**. It
is re-run, never counted as a pass (§3.7). That rule matters most for the skill, where a
model relays the stub's text.

### Runtimes (`applies_to`)

- `core`: core runs the case as a unit test (P3/P4b), from a copy of these files that
  records the corpus commit it was copied from.
- `skill`: the `pdl-executor` skill on each skill release and orchestrating-model upgrade, run by
  `npm run check:skill-conformance` (`--load` for the load cases through `udl validate`, `--all
  --model <m>` for the cases a model orchestrates).
- `factory`: `validatePDLSemantics` (load-error cases only).

A case limited to `core` is one the skill cannot be put in: a mid-run cancel, a provider
timeout, steps disabled, a NUL byte in a parameter. Where a rule binds the skill only from a
later phase, the case says so in `note` (the vocabulary pre-check: skill from P6b, S1).

## Expected format

```yaml
expected:
  - id: gates/fail-continues
    outcome: ran                  # ran | load_error | load_ok | refused
    stages:
      a:
        status: FAILED            # PASSED | WARNED | FAILED | SKIPPED | ERRORED (§3.1)
        passed: false             # the value of stages.a.passed (§3.4)
        launched: [stub-gate-a]   # agents that started; [] when none did
        agents: { stub-gate-a: negative }
      b:
        status: PASSED
        passed: true
        launched: [stub-gate-b]
        agents: { stub-gate-b: positive }
        upstream:                 # what b received from its dependencies (§3.3, §3.5)
          - { stage: a, agent: stub-gate-a }
    all_gates_passed: false
    run_decision: FAIL            # core's PipelineResult.decision (§3.1); core only
    warnings: []
```

- **Agent class.** Each agent's decision as the gate read it: `positive`, `negative`,
  `conditional`, `neutral`, `absent`, or `errored` (no score and no classifiable decision; no score
  at a threshold gate; an absent decision at a blocking gate (D12); or a condition that evaluated to E). `skipped` for an agent its own condition skipped.
  Where the saved decision is pinned, the value is `{ class: neutral, saved: "SECURE WITH CONDITIONS" }`.
  `saved` is the agent decision a runtime writes to the tracker (§3.2 item 5, D18): the token
  when it classifies; otherwise the value as written, whitespace collapsed, cut to 50
  characters (49 and `…` when longer); `UNKNOWN` when absent.
- **`upstream`.** One entry per agent of each forwarded dependency, `{ stage, agent }`, in
  `depends_on` order. A dependency that produced no output is `{ stage, absent: <reason> }`,
  rendered by core as `### <stage> — no output (<reason>)`. Only the `condition_not_met`
  reason is pinned; a failed stage's reason is its error text, which varies, and is written
  `absent: any`. A FAILED stage whose agents returned output forwards that output (§3.8:
  the reducers read a failed stage 1), so it appears as `{ stage, agent }`. A dependency
  with `forward: none` has no entry. `upstream` is omitted where a case does not test it.
- **`steps`.** `{ <stage>: { <step name>: { status, output } } }` where a case pins step
  results. `status` is core's step status (`passed`, `failed`, `skipped`); `output` is the
  trimmed stdout.
- **`warnings`.** Exhaustive over the codes below: a runtime that emits a listed code the
  case does not expect fails the case. Other log lines are ignored. An entry with
  `runtimes: [core]` binds only those runtimes. A field left out of an entry is not
  asserted.
- **`aborted_records`.** Agents whose ABORTED record must reach submission after a stop
  (§3.1). Core only.
- **`run_decision`.** FAIL when `all_gates_passed` is false; otherwise WARN when any stage is
  WARNED or is ERRORED behind a `warn` gate (D19); otherwise PASS.
- **Omitted keys.** A top-level key the case leaves out (`run_decision`, say) is not
  asserted. Where that is deliberate, a comment on the case names the open question.
- **`load_error` / `load_ok` / `refused`.** For `outcome: load_error`,
  `load_error: { code, at }` where `at` is `stage:<id>`, `stage:<id>/agent:<ref>`,
  `stage:<id>/step:<name>`, or `param:<name>` for an error in the parameter declarations. `outcome: load_ok` means load validation accepts the pipeline;
  it asserts nothing about a run, and carries `load_warnings`. For
  `outcome: refused` (refused before any stage launches), `refused: { code, ... }`. No
  stage keys appear for either.
- **`pending: <reason>`.** The spec does not yet decide the outcome. The case stays so the
  question cannot be lost, and every runtime skips it until the spec rules and the
  expectation is filled in. The check script prints the pending count.

## Codes

The spec names no warning, refusal or load-error identifiers. These are the fixtures'; P0a
adopts them into the normative spec or renames them here in the same change.

**Warnings**

| code | fields | rule |
|---|---|---|
| `NEUTRAL_DECISION` | `agent`, `value` | §3.2 item 5: a neutral decision; the score decides. `value` is the saved form (D18) |
| `ABSENT_DECISION` | `agent` | §3.2 item 5: nothing at either JSON path and no `Decision:` line. At a blocking gate the agent is unjudgeable (D12); elsewhere it is handled as neutral |
| `DECISION_CONFLICT` | `agent`, `json`, `line` | §3.2 item 2: both classify and disagree; JSON wins |
| `FALLBACK_DECISION_SOURCE` | `agent`, `source` | §3.2 item 1: core found a decision only outside the two named paths; gated as absent |
| `CONDITIONAL_ACCEPTED` | `stage`, `agent` | gate-decision D2: a blocking gate passed a CONDITIONAL; `all_gates_passed` is false |
| `FALLBACK_SCORE_SOURCE` | `agent`, `source` | §3.2 item 1 (D16): core found a score only outside the three named paths; counts as no score |
| `SCORE_INVALID` | `agent`, `value` | §3.2 item 1 (D16): a score at a named path that is not a number from 0 to 100; counts as no score |
| `STAGE_ERRORED` | `stage`, `reason` | §3.1 (D19): every ERRORED stage, whatever its gate. `reason` is `agent_unjudgeable` (no score and no classifiable decision, no score at a threshold gate, or an absent decision at a blocking gate; a timeout included), `condition_error` (a condition evaluated to E) or `stopped` (in flight at a cancel, deadline or credit stop) |
| `SKIP_DEPRECATED` | `stage` | §3.2 failure modes: `on_failure: skip` loads as `fail` (load warning) |

**Refusals** (before any stage launches)

| code | fields | rule |
|---|---|---|
| `VOCABULARY_MISSING` | `agents` | §3.2 item 6 (D9) |
| `STEP_OUTPUT_STEPS_DISABLED` | `stages` | §3.4, "Step output must exist" |
| `PARAM_NUL` | `param` | §3.4 D15 |

**Load errors**

| code | rule (§3.4 unless noted) |
|---|---|
| `unknown_root` | a condition path outside `params`, `stages` |
| `unknown_path` | a known root with a path the context does not define (`stages.a.score`) |
| `undeclared_parameter` | `params.x` with no declared `x` |
| `unknown_stage` | `stages.x` with no stage `x` |
| `non_ancestor_reference` | `stages.x` where `x` is not reachable through `depends_on` |
| `undeclared_step` | `steps['n']` with no step `n` in that stage |
| `condition_syntax` | unparseable; ordering operators; number and boolean literals; `!` directly before an unparenthesised comparison |
| `condition_too_long` | over 512 characters |
| `forward_reference` | `depends_on` names a stage declared later (§3.3) |
| `duplicate_stage_id` | two stages share an id; reported at the second (PDL 1.6.0 spec, Codes) |
| `missing_threshold` | per-agent mode, an agent with no threshold and no `gate.threshold` (§3.2) |
| `aggregate_with_per_agent` | `aggregate` on a gate in per-agent mode (§3.2) |
| `unknown_key` | an undeclared key on `gate`, `stage` or `agentRef` (§3.6) |
| `template_placement` | a step template outside the two allowed placements (§3.4 D15) |
| `parameter_env_collision` | two declared parameters map to the same `ULU_P_<NAME>` variable (§3.4 D15, D20) |

## Questions found while writing the fixtures

Writing an outcome down for every case surfaced places where v0.6.0 decided none. Alex ruled
seven on 2026-10-25, and spec v0.7.0 folds them in (D1 revised, D16–D19). He ruled the other
four the same day, and spec v0.8.0 folds them in (D20–D24). A twelfth surfaced while the
normative spec was written (P0a), and Alex ruled it on 2026-10-26 (Q12). Every question is now
ruled, and every ruling but Q10's has a case (Q10 is a sentence in §3.4; the corpus has no
`working_dir`).

| # | question | ruling (2026-10-25 unless dated) | fixture cases |
|---|---|---|---|
| Q1 | What is saved for `SECURE WITH CONDITIONS` and similar values, where the first letter-run is a vocabulary token the follower rule neutralises? | Still neutral. The saved decision is the value as written, whitespace collapsed, cut to 50 characters with `…` (D18). No synthetic token, no regex, and no rule reading `WITH CONDITIONS` as conditional | `decisions/token-*`, `real-docs-validator-unfilled` |
| Q2 | An abort with an independent stage in flight: §3.1, §3.2 and §3.3 disagreed | An abort skips only the aborting stage's transitive dependents. Every other stage launches, and stages already running finish and are judged (D1, revised). Cancel, deadline and credit stops still abort in-flight agents | `run-control/abort-*`, `gates/abort-skips-dependent` |
| Q3 | Does an ERRORED stage behind `warn` make the run decision WARN? | Yes, and every ERRORED stage is surfaced with its stage and reason (`STAGE_ERRORED`, D19) | every ERRORED case |
| Q4 | Which failure mode governs a FAILED stage that has no gate? | `fail`: the run continues (D19). **Revised by D43 (Alex 2026-10-27): `warn`, with the `not_negative` key; the stage WARNs, never fails the run** | `gates/steps-only-hard-failure-no-gate` |
| Q5 | Do core's `OutputNormalizer` synonyms gate? | No. One canonical table: the 13-term register plus the agent's declared vocabulary; a synonym reads neutral (D17) | `decisions/synonym-*`, `register-token-classifies` |
| Q7 | Where is the score read? | `result.score`, then a top-level `score`, then a `Score:` line; a number from 0 to 100 or a string of digits; anything else, or a score only outside those paths, is no score (D16) | `decisions/score-*` |
| Q9 | Does an absent decision warn? | Yes, as `ABSENT_DECISION`, a code apart from the neutral warning: absent is an extraction failure (D23) | `decisions/absent-*`, `path-*-fallback-only` |
| Q6 | D15 maps `a-b` and `a_b` to the same `ULU_P_A_B`. Refuse the collision at load? | Yes, as `parameter_env_collision`, whether or not either name is used (D20) | `load-errors/param-env-collision` |
| Q8 | An agentRef condition cannot read its own stage's steps. Intended? | Yes; keep the rule. Corpus conditions read preflight stages only, and allowing it later breaks nothing (D21) | `load-errors/non-ancestor-own-steps-from-agentref` |
| Q10 | A step's `working_dir` with a file target? | It resolves against the step's working directory: the target, or the target's parent for a file target. Stated in §3.4; zero corpus uses, so no case (D22) | — |
| Q11 | At a gate with a threshold, an agent with a classifiable decision and no score? | ERRORED: it cannot be judged against the threshold. At a decision-only gate the decision suffices (D24) | `decisions/classifiable-without-score-*` |
| Q12 | `!params.a == 'x'`: core reads `!(params.a == 'x')`, the v0.8.1 sentence "`!` applies to the primary" reads `(!params.a) == 'x'`, and the case written for it could not tell them apart (both false at `a = x`). Found at P0a | A load error, `condition_syntax`: `!` precedes only a path or a parenthesised expression (Alex, 2026-10-26). Zero of 97 corpus and fixture conditions used the form | `load-errors/syntax-negated-comparison` |
