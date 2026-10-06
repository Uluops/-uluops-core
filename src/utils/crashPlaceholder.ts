import type { AgentResult } from '../types/agent.js';
import type { AgentType } from '../types/execution.js';
import { crashMetrics } from './crashMetrics.js';

/**
 * The single construction for "an agent was dispatched and did not come back".
 *
 * ONE factory, and the count is the point. `CommandExecutor` carried a private
 * `crashPlaceholder` whose own docstring said *"two call sites that must agree are two
 * chances to disagree"* — and there were THREE. The third, in
 * `PipelineExecutor.executeInlineAgents`, had drifted on every field that classifies the
 * event:
 *
 *   | field             | shared factory      | the third site        |
 *   |-------------------|---------------------|-----------------------|
 *   | decisionCategory  | 'negative'          | ABSENT                |
 *   | priority          | 'critical'          | ABSENT                |
 *   | severity          | 'critical'          | 'high'                |
 *   | failureCode       | PRA-FRA/C           | PRA-FRA/H             |
 *
 * An absent `decisionCategory` works only through `classifyDecision`'s 'FAIL' fallback,
 * which is the path that cannot recognise a custom vocabulary; and the same crash reached
 * the tracker at two different severities depending on which executor dispatched it. The
 * fix that unified the first two sites cited them and did not search for a third — the
 * defect-is-a-class lesson, missed inside the commit that applied it.
 *
 * `agentType` is a FALLBACK, not a measurement, and the fallback is a FABRICATION — stated
 * plainly because this factory gets `score`, `maxScore` and `costUsd` right by refusing to
 * invent them, and then invents this one. `AgentResult.agentType` is non-nullable, so the
 * type forces a value; that is the reason, not a justification. Every crash whose type was
 * never resolved is attributed to `validator` in tracker analytics bucketed by agent type.
 *
 * NO PRODUCTION CALLER SUPPLIES IT TODAY. All three sites pass only `startedAt`, because a
 * crash can predate resolution and none of them holds the resolved type at the point the
 * placeholder is built. An earlier draft of this comment said "callers that do know it pass
 * it", which described behaviour no code performed — a hand-maintained claim sitting beside
 * the state it describes, which is this release's own subject. The parameter exists so the
 * fabrication has ONE site instead of three, and so a caller that gains access to the real
 * type can supply it without touching this file.
 */
/**
 * The version every crash placeholder carries — deliberately non-parseable as a
 * real release. It is the POSITIVE crash marker: `CommandExecutor.assertNotAllCrashed`
 * discriminates on it rather than on the `score === null && decisionCategory ===
 * 'negative'` value shape, which a genuinely scoreless explorer/generator panel
 * reporting a negative decision produces legitimately (ship run #94).
 */
export const CRASH_PLACEHOLDER_VERSION = '1.0.0-synthesized';

export function crashPlaceholder(
  ref: string,
  reason: unknown,
  opts?: { startedAt?: number; agentType?: AgentType },
): AgentResult {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const metrics = crashMetrics(
    reason,
    opts?.startedAt !== undefined ? { durationMs: Date.now() - opts.startedAt } : undefined,
  );

  return {
    type: 'agent',
    name: ref,
    // No definition backs a crash placeholder. '1.0.0-synthesized' is deliberately
    // non-parseable as a real release, matching every other synthesized result in this
    // package, so a consumer can tell it apart from an actual 1.0.0 rather than reading an
    // invented version as real definition identity.
    version: CRASH_PLACEHOLDER_VERSION,
    definitionHash: '',
    agentType: opts?.agentType ?? 'validator',
    decision: 'FAIL',
    // Stamped explicitly. Without it the result is classified only by classifyDecision's
    // 'FAIL' fallback, which is the path that cannot recognise a custom vocabulary.
    decisionCategory: 'negative',
    // Crashed agent — no agent ran, so no score. Null pair, not a fabricated 0/100.
    score: null,
    maxScore: null,
    recommendations: [{
      title: `Agent ${ref} failed: ${msg}`,
      priority: 'critical',
      severity: 'critical',
      failureCode: 'PRA-FRA/C',
    }],
    // Reads real usage off the error when it carries any (MaxStepsExhaustedError is thrown
    // after a successful, already-billed call); otherwise zero tokens with costUsd ABSENT,
    // never a fabricated $0. Elapsed time is knowable even when tokens are not.
    durationMs: metrics.durationMs,
    metrics,
  };
}

/**
 * The decision an agent stopped by a run stop carries (aborted-agent-recording spec, OD-1).
 *
 * Cause-neutral — it covers a user `cancel()`, a provider-credit trip and a consumer
 * `abortSignal` alike — and outside the core decision register, so every classifier reads it
 * `neutral`. Not `CANCELLED` (the pipeline-level word for a user stop; a credit-stopped run is
 * `failed`), not `SKIPPED` (never started, and hides possible spend), not `FAIL` (the agent did
 * nothing wrong — the whole point).
 */
export const ABORTED_DECISION = 'ABORTED';

/**
 * The record for "this agent was dispatched and the run was stopped before it finished".
 *
 * The twin of {@link crashPlaceholder}, in the same file so the count of synthesized shapes stays
 * visible in one place. Every field that is not about the abort is the crash factory's, for the
 * crash factory's reasons — including the `agentType` fabrication documented above. What differs:
 *
 * - `decision` `ABORTED`, `decisionCategory` `neutral`: no verdict, not a failure.
 * - **No recommendation**, so no tracker issue. Three innocent siblings of a 402 used to file
 *   three critical "Agent X failed: Execution was cancelled by the caller" issues, recurring on
 *   every stopped run and teaching the reader to bulk-dismiss the title shape real crashes share.
 * - `summary` is cause-free on purpose: the cause is stated once, on the run (`PipelineResult.status`
 *   for a cancel; the `PipelineError` message and the originator's own crash record for a 402).
 * - A `critical` `execution.run-stopped` marker and `completeness: 'failed'` (OD-6): a coverage
 *   reduction always emits a marker, and an absent completeness reads "complete".
 * - Metrics as a crash with no billed usage: `costBasis: 'unpriced'`, `costUsd` absent. The spend of
 *   a request aborted mid-stream is unknown, not zero (deferred 2db41524).
 *
 * Only {@link isRunStopAbort}-matched rejections reach this factory; everything else is a crash.
 */
export function abortedPlaceholder(
  ref: string,
  reason: unknown,
  opts?: { startedAt?: number; agentType?: AgentType },
): AgentResult {
  const metrics = crashMetrics(
    reason,
    opts?.startedAt !== undefined ? { durationMs: Date.now() - opts.startedAt } : undefined,
  );
  return {
    type: 'agent',
    name: ref,
    version: CRASH_PLACEHOLDER_VERSION,
    definitionHash: '',
    agentType: opts?.agentType ?? 'validator',
    decision: ABORTED_DECISION,
    decisionCategory: 'neutral',
    score: null,
    maxScore: null,
    recommendations: [],
    summary: 'Not completed: the run was stopped before this agent finished.',
    durationMs: metrics.durationMs,
    metrics,
    degradationMarkers: [{ code: 'execution.run-stopped', phase: 'execution', severity: 'critical' }],
    completeness: 'failed',
  };
}

/**
 * True for a record built by {@link abortedPlaceholder}. Keyed on the synthesized version AND the
 * decision, so a real definition that happened to use `ABORTED` as its own vocabulary word (none
 * does today) is never mistaken for a stopped placeholder. Exported so consumers test a predicate
 * rather than string-matching a decision.
 */
export function isAbortedRecord(r: { decision: string; version: string }): boolean {
  return r.decision === ABORTED_DECISION && r.version === CRASH_PLACEHOLDER_VERSION;
}
