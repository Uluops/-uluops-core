import { describe, it, expect } from 'vitest';
import { deriveContextBudget, DEFAULT_CONTEXT_BUDGET } from '../../src/ai/contextBudget.js';

describe('deriveContextBudget', () => {
  it('uses the full window when known and no operator budget is set', () => {
    expect(deriveContextBudget({ modelWindow: 128_000 })).toBe(128_000);
    expect(deriveContextBudget({ modelWindow: 1_000_000 })).toBe(1_000_000);
  });

  it('falls back to DEFAULT_CONTEXT_BUDGET when the window is unknown', () => {
    expect(deriveContextBudget({})).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(deriveContextBudget({ modelWindow: 0 })).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(deriveContextBudget({ modelWindow: -1 })).toBe(DEFAULT_CONTEXT_BUDGET);
  });

  it('caps at the operator budget when it is lower than the window (operator overrides)', () => {
    expect(deriveContextBudget({ modelWindow: 1_000_000, operatorBudget: 200_000 })).toBe(200_000);
    expect(deriveContextBudget({ modelWindow: 128_000, operatorBudget: 50_000 })).toBe(50_000);
  });

  it('never lets the operator budget exceed the physical window', () => {
    // Operator asked for 500k but the model only has 128k — cap at the window.
    expect(deriveContextBudget({ modelWindow: 128_000, operatorBudget: 500_000 })).toBe(128_000);
  });

  it('honors the operator budget when the window is unknown', () => {
    expect(deriveContextBudget({ operatorBudget: 50_000 })).toBe(50_000);
    expect(deriveContextBudget({ modelWindow: 0, operatorBudget: 50_000 })).toBe(50_000);
  });

  it('keeps the 200k default identical for a 200k-window model with no operator budget (no regression)', () => {
    expect(deriveContextBudget({ modelWindow: 200_000 })).toBe(200_000);
    expect(DEFAULT_CONTEXT_BUDGET).toBe(200_000);
  });
});

/**
 * The operator budget is CONFIG — external input — and was passed through on `!= null`.
 *
 * POSITIVE CONTROL: restore `if (input.operatorBudget != null)` and the tests below fail.
 * Both unusable values fail badly and neither announces itself:
 *
 *   0   -> upperThreshold 0, so the wrap-up latch engages on step 1 and the agent can
 *          never call a tool, while reporting a forced-wrap-up marker and 'partial'
 *          completeness — a real degradation with a false stated cause.
 *   NaN -> every threshold comparison is false, so the brake is SILENTLY INERT with no
 *          markBrakeInert() call. That is exactly the gap `budget.brake-inert` was added
 *          to close, reopened one layer up: degradation.ts invariant (1) is "nothing
 *          degrades silently".
 */
describe('deriveContextBudget — an unusable operator budget is treated as absent', () => {
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'falls through to the model window for operatorBudget %s', (bad) => {
      const budget = deriveContextBudget({ operatorBudget: bad as number, modelWindow: 200_000 });
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBe(200_000);
    });

  it('falls back to the documented default when the window is unknown too', () => {
    const budget = deriveContextBudget({ operatorBudget: Number.NaN });
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
  });

  it('still HONOURS a usable operator budget — the negative control', () => {
    // Without this, "rejects unusable budgets" would pass for a function that ignored the
    // operator entirely, removing the only cost control the config exposes.
    expect(deriveContextBudget({ operatorBudget: 50_000, modelWindow: 200_000 })).toBe(50_000);
    expect(deriveContextBudget({ operatorBudget: 500_000, modelWindow: 200_000 })).toBe(200_000);
  });

  it('never returns a budget that would make a threshold comparison meaningless', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const b = deriveContextBudget({ operatorBudget: bad as number, modelWindow: 128_000 });
      expect(Number.isFinite(b) && b > 0).toBe(true);
    }
  });
});
