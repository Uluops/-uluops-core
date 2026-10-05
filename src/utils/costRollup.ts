import type { CostBasis, ExecutionMetrics } from '../types/execution.js';
import { sumCostUsd } from './sumCostUsd.js';

/** The four cost fields every result level carries (OpenRouter plan S6c, D3). */
export type CostFields = Pick<ExecutionMetrics, 'costUsd' | 'costUsdBilled' | 'costUsdTotal' | 'costBasis'>;

const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

/**
 * The per-agent rule: the total is the billed figure when there is one, else the estimate,
 * else there is no total. A billed $0 (an OpenRouter `:free` model) is a real billed figure,
 * so it is `'billed'`, not `'none'` — `'none'` means no model was called, and one was.
 *
 * `costUsd` and `costUsdBilled` pass through unchanged; they stay pure for reconciliation.
 */
export function agentCost(costUsd: number | undefined, costUsdBilled: number | undefined): CostFields {
  if (finite(costUsdBilled)) {
    return { costUsd, costUsdBilled, costUsdTotal: costUsdBilled, costBasis: 'billed' };
  }
  if (finite(costUsd)) {
    return { costUsd, costUsdBilled: undefined, costUsdTotal: costUsd, costBasis: 'estimated' };
  }
  return { costUsd: undefined, costUsdBilled: undefined, costUsdTotal: undefined, costBasis: 'unpriced' };
}

/**
 * A child's basis. A child built before these fields existed (or by a caller that sets only
 * `costUsd`) is classified by the per-agent rule rather than trusted to be absent-means-none:
 * an unlabelled child with no figure is UNPRICED, never free. `'none'` is only ever an
 * explicit claim made at a construction site that knows no model ran.
 *
 * An explicit label is trusted only where the child's own figures support it (1c crew,
 * logic-error-detector L1). Every construction site in core produces consistent fields, but
 * the label is the one thing a parent cannot check later: a `'billed'` child with no billed
 * figure would make its parent `'billed'` with `costUsdBilled: undefined`, and a `'none'`
 * child carrying a cost would vanish from the total while `sumCostUsd` still counted it.
 * `'unpriced'` is always trusted — it can only make a parent more conservative.
 */
function basisOf(c: CostFields): CostBasis {
  const derived = agentCost(c.costUsd, c.costUsdBilled).costBasis!;
  switch (c.costBasis) {
    case undefined: return derived;
    case 'unpriced': return 'unpriced';
    case 'billed': return finite(c.costUsdBilled) ? 'billed' : derived;
    case 'none': {
      const carriesCost = [c.costUsd, c.costUsdBilled, c.costUsdTotal].some(v => v !== undefined && v !== 0);
      return carriesCost ? derived : 'none';
    }
    case 'estimated': return finite(c.costUsdTotal ?? c.costUsd) ? 'estimated' : 'unpriced';
    case 'mixed': return finite(c.costUsdTotal) ? 'mixed' : 'unpriced';
  }
}

/**
 * Roll the four cost fields up from children to a parent (stage, command, workflow,
 * pipeline).
 *
 * - `costUsd` keeps its existing worst-child rollup (`sumCostUsd`), including `undefined`
 *   for empty input.
 * - `'none'` children are NEUTRAL: a pipeline of billed agents plus a steps stage is
 *   `'billed'`, and its billed sum is the agents' sum.
 * - `'unpriced'` DOMINATES: any unpriced child makes the parent unpriced, with no total and
 *   no billed figure — a partial sum presented as a total is the failure this guards.
 * - Otherwise all-billed is `'billed'`, all-estimated is `'estimated'`, anything else
 *   (including a `'mixed'` child) is `'mixed'`. The total is the sum of children's totals.
 *   `costUsdBilled` is defined only when every priced child carries one.
 * - Empty or all-`'none'` input is `'none'` with a real `costUsdTotal: 0`.
 */
export function rollupCost(children: ReadonlyArray<CostFields>): CostFields {
  const costUsd = sumCostUsd(children);
  const priced = children.filter(c => basisOf(c) !== 'none');

  if (priced.length === 0) {
    return { costUsd, costUsdBilled: undefined, costUsdTotal: 0, costBasis: 'none' };
  }

  const bases = new Set(priced.map(basisOf));
  // A child labelled priced whose total is missing or non-finite is as unknowable as an
  // unpriced one; NaN would otherwise serialize to null and read as "unpriced" with a
  // basis that says otherwise.
  if (bases.has('unpriced') || priced.some(c => !finite(c.costUsdTotal ?? agentCost(c.costUsd, c.costUsdBilled).costUsdTotal))) {
    return { costUsd, costUsdBilled: undefined, costUsdTotal: undefined, costBasis: 'unpriced' };
  }

  let total = 0;
  for (const c of priced) total += (c.costUsdTotal ?? agentCost(c.costUsd, c.costUsdBilled).costUsdTotal)!;

  let billed: number | undefined = 0;
  for (const c of priced) {
    if (!finite(c.costUsdBilled)) { billed = undefined; break; }
    billed += c.costUsdBilled;
  }

  const costBasis: CostBasis = bases.size === 1 && !bases.has('mixed') ? [...bases][0]! : 'mixed';
  return { costUsd, costUsdBilled: billed, costUsdTotal: total, costBasis };
}
