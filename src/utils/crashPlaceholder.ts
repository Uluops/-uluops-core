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
 * `agentType` is a FALLBACK, not a measurement. A crash can predate resolution, so the real
 * type is often unknowable here; callers that do know it pass it. That is why it is a
 * parameter with a default rather than a hardcoded literal at three sites.
 */
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
    version: '1.0.0-synthesized',
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
