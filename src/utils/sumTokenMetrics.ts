import type { ExecutionMetrics } from '../types/execution.js';

type TokenFields = Pick<ExecutionMetrics, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'cachedInputTokens' | 'reasoningOutputTokens' | 'thinkingTokens' | 'totalEffectiveTokens'>;

/**
 * Coerce a child's token component to a finite, non-negative number.
 *
 * The `?? 0` that used to guard these reads like a numeric guarantee and is not one: it
 * passes NaN and Infinity straight through, and `inputTokens`/`totalEffectiveTokens` had
 * no guard at all because their types declare them required — a compile-time claim over
 * values that originate in provider payloads. One NaN child turns the run's entire token
 * total into NaN, which JSON-serializes to `null`.
 *
 * The identical guard was added to the sibling sumCostUsd and not here, even though the
 * two share every call site. Same defect, one function over — which is the shape this
 * whole release keeps finding.
 */
function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Sum token-related fields across an array of execution metrics.
 * Returns only token totals — caller adds durationMs, model, etc.
 * Component totals (cachedInput/reasoning/thinking) aggregate the stored subsets;
 * totalEffectiveTokens is the sum of each constituent's already-canonical effective.
 *
 * POLARITY, deliberately opposite to sumCostUsd: token sums coalesce an absent or
 * unusable component to 0 and keep summing, because an absent token component is a
 * harness-visibility artifact over a real, counted run. An absent COST, by contrast,
 * poisons the whole sum to undefined. Do not unify these — see sumCostUsd's contract.
 */
export function sumTokenMetrics(items: ReadonlyArray<TokenFields>): Required<TokenFields> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let cachedInputTokens = 0;
  let reasoningOutputTokens = 0;
  let thinkingTokens = 0;
  let totalEffectiveTokens = 0;

  for (const m of items) {
    inputTokens += finite(m.inputTokens);
    outputTokens += finite(m.outputTokens);
    cacheCreationTokens += finite(m.cacheCreationTokens);
    cacheReadTokens += finite(m.cacheReadTokens);
    cachedInputTokens += finite(m.cachedInputTokens);
    reasoningOutputTokens += finite(m.reasoningOutputTokens);
    thinkingTokens += finite(m.thinkingTokens);
    totalEffectiveTokens += finite(m.totalEffectiveTokens);
  }

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cachedInputTokens, reasoningOutputTokens, thinkingTokens, totalEffectiveTokens };
}
