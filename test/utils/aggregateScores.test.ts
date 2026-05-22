import { describe, it, expect } from 'vitest';
import { aggregateScores, type ScoredItem } from '../../src/utils/aggregateScores.js';

function items(...scores: number[]): ScoredItem[] {
  return scores.map((score, i) => ({ key: `k${i}`, score }));
}

describe('aggregateScores', () => {
  it('returns 0 for empty items', () => {
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

    it('returns 0 when all items have null scores', () => {
      const scored: ScoredItem[] = [
        { key: 'a', score: null },
        { key: 'b', score: null },
      ];
      expect(aggregateScores(scored, 'average')).toBe(0);
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
