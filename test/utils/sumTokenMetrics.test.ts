import { describe, it, expect } from 'vitest';
import { sumTokenMetrics } from '../../src/utils/sumTokenMetrics.js';

describe('sumTokenMetrics', () => {
  it('sums token fields across multiple items', () => {
    const result = sumTokenMetrics([
      { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 20, cachedInputTokens: 5, reasoningOutputTokens: 8, thinkingTokens: 3, totalEffectiveTokens: 180 },
      { inputTokens: 200, outputTokens: 75, cacheCreationTokens: 15, cacheReadTokens: 30, cachedInputTokens: 7, reasoningOutputTokens: 0, thinkingTokens: 12, totalEffectiveTokens: 320 },
    ]);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      cacheCreationTokens: 25,
      cacheReadTokens: 50,
      cachedInputTokens: 12,
      reasoningOutputTokens: 8,
      thinkingTokens: 15,
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
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      thinkingTokens: 0,
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

/**
 * Finiteness at the token roll-up — the guard sumCostUsd got and this did not.
 *
 * POSITIVE CONTROL: revert the `finite()` calls to `m.inputTokens` / `?? 0` and each of
 * these fails with NaN. Confirmed against the pre-fix code. The `?? 0` reads like a
 * numeric guarantee and is not one — it passes NaN and Infinity straight through — and
 * `inputTokens`/`totalEffectiveTokens` had no guard at all because their TYPES declare
 * them required, which is a compile-time claim over values that originate in provider
 * payloads.
 */
describe('sumTokenMetrics — non-finite children', () => {
  const child = (over: Record<string, unknown> = {}) => ({
    inputTokens: 100, outputTokens: 50, totalEffectiveTokens: 150, ...over,
  } as never);

  it('does not let one NaN child NaN the entire run total', () => {
    // A NaN total JSON-serializes to null, which downstream reads as "no data" for a run
    // that demonstrably counted tokens.
    const total = sumTokenMetrics([child(), child({ inputTokens: NaN }), child()]);
    expect(Number.isFinite(total.inputTokens)).toBe(true);
    expect(total.inputTokens).toBe(200);
    expect(Number.isNaN(total.inputTokens)).toBe(false);
  });

  it('neutralises Infinity and negatives the same way', () => {
    const total = sumTokenMetrics([
      child({ outputTokens: Infinity }),
      child({ totalEffectiveTokens: -5_000 }),
    ]);
    expect(Number.isFinite(total.outputTokens)).toBe(true);
    expect(total.outputTokens).toBe(50);
    expect(total.totalEffectiveTokens).toBe(150);
    expect(total.totalEffectiveTokens).toBeGreaterThanOrEqual(0);
  });

  it('treats an undefined required field as zero rather than NaN', () => {
    // The types say these are always present; the wire disagrees.
    const total = sumTokenMetrics([child(), child({ inputTokens: undefined, totalEffectiveTokens: undefined })]);
    expect(total.inputTokens).toBe(100);
    expect(Number.isFinite(total.totalEffectiveTokens)).toBe(true);
  });

  it('keeps summing the OTHER components when one is unusable', () => {
    // Token polarity is deliberately opposite to cost: a bad component is dropped, the
    // run total survives. (An absent COST poisons its sum to undefined instead.)
    const total = sumTokenMetrics([child({ inputTokens: NaN, outputTokens: 50 })]);
    expect(total.inputTokens).toBe(0);
    expect(total.outputTokens).toBe(50);
  });
});
