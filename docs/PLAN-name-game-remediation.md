# Name-Game Remediation: @uluops/core Top 5

## Context

The name-game pipeline (6 agents, 3 stages) found 15 naming issues in `@uluops/core`. The Confucius Forecaster's earlier prediction about systemic `validator` naming drift is confirmed — the field exists in core's `Recommendation` interface while the SDK, database, and MCP server have already migrated to `agent`. The pipeline also found a latent bug in `computeDecision()` where exclusion vs inclusion logic will diverge on new decision values, and identified that domain error classes lack error codes needed for the thin-client serialization boundary.

**Source:** name-game pipeline run #1, 2026-04-15
**Tracker:** `packages/-uluops-core`, workflow `name-game`, 15 issues (4 critical, 7 suggested, 4 backlog)
**Agent scores:** chain-tracer 100, confucius 66 (DISORDERED), wittgenstein 78 (CLEAR), negative-space 82 (INTENTIONAL), interference 82 (INTERFERING), synthesis 86 (INTEGRATED)

**Pre-implementation review:** run #2, 2026-04-15 — architect 82 (PROCEED), docs 73 (PARTIALLY_DOCUMENTED), synthesis 82 (INTEGRATED). Key revisions applied below.

---

## Phases

### Phase 1: Decision Classification Helper
**Fix:** `computeDecision()` asymmetric logic (latent bug)
**Issues:** SEM-INC/H (wittgenstein CGC-1), SEM-AMB/H (confucius N1)

Create `src/executor/classifyDecision.ts`:
```typescript
export type DecisionCategory = 'positive' | 'negative' | 'conditional' | 'neutral';

export function classifyDecision(decision: string | undefined): DecisionCategory {
  if (!decision) return 'neutral';
  switch (decision) {
    case 'PASS': case 'SHIP': case 'COMPLETE': return 'positive';
    case 'FAIL': case 'FAILED': case 'BLOCK': case 'PARTIAL': return 'negative';
    case 'WARN': case 'HOLD': return 'conditional';
    default: return 'neutral';
  }
}
```

> **Pre-impl fix:** Added `PARTIAL` to `negative` category. `PARTIAL` is actively used by `ExecutorAgentResult` and propagated by `CommandExecutor.ts:232`. Without it, stages returning `PARTIAL` would silently vanish from both passed and failed counts — introducing a new gap while fixing the old one.

Refactor `PipelineExecutor.ts:289-320`:
- `stagesPassed` → `classifyDecision(d) === 'positive'`
- `stagesFailed` → `classifyDecision(d) === 'negative'`
- Add `stagesWarned` → `classifyDecision(d) === 'conditional'`
- `computeDecision()` uses same helper internally

Add `stagesWarned?: number` to `PipelineMetrics` in `types/pipeline.ts`.

**Files:**
- NEW: `src/executor/classifyDecision.ts`
- MODIFY: `src/executor/PipelineExecutor.ts`
- MODIFY: `src/types/pipeline.ts`
- MODIFY: `src/index.ts` (export)
- MODIFY: `README.md` (add `classifyDecision`, `DecisionCategory` to TypeScript Support section)
- NEW: `test/executor/classifyDecision.test.ts`

**Commit:** `feat(core): add classifyDecision helper and fix pipeline counting asymmetry`

---

### Phase 2: Error Codes on Domain Errors
**Fix:** Add machine-readable codes for thin-client serialization
**Issues:** PRA-FRA/H (negative-space S3), PRA-ALI/M (confucius PipelineError under-formality)

Add to `src/errors/UluOpsError.ts`:
```typescript
export const UluOpsErrorCodes = {
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  PREFLIGHT_ERROR: 'PREFLIGHT_ERROR',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  CAPABILITY_ERROR: 'CAPABILITY_ERROR',
  WORKFLOW_ERROR: 'WORKFLOW_ERROR',
  PIPELINE_ERROR: 'PIPELINE_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;
```

> **Pre-impl fix:** Use `readonly` class property pattern instead of threading `code` through the constructor chain. This avoids changing `UluOpsError`'s constructor signature `(message, options?: ErrorOptions)` which would break `ExecutionError`'s existing `super(message, options)` call. Each subclass declares its own `readonly code`:

```typescript
// Base class — NO constructor change needed
export class UluOpsError extends Error {
  readonly code: string = 'UNKNOWN_ERROR';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UluOpsError';
  }
}

// Each subclass overrides the property
export class PipelineError extends UluOpsError {
  readonly code = 'PIPELINE_ERROR' as const;
  constructor(
    message: string,
    public readonly context?: { stageName?: string; stageIndex?: number },
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
```

Keep `ValidationError.code` typed as `ValidationErrorCode` (narrower type, compatible — it already declares `code` as a class property).

> **Serialization note:** The `code` property serializes naturally via `JSON.stringify()` or structured clone. `@uluops/client` will consume these codes when the thin-client error handler maps API error responses to typed SDK errors. The wire format is `{ error: { message, code, ... } }` matching the existing API error handler in `ops-uluops-api/src/middleware/error-handler.ts`. No `@uluops/client` changes needed in this phase — it will read codes from the API response shape that already exists.

**Files:**
- MODIFY: `src/errors/UluOpsError.ts`
- MODIFY: `src/errors/index.ts`
- MODIFY: `src/index.ts` (export `UluOpsErrorCodes`, `UluOpsErrorCode`)
- MODIFY: `README.md` (add `UluOpsErrorCodes` alongside existing `ValidationErrorCodes` reference)
- MODIFY or NEW: `test/errors/errors.test.ts`

**Commit:** `feat(core): add error codes to UluOpsError hierarchy`

---

### Phase 3: Recommendation.validator → agent (cross-repo, BREAKING)
**Fix:** Complete the migration the Confucius Forecaster predicted. Full teardown — no backward compatibility.
**Issues:** SEM-COM/H (confucius N4)

**Strategy:** Breaking rename. Remove `validator` field entirely, replace with `agent`. The SDK, database (migrations 020/021/034), and MCP server already use `agent`. Core and RAH are the last holdouts.

**@uluops/core changes:**
- `types/execution.ts:195-197` — Rename `validator?: string` to `agent?: string`, update JSDoc
- `classifiedBy` — Change `'validator'` to `'agent'` in the union: `'agent' | 'classifier' | 'human'`
- `AgentExecutor.ts:382` — Change `validator: agentName` to `agent: agentName`
- `ValidationClient.ts:157` — Currently outputs `agent: r.validator ?? 'unknown'` and `validator: r.validator ?? 'unknown'`. Change to `agent: r.agent ?? 'unknown'`, remove `validator` line
- Test fixtures — rename `validator` to `agent` everywhere

> **Pre-impl fix:** ValidationClient.ts:157 already partially migrated — it outputs an `agent` field but reads from `r.validator`. After renaming the Recommendation field, it becomes simply `agent: r.agent ?? 'unknown'`.

**@uluops/rah-service changes:**
- `types.ts` — Rename `validator` to `agent` on `TrackerIssue` and `TrackerRunRecommendation`. Rename `TrackerValidatorSnapshot` → `TrackerAgentSnapshot`. Rename `ValidatorPerformance` → `AgentPerformance`. Rename `TrackerRun.validatorScores` → `agentScores`. Rename `TrackerRunDetail.validators` → `agents`. No aliases, no backward compat.
- `mappers.ts:48` — Change `validator: i.agent` to `agent: i.agent`. Rename `mapValidatorSnapshot` → `mapAgentSnapshot`. Rename `mapValidatorPerformance` → `mapAgentPerformance`.
- All test files — full search-and-replace of `validator` field references and type names
- All analyzer/stratification/enrichment files that reference `validator` field on internal types

**@uluops/ops-sdk changes:**
- `src/types/enums.ts:127` — Rename `ClassifiedBy.Validator: 'validator'` to `ClassifiedBy.Agent: 'agent'`. Migration 034 already renamed the DB enum values; the SDK enum is stale.

**Files (core):**
- MODIFY: `src/types/execution.ts`
- MODIFY: `src/executor/AgentExecutor.ts`
- MODIFY: `src/validation/ValidationClient.ts`
- MODIFY: `test/executor/fixtures.ts`
- MODIFY: `test/executor/AgentExecutor.test.ts`
- MODIFY: `test/executor/WorkflowExecutor.test.ts`
- MODIFY: `test/validation/ValidationClient.test.ts`

**Files (RAH) — separate commit, separate repo:**
- MODIFY: `src/types.ts`
- MODIFY: `src/data/mappers.ts`
- MODIFY: `tests/unit/data/mappers.test.ts`
- MODIFY: All test fixtures referencing `validator` field or old type names

**Files (ops-sdk) — separate commit, separate repo:**
- MODIFY: `src/types/enums.ts`

**Commits (three separate repos):**
1. `refactor(core)!: rename Recommendation.validator to agent — breaking change`
2. `refactor(sdk)!: rename ClassifiedBy.Validator to Agent — align with DB migration 034`
3. `refactor(rah)!: complete validator→agent rename in internal types`

Core and SDK ship first (independent). RAH depends on ops-sdk, so RAH ships after SDK.

---

### Phase 4: Documentation (zero code risk)
**Issues:** SEM-NOM/H (interference I2), SEM-AMB/H (confucius N1, synthesis D-1)

**AgentDefinition mixed casing** — Add comment to `types/agent.ts` explaining the convention era boundary. New fields MUST use camelCase. Existing snake_case locked by ADL schema.

**Decision vocabulary ADR** — Create `docs/adr/adr-001-decision-vocabulary.md` documenting:
- Four-register system is intentional (each layer has its own vocabulary)
- `classifyDecision()` is the canonical normalization (from Phase 1)
- New decision values MUST be registered in `classifyDecision`
- Resolves the interpretive divergence: Confucius (disorder), Wittgenstein (language-games), Negative-Space (intentional) — answer: registers are intentional, the collapse mechanism is now formalized

> **Pre-impl fix:** Cross-reference the existing SCOPE.md "Decision vocabulary fragmentation" tension entry. The ADR supplements SCOPE.md with implementation detail; update SCOPE.md entry to reference the ADR.

**Files:**
- MODIFY: `src/types/agent.ts` (comment only)
- NEW: `docs/adr/adr-001-decision-vocabulary.md` (mkdir `docs/adr/` first)
- MODIFY: `SCOPE.md` (add ADR cross-reference to decision vocabulary tension entry)
- MODIFY: `CHANGELOG.md` (add [Unreleased] section covering all 4 phases)

**Commit:** `docs(core): document ADL casing convention and decision vocabulary ADR`

---

## Execution Order

| Phase | Risk | Repos | Build Impact |
|-------|------|-------|-------------|
| 1 | Low | core | core only |
| 2 | Low | core | core only |
| 3 | Medium | core + RAH (separate commits) | independent builds |
| 4 | None | core | none |

Build order: core has no `file:` dep on RAH. RAH depends on ops-sdk (which already uses `agent`). Phases 1-2 can ship independently. Phase 3 is two separate commits in two separate repos — core first, RAH second.

## Verification

After each phase:
1. `cd packages/-uluops-core && npm run build && npm test`
2. Phase 3 also: `cd packages/-uluops-rah-service && npm run build && npm test`
3. Spot-check: run a pipeline and verify `stagesWarned` appears in metrics
4. Spot-check: catch a `PipelineError` and verify `.code === 'PIPELINE_ERROR'`
5. Spot-check: inspect `Recommendation` output and verify `agent` field is populated and no `validator` field exists
