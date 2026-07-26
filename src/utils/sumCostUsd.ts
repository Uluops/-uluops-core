import type { ExecutionMetrics } from '../types/execution.js';

/**
 * Roll up estimated USD cost across child execution metrics.
 *
 * DELIBERATE POLARITY DIVERGENCE from the adjacent sumTokenMetrics: token
 * sums coalesce missing components to 0 because an absent token component is
 * a harness-visibility artifact over a real, counted run. An absent costUsd
 * means "unpriced model" — summing around it would present a partial sum as
 * a total, fabricating a cost exactly the way the pre-2026-07 wire fabricated
 * {input:0,output:0} rates. So: a defined sum ONLY when EVERY child carries
 * costUsd; undefined if ANY child lacks it (WORST-child discipline, precedent
 * e037aa98 / extractionConfidence). A real computed 0 on every child sums to
 * a real 0. (costusd-pricing-population spec v0.6.0, Phase 1c.)
 *
 * TWO CLASSES OF ABSENCE (run #69 F4/F5): undefined is reserved for LLM work
 * that cannot be priced — an unpriced model, or a crash whose usage went
 * unreported. Work that ran NO LLM by construction (steps stages) carries a
 * REAL costUsd: 0 at its construction site and sums cleanly. Skipped phases
 * contribute no children at all (commands: []). Do not "fix" an undefined
 * rollup by defaulting absent children to 0 here — that re-fabricates totals.
 */
export function sumCostUsd(
  items: ReadonlyArray<Pick<ExecutionMetrics, 'costUsd'>>,
): number | undefined {
  let total = 0;
  for (const m of items) {
    if (m.costUsd === undefined) return undefined;
    total += m.costUsd;
  }
  return items.length > 0 ? total : undefined;
}
