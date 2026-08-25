import { describe, it, expect } from 'vitest';
import { aggregateScores, type ScoredItem } from '../../src/utils/aggregateScores.js';

function items(...scores: number[]): ScoredItem[] {
  return scores.map((score, i) => ({ key: `k${i}`, score }));
}

describe('aggregateScores', () => {
  it('returns 0 for empty items — nothing ran, so the gate must not fail-open', () => {
    // Briefly changed to `toBeNull()` on 2026-08-24 and changed back the same day: the
    // ship gate caught it as a hard-gate bypass. An empty array means no item was offered
    // at all, which is "nothing executed" — a workflow whose every phase was skipped, or a
    // pipeline agents-stage whose every agent's condition was false. Reporting null there
    // fail-opened an `on_failure: abort` gate over work that never happened.
    //
    // Distinct from the branch below, where items ARE present and simply do not score.
    expect(aggregateScores([])).toBe(0);
  });

  describe('min', () => {
    it('returns the minimum score', () => {
      expect(aggregateScores(items(90, 70, 85), 'min')).toBe(70);
    });

    it('handles single item', () => {
      expect(aggregateScores(items(42), 'min')).toBe(42);
    });

    it('handles tie scores', () => {
      expect(aggregateScores(items(80, 80, 80), 'min')).toBe(80);
    });
  });

  describe('max', () => {
    it('returns the maximum score', () => {
      expect(aggregateScores(items(90, 70, 85), 'max')).toBe(90);
    });

    it('handles single item', () => {
      expect(aggregateScores(items(42), 'max')).toBe(42);
    });

    it('handles tie scores', () => {
      expect(aggregateScores(items(80, 80, 80), 'max')).toBe(80);
    });
  });

  describe('sum', () => {
    it('returns the sum of scores', () => {
      expect(aggregateScores(items(10, 20, 30), 'sum')).toBe(60);
    });

    it('handles single item', () => {
      expect(aggregateScores(items(42), 'sum')).toBe(42);
    });
  });

  describe('average', () => {
    it('returns the average', () => {
      expect(aggregateScores(items(80, 90), 'average')).toBe(85);
    });

    it('rounds non-integer mean (catches Math.round removal)', () => {
      // 80 + 85 = 165, 165/2 = 82.5, rounds to 83
      expect(aggregateScores(items(80, 85), 'average')).toBe(83);
    });

    it('rounds down at .4', () => {
      // 81 + 82 = 163, 163/2 = 81.5 → rounds to 82
      // 70 + 71 + 72 = 213, 213/3 = 71.0 → exact
      // 71 + 72 + 73 + 74 = 290, 290/4 = 72.5 → 73
      expect(aggregateScores(items(71, 72, 73, 74), 'average')).toBe(73);
    });

    it('is the default method', () => {
      expect(aggregateScores(items(80, 90))).toBe(85);
    });
  });

  describe('weighted_average', () => {
    it('applies weights from the map', () => {
      const scored = [
        { key: 'a', score: 100 },
        { key: 'b', score: 50 },
      ];
      // (100*3 + 50*1) / 4 = 87.5 → 88
      expect(aggregateScores(scored, 'weighted_average', { a: 3, b: 1 })).toBe(88);
    });

    it('defaults missing weights to 1', () => {
      const scored = [
        { key: 'a', score: 100 },
        { key: 'b', score: 50 },
      ];
      // no weight map → equal weight 1 → (100+50)/2 = 75
      expect(aggregateScores(scored, 'weighted_average')).toBe(75);
    });

    it('rounds non-integer weighted mean', () => {
      const scored = [
        { key: 'a', score: 90 },
        { key: 'b', score: 80 },
      ];
      // (90*2 + 80*3) / 5 = 420/5 = 84.0 → exact
      expect(aggregateScores(scored, 'weighted_average', { a: 2, b: 3 })).toBe(84);
      // (90*1 + 80*2) / 3 = 250/3 = 83.333 → 83
      expect(aggregateScores(scored, 'weighted_average', { a: 1, b: 2 })).toBe(83);
    });
  });

  describe('null score handling', () => {
    it('excludes null-score items from average', () => {
      const scored: ScoredItem[] = [
        { key: 'a', score: 80 },
        { key: 'b', score: 90 },
        { key: 'c', score: null },
      ];
      // (80 + 90) / 2 = 85
      expect(aggregateScores(scored, 'average')).toBe(85);
    });

    it('returns null when all items have null scores', () => {
      const scored: ScoredItem[] = [
        { key: 'a', score: null },
        { key: 'b', score: null },
      ];
      // Retired from `toBe(0)` 2026-08-24. A panel of generators/executors produced no
      // score; 0 asserted they all scored zero, which no agent did.
      expect(aggregateScores(scored, 'average')).toBeNull();
      expect(aggregateScores(scored, 'average')).not.toBe(0);
    });

    it('excludes null-score items from min', () => {
      const scored: ScoredItem[] = [
        { key: 'a', score: 80 },
        { key: 'b', score: null },
        { key: 'c', score: 60 },
      ];
      expect(aggregateScores(scored, 'min')).toBe(60);
    });

    it('excludes null-score items from weighted_average', () => {
      const scored: ScoredItem[] = [
        { key: 'a', score: 100 },
        { key: 'b', score: null },
        { key: 'c', score: 50 },
      ];
      // (100*1 + 50*1) / 2 = 75
      expect(aggregateScores(scored, 'weighted_average')).toBe(75);
    });
  });
});

/**
 * Authored weights are EXTERNAL INPUT — definition YAML/JSON — and were read raw.
 *
 * POSITIVE CONTROL: restore `const w = weights[item.key] ?? 1` and every test below fails.
 * Measured before the fix, with true scores of 90 and 95 aggregating to 93 unweighted:
 *
 *   NaN weight       -> 0     a fabricated failing score
 *   Infinity weight  -> NaN   and `NaN < threshold` is FALSE, so the gate PASSES
 *   0 / negative     -> 0
 *
 * The fail-OPEN case is the dangerous one: a quality gate silently stops gating, and the
 * score JSON-serializes to null. YAML makes `.nan` and `.inf` directly authorable.
 */
describe('aggregateScores — malformed authored weights cannot fabricate a score', () => {
  const items = [{ key: 'a', score: 20 }, { key: 'b', score: 100 }];
  const w = (weights: Record<string, number>) => aggregateScores(items, 'weighted_average', weights);

  it.each([
    ['NaN', { a: Number.NaN, b: 1 }],
    ['Infinity', { a: Number.POSITIVE_INFINITY, b: 1 }],
    ['zero', { a: 0, b: 0 }],
    ['negative', { a: -5, b: -5 }],
  ])('degrades a %s weight to neutral rather than fabricating', (_label, weights) => {
    const score = w(weights as Record<string, number>);

    // Non-null is part of the claim: these items DO score (20 and 100), so a null here
    // would mean the weight handling had swallowed them, not degraded to neutral.
    expect(score).not.toBeNull();
    expect(Number.isFinite(score)).toBe(true);
    expect(Number.isNaN(score)).toBe(false);
    // A NaN score fail-OPENS a gate, because NaN < threshold is false.
    expect(score! < 70).toBe(true);
    expect(JSON.stringify({ score })).not.toContain('null');
  });

  it('a NaN weight no longer reports 0 for agents that scored 20 and 100', () => {
    expect(w({ a: Number.NaN, b: 1 })).toBe(60);
    expect(w({ a: Number.NaN, b: 1 })).not.toBe(0);
  });

  it('still WEIGHTS when the weights are usable — the negative control', () => {
    // Without this, "degrades to neutral" would pass for an implementation that ignored
    // weights entirely, silently removing the feature.
    expect(aggregateScores(items, 'average')).toBe(60);
    expect(w({ a: 9, b: 1 })).toBe(28);
    expect(w({ a: 1, b: 9 })).toBe(92);
  });

  it('a NaN score can never pass a gate comparison, whatever the weights', () => {
    // The invariant behind all of the above, asserted directly.
    for (const weights of [{ a: Number.NaN, b: 1 }, { a: Number.POSITIVE_INFINITY, b: 1 }, { a: 0, b: 0 }]) {
      const score = w(weights as Record<string, number>);
      expect(Number.isNaN(score)).toBe(false);
    }
  });
});

/**
 * The scoreless-panel semantics, asserted at the value the GATES actually read.
 *
 * Resolved 2026-08-24: null, not 0. Both consuming gates — WorkflowExecutor.evaluateGate
 * and PipelineExecutor.gateFailed — treat null as fail-open and any number as gateable, so
 * the difference between the two answers is the difference between an all-generator panel
 * passing its gate and failing it.
 *
 * POSITIVE CONTROL: restore `if (scorable.length === 0) return 0;` (and the
 * `items.length === 0` early return) and every assertion below fails — each one is written
 * against the value, not against `not.toThrow()`.
 */
describe('aggregateScores — a scoreless panel reports no score, not a failing one', () => {
  const scoreless = (n: number): ScoredItem[] =>
    Array.from({ length: n }, (_, i) => ({ key: `gen${i}`, score: null }));

  // Mirrors the two gates: null fail-opens, a number is compared to the threshold.
  const gateBlocks = (score: number | null, threshold: number) =>
    score !== null && score < threshold;

  it('separates "nothing ran" from "nothing scored" — the distinction the gate reads', () => {
    // The two facts that were briefly merged. They must never return the same value:
    // one has to block, the other has to fail-open.
    expect(aggregateScores([])).toBe(0);              // nothing ran      -> BLOCKS
    expect(aggregateScores(scoreless(2))).toBeNull(); // ran, no scores   -> fail-opens
    expect(aggregateScores([])).not.toBe(aggregateScores(scoreless(2)));
  });

  it.each(['average', 'min', 'max', 'sum', 'weighted_average'] as const)(
    'reports null for an all-scoreless panel under %s',
    method => {
      expect(aggregateScores(scoreless(3), method)).toBeNull();
    },
  );

  it('does not fabricate a zero for a single scoreless item', () => {
    // The one-item case is where a "just take the average" implementation divides by zero
    // and lands on NaN, which fail-opens for a different and much worse reason.
    const score = aggregateScores(scoreless(1));
    expect(score).toBeNull();
    expect(Number.isNaN(score as unknown as number)).toBe(false);
  });

  it('an all-generator panel PASSES a threshold gate instead of failing at 0', () => {
    expect(gateBlocks(aggregateScores(scoreless(4)), 80)).toBe(false);
  });

  it('a genuinely failing panel still BLOCKS — the negative control', () => {
    // Without this, "scoreless passes" would also pass for an implementation that had
    // stopped gating altogether, which is the failure mode the null is closest to.
    expect(gateBlocks(aggregateScores(items(10, 20)), 80)).toBe(true);
    expect(gateBlocks(aggregateScores(items(0, 0)), 80)).toBe(true);
    expect(aggregateScores(items(0, 0))).toBe(0);
  });

  it('a real 0 and an absent score are distinguishable in the output', () => {
    // The property the fabricated 0 destroyed: run data could not tell "every agent scored
    // zero" from "no agent scored". Both are legitimate; only one is a failure.
    expect(aggregateScores(items(0, 0, 0))).toBe(0);
    expect(aggregateScores(scoreless(3))).toBeNull();
    expect(aggregateScores(items(0, 0, 0))).not.toBe(aggregateScores(scoreless(3)));
  });

  it('one real score among scoreless items is reported alone, not averaged toward 0', () => {
    const mixed: ScoredItem[] = [...scoreless(3), { key: 'scored', score: 90 }];
    expect(aggregateScores(mixed, 'average')).toBe(90);
    expect(aggregateScores(mixed, 'min')).toBe(90);
  });
});
