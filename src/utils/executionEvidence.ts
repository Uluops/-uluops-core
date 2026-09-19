import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineResult } from '../types/pipeline.js';

/**
 * The slice of a result this check reads. Structural rather than `ExecutionResult` because
 * SubmissionClient's `submission.result` is `ExecutionResult | AgentResult`, and an
 * AgentResult (type 'agent') is a single agent that by construction executed — it falls
 * through to false below without needing its own branch.
 */
export interface ExecutionEvidenceSource {
  type: string;
  metrics?: object;
}

/**
 * True only on POSITIVE evidence that nothing executed — never inferred from a score.
 *
 * A result that genuinely ran and scored 0 must return false here; that is a real result,
 * not an absence. The evidence is the executor's own execution count
 * (`WorkflowResult.metrics.phasesExecuted`, `PipelineResult.metrics.stagesExecuted`), which
 * is tallied from phase/stage status, not from any score — see
 * WorkflowExecutor's metrics reducer and PipelineExecutor.computeStageMetrics.
 *
 * Why this exists as a shared helper (score-aggregation-semantics spec v0.2.0, 2026-09-19):
 * aggregateScores' empty-input branch deliberately returns 0 when nothing ran, so that a
 * gated pipeline stage over an all-skipped workflow BLOCKS instead of fail-opening on null
 * (the 2026-08-24 fix). That 0 is safe only where something can independently confirm
 * "nothing ran" without trusting the number. PipelineExecutor.gateFailed does that via this
 * check — but only when a gate is declared. A standalone workflow, or an ungated stage,
 * carries the same 0 all the way to SubmissionClient, which used to submit it as
 * `averageScore: 0` — a fabricated score indistinguishable from a genuine failing run
 * (tracker issues 748fcc02, 1082d5fb). Same check, applied at the submission boundary.
 *
 * Mirrors the reasoning in aggregateScores.ts's empty-input branch, applied at the RESULT
 * level instead of the item-array level.
 *
 * The `pipeline` branch is live, not symmetry: an all-skipped pipeline already aggregates
 * to `null` (every skipped stage is pushed into stageResults with a null score, so the
 * array is non-empty), but a pipeline with NO stage results at all — a programmatic
 * `stages: []`, which the PDL schema's `minItems: 1` forbids but core does not
 * independently enforce, or a `status()` read before any stage completes — hits the
 * empty-input branch and gets the same fabricated 0 with `stagesExecuted === 0` beside it.
 */
export function verifiedNothingExecuted(result: ExecutionEvidenceSource | undefined): boolean {
  if (!result) return false;
  // `metrics` is required on both result types, but results also arrive from the wire and
  // from older fixtures; a missing metrics block is absence of evidence, which is not
  // evidence here — fall through to false.
  if (result.type === 'workflow') {
    return (result as WorkflowResult).metrics?.phasesExecuted === 0;
  }
  if (result.type === 'pipeline') {
    return (result as PipelineResult).metrics?.stagesExecuted === 0;
  }
  return false;
}
