/**
 * The run verdict (PDL 1.6.0 §3.1, D13, D19; P4b): `allGatesPassed`, computed once, and the run
 * decision, category and stage metrics derived from it, so the CLI, the tracker and the result
 * cannot disagree.
 *
 * A new module (D29). `PipelineExecutor` calls it when it builds a result, and `SubmissionClient`
 * writes the value it produced (`PipelineResult.allGatesPassed`) as the saved run verdict, in place
 * of `isPositiveDecision` over the old `computeDecision`.
 *
 * Before 1.6.0 the pipeline decision was FAIL when any stage failed or any stage's decision
 * category was negative, whatever its gate said (so a negative behind `warn` failed the run), WARN
 * when any stage's category was conditional, and CANCELLED when a user stop reached a stage. The
 * saved verdict was `decisionCategory === 'positive'` with a 0.7 extraction-confidence floor. A
 * stop now makes the run FAIL; `PipelineResult.status` still says `cancelled`.
 */
import type { PipelineWarning, StageResult } from '../types/pipeline.js';
import { isBlocking } from './stageGate.js';

/**
 * §3.1: false when any of these holds, otherwise true:
 * - a stage ended FAILED;
 * - a stage ended ERRORED behind a blocking gate;
 * - a blocking gate accepted a CONDITIONAL (gate-decision D2);
 * - the run was stopped (cancel, deadline, credit limit) before every stage reached a terminal
 *   status, which `stopReached` says.
 * `executionFailed` is a run whose own execution threw: it did not reach the end of its stages,
 * so nothing it reports can pass.
 */
export function computeAllGatesPassed(
  stages: readonly StageResult[],
  warnings: readonly PipelineWarning[],
  run: { stopReached: boolean; executionFailed: boolean },
): boolean {
  if (run.stopReached || run.executionFailed) return false;
  if (warnings.some(w => w.code === 'CONDITIONAL_ACCEPTED')) return false;
  return !stages.some(s =>
    s.outcome === 'FAILED'
    || (s.outcome === 'ERRORED' && (s.gateMode === undefined || isBlocking(s.gateMode))));
}

/**
 * `PipelineResult.decision` (§3.1): FAIL when `allGatesPassed` is false; WARN when it is true and a
 * stage WARNED or ended ERRORED behind `warn` (D19); otherwise PASS.
 */
export function runDecision(allGatesPassed: boolean, stages: readonly StageResult[]): 'PASS' | 'WARN' | 'FAIL' {
  if (!allGatesPassed) return 'FAIL';
  const warned = stages.some(s => s.outcome === 'WARNED' || (s.outcome === 'ERRORED' && s.gateMode === 'warn'));
  return warned ? 'WARN' : 'PASS';
}

export function runDecisionCategory(decision: 'PASS' | 'WARN' | 'FAIL'): 'positive' | 'conditional' | 'negative' {
  return decision === 'PASS' ? 'positive' : decision === 'WARN' ? 'conditional' : 'negative';
}

/** Stage counts by outcome; the five outcome counts partition the stages. */
export function stageMetrics(stages: readonly StageResult[]) {
  const count = (o: StageResult['outcome']) => stages.filter(s => s.outcome === o).length;
  const stagesSkipped = count('SKIPPED');
  return {
    stagesExecuted: stages.length - stagesSkipped,
    stagesPassed: count('PASSED'),
    stagesFailed: count('FAILED'),
    stagesWarned: count('WARNED'),
    stagesErrored: count('ERRORED'),
    stagesSkipped,
  };
}

/**
 * The `params:` line a pipeline run's raw markdown carries (§3.8, D14): each resolved run parameter,
 * as conditions read it. The tracker's save input has no params field, so the raw markdown is the
 * carrier. Written as one JSON object with sorted keys, so a value holding spaces, `=` or a newline
 * stays one unambiguous line.
 */
export function paramsLine(params: Readonly<Record<string, string | number | boolean>>): string {
  const sorted = Object.fromEntries(Object.keys(params).sort().map(k => [k, params[k]]));
  return `params: ${JSON.stringify(sorted)}`;
}
