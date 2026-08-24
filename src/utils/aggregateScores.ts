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
 * @returns Aggregated score, rounded for average/weighted_average
 */
/**
 * An authored weight is usable only if it is a finite positive number; anything else
 * degrades to the neutral weight 1 — the same weight an unlisted key already gets, so one
 * malformed entry costs the weighting rather than the aggregate. See the call site for the
 * measured failure modes (NaN -> a fabricated 0, Infinity -> a NaN that FAIL-OPENS a gate).
 */
function usableWeight(authored: number | undefined): number {
  return typeof authored === 'number' && Number.isFinite(authored) && authored > 0 ? authored : 1;
}

export function aggregateScores(
  items: ScoredItem[],
  method: AggregationMethod = 'average',
  weights: Record<string, number> = {},
): number {
  if (items.length === 0) return 0;

  const scorable = items.filter((i): i is ScoredItem & { score: number } => i.score != null);
  if (scorable.length === 0) return 0;

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
      // FABRICATION-OK: division guard. usableWeight now floors every weight at 1, so totalWeight is
      // positive whenever there is anything to score; the branch is unreachable defence.
      return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    }
    case 'average':
    default:
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }
}
