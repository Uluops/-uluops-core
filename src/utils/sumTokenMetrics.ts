import type { ExecutionMetrics } from '../types/execution.js';

type TokenFields = Pick<ExecutionMetrics, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'cachedInputTokens' | 'reasoningOutputTokens' | 'thinkingTokens' | 'totalEffectiveTokens'>;

/**
 * Sum token-related fields across an array of execution metrics.
 * Returns only token totals — caller adds durationMs, model, etc.
 * Component totals (cachedInput/reasoning/thinking) aggregate the stored subsets;
 * totalEffectiveTokens is the sum of each constituent's already-canonical effective.
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
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    cacheCreationTokens += m.cacheCreationTokens ?? 0;
    cacheReadTokens += m.cacheReadTokens ?? 0;
    cachedInputTokens += m.cachedInputTokens ?? 0;
    reasoningOutputTokens += m.reasoningOutputTokens ?? 0;
    thinkingTokens += m.thinkingTokens ?? 0;
    totalEffectiveTokens += m.totalEffectiveTokens;
  }

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cachedInputTokens, reasoningOutputTokens, thinkingTokens, totalEffectiveTokens };
}
