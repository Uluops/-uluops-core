import { usableWeight } from './externalValue.js';
/**
 * Shared score aggregation for multi-agent/multi-phase results.
 *
 * Used by both CommandExecutor and WorkflowExecutor to eliminate
 * duplicated switch blocks that had already begun to diverge
 * (Math.round applied in WorkflowExecutor but not CommandExecutor).
 *
 * Both callers now get consistent behavior: weighted_average and
 * average are rounded to the nearest integer.
 */

export type AggregationMethod = 'min' | 'max' | 'sum' | 'weighted_average' | 'average';

export interface ScoredItem {
  /** Key used to look up weight in the weights map */
  key: string;
  score: number | null;
}

/**
 * Aggregate scores using the specified method.
 *
 * @param items - Scored items with keys for weight lookup
 * @param method - Aggregation method (defaults to 'average')
 * @param weights - Weight map keyed by item key (defaults to equal weight of 1)
 * @returns Aggregated score, rounded for average/weighted_average — or `null` when
 *          nothing scorable was supplied (empty input, or every item scoreless). Callers
 *          that need "nothing was asked for" to BLOCK must decide that themselves; see the
 *          note at the scoreless branch below.
 */

export function aggregateScores(
  items: ScoredItem[],
  method: AggregationMethod = 'average',
  weights: Record<string, number> = {},
): number | null {
  const scorable = items.filter((i): i is ScoredItem & { score: number } => i.score != null);
  // RESOLVED 2026-08-24 (Alex's call). Returns null — "no score" — for BOTH "nothing was
  // asked for" (items empty) and "things ran but none produce scores" (scorable empty).
  //
  // The two cases are not distinguishable HERE and never were: every caller pre-filters or
  // shapes its input before this util sees it, so an authored-empty panel and an
  // all-generator panel arrive as the same empty array. Deciding between them at this layer
  // required information this layer does not hold, and the 0 it used to return was that
  // decision made blind — a fabricated failing score that flowed to the tracker and the gate.
  //
  // The block-on-authored-empty rule therefore lives at the caller that holds the
  // definition: WorkflowExecutor.aggregatePhaseScore returns 0 for `commands: []` because
  // "nothing was asked for" is suspicious and must block. That is a deliberate, documented
  // divergence from this util, not the unresolved one it replaces.
  //
  // Behavioural consequence, accepted: under evaluateGate and PipelineExecutor.gateFailed
  // null is fail-open, so an all-scoreless panel now PASSES its gate in pipelines and
  // commands where it previously failed at 0. That matches what both gates already document
  // ("scoreless stages are fail-open for the threshold check") — the fabricated 0 was
  // defeating the contract those comments describe.
  //
  // REJECTED: keeping 0 and changing aggregatePhaseScore to match. It agrees the four
  // surfaces, but stores a fabricated score in run data where 0 is indistinguishable from a
  // genuinely-failing panel, and contradicts the result types — PhaseResult.score,
  // CommandResult.score, WorkflowResult.score and PipelineResult.score are all
  // `number | null`, documented "null for scoreless (generator/executor) commands".
  // ALSO REJECTED: a `gate.onUnscored` field letting each definition declare the meaning.
  // Principled, but it is an ADL/PDL schema change — seven repos and a corpus retranslate
  // — to configure a case whose correct default both gates already state in prose.
  //
  // The one test that pinned 0 (`returns 0 when all items have null scores`) is retired to
  // `returns null when all items have null scores` in test/utils/aggregateScores.test.ts.
  if (scorable.length === 0) return null;

  const scores = scorable.map(i => i.score);

  switch (method) {
    case 'min':
      return Math.min(...scores);
    case 'max':
      return Math.max(...scores);
    case 'sum':
      return scores.reduce((a, b) => a + b, 0);
    case 'weighted_average': {
      let totalWeight = 0;
      let weightedSum = 0;
      for (const item of scorable) {
        // Weights come from the DEFINITION — authored YAML/JSON, i.e. external input,
        // exactly like a provider payload. They were read raw, and the failure modes are
        // measured, not theoretical (true scores 90 and 95, aggregating to 93 unweighted):
        //
        //   NaN weight       -> 0    a fabricated failing score that fails every gate
        //   Infinity weight  -> NaN  and `NaN < threshold` is FALSE, so the gate PASSES a
        //                            run with no valid score, then serializes to null
        //   0 / negative     -> 0    same fabricated failure
        //
        // The fail-OPEN case is the dangerous one: a quality gate silently stops gating.
        // YAML makes `.nan` and `.inf` directly authorable.
        //
        // An unusable weight falls back to 1 — the same neutral weight an unlisted key
        // already gets — so one malformed entry degrades to unweighted rather than
        // poisoning the whole aggregate. Zero and negative are rejected for the same
        // reason: a weight of 0 is indistinguishable from "exclude this item", which is
        // not what a scoring weight means, and a negative one inverts the aggregate.
        const w = usableWeight(weights[item.key]);
        totalWeight += w;
        weightedSum += item.score * w;
      }
      // Division guard. usableWeight floors every weight at 1, so totalWeight is positive
      // whenever there is anything to score; the branch is unreachable defence. It returns
      // null rather than 0 for the same reason the scoreless branch above does — if it ever
      // did fire, no score was computable, and 0 would be a fabricated failing one.
      return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
    }
    case 'average':
    default:
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }
}
