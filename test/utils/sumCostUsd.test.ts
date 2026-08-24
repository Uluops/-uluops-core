/**
 * sumCostUsd — costusd spec v0.6.0 Phase 1c (criterion 4 + 1c.6).
 * The polarity here is the inverse of sumTokenMetrics by design: ANY unpriced
 * child poisons the rollup to undefined; a partial sum is never presented as
 * a total.
 */
import { describe, it, expect } from 'vitest';
import { sumCostUsd } from '../../src/utils/sumCostUsd.js';

describe('sumCostUsd', () => {
  it('sums when ALL children are priced (exact)', () => {
    expect(sumCostUsd([{ costUsd: 0.1 }, { costUsd: 0.25 }, { costUsd: 0.05 }])).toBeCloseTo(0.4, 10);
  });

  it('single-child identity', () => {
    expect(sumCostUsd([{ costUsd: 0.331447 }])).toBeCloseTo(0.331447, 10);
  });

  it('ANY unpriced child → undefined (never a partial sum)', () => {
    expect(sumCostUsd([{ costUsd: 0.1 }, { costUsd: undefined }, { costUsd: 0.05 }])).toBeUndefined();
  });

  it('all-unpriced → undefined', () => {
    expect(sumCostUsd([{ costUsd: undefined }, { costUsd: undefined }])).toBeUndefined();
  });

  it('empty children → undefined (no fabricated $0 total)', () => {
    expect(sumCostUsd([])).toBeUndefined();
  });

  it('real zeros sum to a real 0 (zero-usage priced children)', () => {
    expect(sumCostUsd([{ costUsd: 0 }, { costUsd: 0 }])).toBe(0);
  });
});

describe('non-finite children (ship-gate runtime audit)', () => {
  it('treats NaN as unknown, not as a number to add', () => {
    // NaN passed the old `=== undefined` guard and turned the whole sum into NaN,
    // which JSON-serializes to null — indistinguishable downstream from a genuinely
    // unpriced model, destroying the exact polarity this function exists to preserve.
    const total = sumCostUsd([{ costUsd: 0.5 }, { costUsd: NaN }, { costUsd: 0.25 }]);
    expect(total).toBeUndefined();
    expect(Number.isNaN(total as number)).toBe(false);
  });

  it('treats Infinity as unknown', () => {
    expect(sumCostUsd([{ costUsd: 1 }, { costUsd: Infinity }])).toBeUndefined();
  });

  it('still sums a well-formed set (control — the guard must not reject valid input)', () => {
    expect(sumCostUsd([{ costUsd: 0.5 }, { costUsd: 0.25 }])).toBeCloseTo(0.75, 10);
  });
});
