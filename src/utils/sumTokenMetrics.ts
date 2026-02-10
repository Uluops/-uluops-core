import type { ExecutionMetrics } from '../types/execution.js';

type TokenFields = Pick<ExecutionMetrics, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'totalEffectiveTokens'>;

/**
 * Sum token-related fields across an array of execution metrics.
 * Returns only token totals — caller adds durationMs, model, etc.
 */
export function sumTokenMetrics(items: ReadonlyArray<TokenFields>): Required<TokenFields> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let totalEffectiveTokens = 0;

  for (const m of items) {
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    cacheCreationTokens += m.cacheCreationTokens ?? 0;
    cacheReadTokens += m.cacheReadTokens ?? 0;
    totalEffectiveTokens += m.totalEffectiveTokens;
  }

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalEffectiveTokens };
}
