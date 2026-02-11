import { describe, it, expect } from 'vitest';
import { sumTokenMetrics } from '../../src/utils/sumTokenMetrics.js';

describe('sumTokenMetrics', () => {
  it('sums token fields across multiple items', () => {
    const result = sumTokenMetrics([
      { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 20, totalEffectiveTokens: 180 },
      { inputTokens: 200, outputTokens: 75, cacheCreationTokens: 15, cacheReadTokens: 30, totalEffectiveTokens: 320 },
    ]);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      cacheCreationTokens: 25,
      cacheReadTokens: 50,
      totalEffectiveTokens: 500,
    });
  });

  it('returns zeros for empty array', () => {
    const result = sumTokenMetrics([]);
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalEffectiveTokens: 0,
    });
  });

  it('handles undefined optional cache fields (defaults to 0)', () => {
    const result = sumTokenMetrics([
      { inputTokens: 100, outputTokens: 50, cacheCreationTokens: undefined, cacheReadTokens: undefined, totalEffectiveTokens: 150 },
      { inputTokens: 200, outputTokens: 75, cacheCreationTokens: 10, cacheReadTokens: undefined, totalEffectiveTokens: 285 },
    ]);
    expect(result.cacheCreationTokens).toBe(10);
    expect(result.cacheReadTokens).toBe(0);
  });

  it('handles single item', () => {
    const result = sumTokenMetrics([
      { inputTokens: 500, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, totalEffectiveTokens: 600 },
    ]);
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(100);
  });
});
