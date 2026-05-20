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
  score: number;
}

/**
 * Aggregate scores using the specified method.
 *
 * @param items - Scored items with keys for weight lookup
 * @param method - Aggregation method (defaults to 'average')
 * @param weights - Weight map keyed by item key (defaults to equal weight of 1)
 * @returns Aggregated score, rounded for average/weighted_average
 */
export function aggregateScores(
  items: ScoredItem[],
  method: AggregationMethod = 'average',
  weights: Record<string, number> = {},
): number {
  if (items.length === 0) return 0;

  const scores = items.map(i => i.score);

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
      for (const item of items) {
        const w = weights[item.key] ?? 1;
        totalWeight += w;
        weightedSum += item.score * w;
      }
      return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    }
    case 'average':
    default:
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }
}
