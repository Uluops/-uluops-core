/**
 * "Crash decides" — the ONE rule every container applies once a run stop has reached anything
 * inside it (aborted-agent-recording OD-12, Alex 2026-10-05, after four review rounds patched the
 * previous precedence one case at a time).
 *
 *   A stopped container gives no quality verdict: it is negative (FAIL / FAILED / blocked / BLOCK)
 *   if anything inside really CRASHED — a caller deadline's agents count as crashes (OD-9) — and
 *   otherwise ABORTED / neutral. Score thresholds, lens caps and warn postures do not apply to
 *   it: they judge finished work, and a stopped panel is not finished.
 *
 *   Bounded by "finished keeps verdict" (OD-14, Alex 2026-10-06): the rule judges only the parts a
 *   stop REACHED. A workflow phase or pipeline stage that finished before the stop keeps its own
 *   verdict, so a stopped workflow is negative if a stopped phase crashed OR a finished phase is
 *   blocked (WorkflowExecutor.aggregate), exactly as a pipeline treats finished stages. A command's
 *   panel is one unit: a stop that reached any agent reached the panel.
 *
 * Containers are told what happened inside by core-stamped degradation markers, never by decision
 * strings (a model may print "ABORTED" or "FAIL" for any reason):
 *   - RUN_STOPPED_CODE     — an aborted placeholder, or a container this rule wrote ABORTED.
 *   - RUN_STOPPED_PARTIAL  — a container this rule wrote negative: a stop AND a crash were inside.
 *   - DEADLINE_CODE        — a crash placeholder produced by a caller deadline.
 *   - CHILD_CRASHED_CODE   — any container with a real crash inside, stopped or not, so a parent
 *                            can tell a crash-derived FAIL from a score-derived one.
 */
import { isAbortedRecord, CRASH_PLACEHOLDER_VERSION, RUN_STOPPED_CODE, RUN_STOPPED_PARTIAL_CODE } from './crashPlaceholder.js';
import type { DegradationMarker } from '../types/degradation.js';

export const DEADLINE_CODE = 'execution.deadline';
export const CHILD_CRASHED_CODE = 'execution.child-crashed';

type Marked = { decision: string; version: string; degradationMarkers?: ReadonlyArray<{ code: string }> };

const has = (r: Marked, code: string) => r.degradationMarkers?.some(m => m.code === code) ?? false;

/** A synthesized crash record (not an aborted one): a crashed agent or step, incl. a deadline. */
export function isCrashRecord(r: Marked): boolean {
  return r.version === CRASH_PLACEHOLDER_VERSION && !isAbortedRecord(r);
}

/** A run stop — explicit or a deadline — reached this result or something inside it. */
export function stopReached(r: Marked): boolean {
  return isAbortedRecord(r) || has(r, RUN_STOPPED_CODE) || has(r, RUN_STOPPED_PARTIAL_CODE) || has(r, DEADLINE_CODE);
}

/** Something in or under this result really crashed. */
export function crashInside(r: Marked): boolean {
  return isCrashRecord(r) || has(r, CHILD_CRASHED_CODE) || has(r, RUN_STOPPED_PARTIAL_CODE);
}

/**
 * The verdict the rule imposes on a container of `children`, or `undefined` when no stop reached
 * any of them (then the container's own rules apply unchanged). `extraStop` / `extraCrash` let a
 * caller add facts the children do not carry (a workflow's phases that a stop kept from starting).
 */
export function stopVerdict(children: Marked[], extra?: { stop?: boolean; crash?: boolean }): 'negative' | 'aborted' | undefined {
  if (!(extra?.stop || children.some(stopReached))) return undefined;
  return extra?.crash || children.some(crashInside) ? 'negative' : 'aborted';
}

export function marker(code: string, severity: DegradationMarker['severity'] = 'degraded'): DegradationMarker {
  return { code, phase: 'execution', severity };
}

/** The markers a container carries for what happened inside it. */
export function containerMarkers(verdict: 'negative' | 'aborted' | undefined, crashed: boolean): DegradationMarker[] | undefined {
  const out: DegradationMarker[] = [];
  if (verdict === 'aborted') out.push(marker(RUN_STOPPED_CODE, 'critical'));
  if (verdict === 'negative') out.push(marker(RUN_STOPPED_PARTIAL_CODE));
  if (crashed) out.push(marker(CHILD_CRASHED_CODE));
  return out.length > 0 ? out : undefined;
}
