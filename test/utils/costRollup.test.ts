/**
 * rollupCost / agentCost — the four-field cost lattice (OpenRouter plan S6c, D3; checklist
 * step 6). Each case is a negative control from the checklist: the module did not exist
 * before slice 1c, and each assertion names the wrong answer a naive rollup would give.
 */
import { describe, it, expect } from 'vitest';
import { agentCost, rollupCost, type CostFields } from '../../src/utils/costRollup.js';

const billed = (usd: number, est?: number): CostFields => agentCost(est, usd);
const estimated = (usd: number): CostFields => agentCost(usd, undefined);
const unpriced = (): CostFields => agentCost(undefined, undefined);
const stepsStage = (): CostFields => ({ costUsd: 0, costUsdTotal: 0, costBasis: 'none' });

describe('agentCost — the per-agent rule', () => {
  it('prefers the billed figure, keeping the estimate pure beside it', () => {
    expect(agentCost(0.05, 0.04)).toEqual({ costUsd: 0.05, costUsdBilled: 0.04, costUsdTotal: 0.04, costBasis: 'billed' });
  });

  it('an OpenRouter :free agent billing $0 is billed, not none', () => {
    expect(agentCost(undefined, 0).costBasis).toBe('billed');
    expect(agentCost(undefined, 0).costUsdTotal).toBe(0);
  });

  it('falls back to the estimate, then to unpriced', () => {
    expect(agentCost(0.05, undefined)).toMatchObject({ costUsdTotal: 0.05, costBasis: 'estimated' });
    expect(unpriced()).toMatchObject({ costUsdTotal: undefined, costBasis: 'unpriced' });
  });

  it('a non-finite billed figure is not a bill', () => {
    expect(agentCost(0.05, Number.NaN)).toMatchObject({ costUsdTotal: 0.05, costBasis: 'estimated' });
  });
});

describe('rollupCost — the lattice', () => {
  it('a pipeline of only steps stages is none with a real zero total, not unpriced', () => {
    expect(rollupCost([stepsStage(), stepsStage()])).toMatchObject({ costBasis: 'none', costUsdTotal: 0 });
  });

  it('a workflow with every phase skipped (no children) is none with a zero total; costUsd keeps its old rollup', () => {
    expect(rollupCost([])).toEqual({ costUsd: undefined, costUsdBilled: undefined, costUsdTotal: 0, costBasis: 'none' });
  });

  it('billed agents plus a steps stage are billed, not mixed — none is neutral', () => {
    const r = rollupCost([billed(0.01), billed(0.02), stepsStage()]);
    expect(r.costBasis).toBe('billed');
    expect(r.costUsdBilled).toBeCloseTo(0.03, 12);
    expect(r.costUsdTotal).toBeCloseTo(0.03, 12);
  });

  it('billed plus unpriced is unpriced, with no total and no billed figure', () => {
    expect(rollupCost([billed(0.01), unpriced()])).toMatchObject({
      costBasis: 'unpriced', costUsdTotal: undefined, costUsdBilled: undefined,
    });
  });

  it('a mixed panel totals billed + estimate, keeps costUsd worst-child and billed undefined', () => {
    // The billed agent has no estimate (an unregistered model), so worst-child costUsd is undefined.
    const r = rollupCost([billed(0.01), estimated(0.05)]);
    expect(r.costBasis).toBe('mixed');
    expect(r.costUsdTotal).toBeCloseTo(0.06, 12);
    expect(r.costUsd).toBeUndefined();
    expect(r.costUsdBilled).toBeUndefined();
  });

  it('a mixed child makes the parent mixed even when its siblings agree', () => {
    const child = rollupCost([billed(0.01), estimated(0.05)]);
    expect(rollupCost([child, rollupCost([billed(0.02)])]).costBasis).toBe('mixed');
  });

  it('an unpriced agent alone is unpriced', () => {
    expect(rollupCost([unpriced()]).costBasis).toBe('unpriced');
  });

  it('an unlabelled legacy child with no figure is unpriced, never free', () => {
    expect(rollupCost([{ costUsd: undefined }, billed(0.01)]).costBasis).toBe('unpriced');
  });

  it('all estimated stays estimated and costUsd matches sumCostUsd', () => {
    const r = rollupCost([estimated(0.25), estimated(0.1)]);
    expect(r).toMatchObject({ costBasis: 'estimated', costUsdBilled: undefined });
    expect(r.costUsd).toBeCloseTo(0.35, 12);
    expect(r.costUsdTotal).toBeCloseTo(0.35, 12);
  });

  it('a NaN total on a priced child is unknowable, not a NaN sum', () => {
    expect(rollupCost([{ costUsdTotal: Number.NaN, costBasis: 'estimated' }]).costBasis).toBe('unpriced');
  });
});
