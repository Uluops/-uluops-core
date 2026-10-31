/**
 * Stage gates (PDL 1.6.0 §3.2, P4b): the failure mode, the decision key, score mode, and the
 * judgement that turns a stage's agents into PASSED, WARNED or FAILED.
 *
 * A new module (D29): `PipelineExecutor` gains only the calls. What reaches a gate is already read:
 * each agent's decision class and contract score come from `agentVerdict.ts` (P4a), and the
 * unjudgeable rule (D24) is applied by the caller before the gate, so an ERRORED stage never
 * reaches `judgeGate`.
 *
 * Before 1.6.0 the gate failed on any negative decision whatever its mode, read `fail` as
 * continue (it was not in the type), aggregated scores only, and passed a threshold it could not
 * evaluate (fail-open). Per-agent thresholds, the decision key and CONDITIONAL_ACCEPTED are new.
 */
import type { GateDefinition, GateMode, StageDefinition } from '../types/pipeline.js';
import type { DecisionClass } from '../types/agent.js';
import { finiteNonNegative } from '../utils/externalValue.js';

/** Gate-decision D1: how a gate compares each agent's decision class. */
export type DecisionKey = 'not_negative' | 'positive' | 'ignore';

/**
 * The failure mode (§3.2, failure modes; D1, D43): `on_failure`, with `skip` read as `fail`
 * (deprecated; load warns `SKIP_DEPRECATED`) and an absent `on_failure` as `abort`. A stage with no
 * gate takes the `warn` failure mode: it never fails the run, and a failure there is WARNED (D43,
 * Alex 2026-10-27, revising D19's "behaves as `fail`"). Its decision key is not `warn`'s, though:
 * `decisionKey` gives it `not_negative`, so a negative is WARNED, where an explicit `warn` gate
 * defaults to `ignore` and passes it.
 *
 * Any value outside the enum reads as `abort`, the most blocking mode. Authored YAML reaches here
 * type-erased, and before 1.6.0 an unknown value fell through every branch and continued: a typo in
 * a hard gate made it advisory.
 */
export function gateMode(gate: GateDefinition | undefined): GateMode {
  if (!gate) return 'warn';
  switch (gate.on_failure) {
    case 'warn': return 'warn';
    case 'fail':
    case 'skip': return 'fail';
    default: return 'abort';
  }
}

/** `abort` and `fail` are blocking (§3.1, blocking class); `warn` is not. */
export function isBlocking(mode: GateMode): boolean {
  return mode !== 'warn';
}

/**
 * The decision key: as authored, else `not_negative` on a blocking gate and `ignore` on `warn` (D3).
 * A stage with no gate reads `not_negative` (D43): a negative there is WARNED rather than passed
 * without a trace. It cannot accept a CONDITIONAL, since it is not blocking.
 */
export function decisionKey(gate: GateDefinition | undefined, mode: GateMode): DecisionKey {
  if (!gate) return 'not_negative';
  const key = gate.decision;
  if (key === 'not_negative' || key === 'positive' || key === 'ignore') return key;
  return isBlocking(mode) ? 'not_negative' : 'ignore';
}

/** Whether the gate is in per-agent mode: some agentRef in the stage declares `threshold` (D5). */
export function isPerAgentMode(stage: StageDefinition): boolean {
  return (stage.agents ?? []).some(a => a.threshold !== undefined);
}

/** Whether the gate compares scores at all: per-agent mode, or a `gate.threshold` (D24 reads this). */
export function gateHasThreshold(stage: StageDefinition): boolean {
  return stage.gate?.threshold !== undefined || isPerAgentMode(stage);
}

/** One judged member of a stage: an inline agent, or the single result of a ref stage. */
export interface GatedMember {
  name: string;
  class: DecisionClass;
  /** The contract score; null when there is none. */
  score: number | null;
  /** The member's own threshold (per-agent mode). */
  threshold?: number;
}

export interface GateJudgement {
  failed: boolean;
  /** Members a passing blocking gate accepted as CONDITIONAL (gate-decision D2). */
  conditionalAccepted: string[];
  /** Why the gate failed, one line per cause, for the log. Empty when it passed. */
  causes: string[];
}

/**
 * Judge a gate over its members.
 *
 * **Score.** Per-agent mode: each member must reach its own threshold, else `gate.threshold`. Aggregate
 * mode: `aggregate(scores) >= gate.threshold` (default `min`). No threshold: decision-only.
 * A threshold that is not a usable number fails the gate (fail-closed; ship run #94). A member with
 * no score is not compared: for agents the D24 rule has already made such a stage ERRORED, so this
 * is reached only by ref and steps stages, whose missing score stays fail-open as before 1.6.0.
 *
 * **Decision.** `positive`: a negative or a conditional fails. `not_negative`: a negative fails; a
 * conditional passes, and a passing blocking gate reports it as accepted. `ignore`: not compared.
 * Neutral and absent never fail here; the score decides (§3.2 item 5). An absent decision at a
 * blocking gate never reaches this function: D12 has made its stage ERRORED (`unjudgeableCause`).
 */
export function judgeGate(
  gate: GateDefinition | undefined,
  members: readonly GatedMember[],
  perAgent: boolean,
): GateJudgement {
  const mode = gateMode(gate);
  const key = decisionKey(gate, mode);
  const causes: string[] = [];
  const conditional: string[] = [];

  for (const m of members) {
    if (m.class === 'negative' && key !== 'ignore') causes.push(`"${m.name}" decided negative`);
    else if (m.class === 'conditional' && key === 'positive') causes.push(`"${m.name}" decided conditional at a positive gate`);
    else if (m.class === 'conditional' && key === 'not_negative') conditional.push(m.name);
  }

  if (perAgent) {
    for (const m of members) {
      const authored = m.threshold ?? gate?.threshold;
      const threshold = finiteNonNegative(authored);
      if (threshold === undefined) {
        causes.push(`"${m.name}" has no usable threshold (${String(authored)}); failing closed`);
      } else if (m.score !== null && m.score < threshold) {
        causes.push(`"${m.name}" scored ${m.score}, below its threshold ${threshold}`);
      }
    }
  } else if (gate?.threshold !== undefined) {
    const threshold = finiteNonNegative(gate.threshold);
    const scores = members.map(m => m.score).filter((s): s is number => s !== null);
    if (threshold === undefined) {
      causes.push(`the gate threshold is not a usable number (${String(gate.threshold)}); failing closed`);
    } else if (scores.length > 0) {
      const value = aggregate(gate.aggregate, scores);
      if (value < threshold) causes.push(`the ${gate.aggregate ?? 'min'} score ${value} is below the threshold ${threshold}`);
    }
  }

  const failed = causes.length > 0;
  return { failed, conditionalAccepted: !failed && isBlocking(mode) ? conditional : [], causes };
}

function aggregate(how: GateDefinition['aggregate'], scores: number[]): number {
  switch (how) {
    case 'max': return Math.max(...scores);
    case 'average': return scores.reduce((a, b) => a + b, 0) / scores.length;
    default: return Math.min(...scores);
  }
}

/** A judged stage's status: PASSED when its gate passed; otherwise WARNED behind `warn`, else FAILED. */
export function judgedOutcome(failed: boolean, mode: GateMode): 'PASSED' | 'WARNED' | 'FAILED' {
  if (!failed) return 'PASSED';
  return mode === 'warn' ? 'WARNED' : 'FAILED';
}
