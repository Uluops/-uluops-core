import { describe, it, expect } from 'vitest';
import { crashMetrics } from '../../src/utils/crashMetrics.js';
import { MaxStepsExhaustedError, ExecutionError } from '../../src/errors/index.js';

/**
 * The two cases a crashed child's metrics used to collapse into one.
 *
 * POSITIVE CONTROL for the whole file: replace crashMetrics' body with the literal
 * `{inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 0, model:
 * 'unknown'}` that the three rejection handlers used to inline, and every "already
 * billed" assertion below fails. Confirmed against the pre-fix code.
 */
describe('crashMetrics', () => {
  const billed = {
    inputTokens: 120_000,
    outputTokens: 8_000,
    totalEffectiveTokens: 128_000,
    durationMs: 412_000,
    model: 'anthropic:claude-sonnet-4-5',
    costUsd: 0.48,
    toolCallCount: 42,
  };

  it('reports the usage a MaxStepsExhaustedError already billed', () => {
    // A step-ceiling run is BY CONSTRUCTION the longest run the engine produces, so this
    // is the largest single cost core can incur — and it was being recorded as zero.
    const err = new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed);
    const m = crashMetrics(err);

    expect(m.inputTokens).toBe(120_000);
    expect(m.totalEffectiveTokens).toBe(128_000);
    expect(m.costUsd).toBe(0.48);
    expect(m.model).toBe('anthropic:claude-sonnet-4-5');
    // The specific fabrication this replaces.
    expect(m.inputTokens).not.toBe(0);
  });

  it('OMITS costUsd — never zero — for an error carrying nothing', () => {
    // The asymmetry is the point (see sumCostUsd's contract): tokens report a bounded
    // zero because their types admit no absence, but an absent cost must stay absent so
    // the roll-up degrades to unknown rather than presenting a partial sum as a total.
    // A zero cost is a claim; an absent cost is an admission.
    const m = crashMetrics(new ExecutionError('boom'));

    expect(m.costUsd).toBeUndefined();
    expect('costUsd' in m && m.costUsd === 0).toBe(false);
    expect(m.inputTokens).toBe(0);
    expect(m.model).toBe('unknown');
  });

  it('omits costUsd for a MaxStepsExhaustedError that carries no metrics', () => {
    // The field is optional precisely so a caller without real numbers cannot be forced
    // to invent them — absence must survive the error, not be defaulted away.
    const m = crashMetrics(new MaxStepsExhaustedError('exhausted', 50, 'tool-calls'));
    expect(m.costUsd).toBeUndefined();
    expect(m.inputTokens).toBe(0);
  });

  it('carries billed metrics through the error’s JSON form', () => {
    const err = new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed);
    const json = err.toJSON();
    expect(json['steps']).toBe(50);
    expect(json['billedMetrics']).toEqual(billed);
  });

  it('lets a caller override fields without losing the billed numbers', () => {
    const m = crashMetrics(
      new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed),
      { toolCallCount: 0 },
    );
    expect(m.toolCallCount).toBe(0);
    expect(m.costUsd).toBe(0.48);
  });

  it('is unaffected by a non-Error rejection reason', () => {
    const m = crashMetrics('a string rejection');
    expect(m.costUsd).toBeUndefined();
    expect(m.inputTokens).toBe(0);
  });
});

/**
 * crashMetrics' two cost-basis lines (1c crew: test-architect mutants 7 and 8 survived
 * the full suite). NEGATIVE CONTROL: each test fails with its line removed.
 */
describe('crashMetrics — cost basis on both branches', () => {
  it("the nothing-known branch is labelled 'unpriced', not left for a parent to guess", () => {
    expect(crashMetrics(new Error('boom')).costBasis).toBe('unpriced');
  });

  it('a billedMetrics payload predating the cost fields is classified, not passed through bare', () => {
    const legacy = { inputTokens: 10, outputTokens: 5, totalEffectiveTokens: 15, durationMs: 1, model: 'm', costUsd: 0.4, costUsdBilled: 0.3 };
    expect(crashMetrics(new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', legacy)))
      .toMatchObject({ costUsd: 0.4, costUsdBilled: 0.3, costUsdTotal: 0.3, costBasis: 'billed' });
  });
});
