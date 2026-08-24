import type { ExecutionMetrics } from '../types/execution.js';
import { hasBilledMetrics } from '../errors/index.js';

/**
 * Build the `metrics` for a child whose execution ended in a thrown error.
 *
 * Two cases that were previously collapsed into one:
 *
 * 1. **The error carries billed metrics.** `MaxStepsExhaustedError` is thrown AFTER a
 *    successful provider call, so real tokens and a real cost exist. Report them. Every
 *    rejection handler used to synthesize `{inputTokens: 0, outputTokens: 0,
 *    totalEffectiveTokens: 0, model: 'unknown'}` instead — and because a step-ceiling run
 *    is by construction the longest run the engine produces, that fabricated zero erased
 *    the largest single cost core is capable of incurring. `sumTokenMetrics` then folded
 *    the zeros into the run total and the money silently vanished.
 *
 * 2. **The error carries nothing.** Nothing is known about what was billed, so tokens
 *    report zero (bounded, and the required `number` fields admit no absence) while
 *    `costUsd` is **omitted**. That asymmetry is deliberate and matches `sumCostUsd`'s
 *    contract: an absent cost means "LLM work that cannot be priced — an unpriced model,
 *    or a crash whose usage went unreported", and it propagates as worst-child so the
 *    roll-up degrades to unknown rather than presenting a partial sum as a total. A zero
 *    cost is a claim; an absent cost is an admission.
 *
 * Never write `costUsd: 0` here. That is the fabrication this helper exists to prevent.
 */
export function crashMetrics(error: unknown, extra?: Partial<ExecutionMetrics>): ExecutionMetrics {
  // Identity-free, NOT `instanceof` — see hasBilledMetrics. This is the one seam in the
  // package where real money survives a crash, so a false negative here silently zeroes
  // the most expensive run class the engine produces.
  if (hasBilledMetrics(error)) {
    return { ...error.billedMetrics, ...extra };
  }
  return {
    // FABRICATION-OK: the documented "nothing is known" branch. Tokens report a bounded 0
    // because their types admit no absence; costUsd is OMITTED, which is the field that
    // carries the unknown. See this function's doc comment.
    inputTokens: 0,
    // FABRICATION-OK: see inputTokens above — the documented "nothing known" branch,
    // where costUsd is the field that carries the unknown.
    outputTokens: 0,
    // FABRICATION-OK: see inputTokens above — the documented "nothing known" branch,
    // where costUsd is the field that carries the unknown.
    totalEffectiveTokens: 0,
    // Wall-clock is knowable even when tokens are not, so every caller that HOLDS a
    // duration now supplies it through `extra`. This line was previously covered by the
    // waiver four lines up, whose reason speaks only about TOKENS and COST — a
    // waiver-bleed the old 4-line lookback allowed, and which the scoped lookback now
    // prevents. A network failure 30 seconds in reported 0 ms.
    // FABRICATION-OK: floor for a caller that genuinely holds no duration.
    durationMs: 0,
    model: 'unknown',
    ...extra,
  };
}
