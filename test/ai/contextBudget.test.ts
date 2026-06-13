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
