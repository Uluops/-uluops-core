import { describe, it, expect } from 'vitest';
import { topoGroupLevels } from '../../src/utils/topoSort.js';

interface TestPhase {
  id: string;
  depends_on?: string[];
}

describe('topoGroupLevels', () => {
  it('returns empty array for empty input', () => {
    expect(topoGroupLevels([])).toEqual([]);
  });

  it('puts all independent phases in level 0', () => {
    const phases: TestPhase[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const levels = topoGroupLevels(phases);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.map(p => p.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('creates sequential levels for linear dependencies', () => {
    const phases: TestPhase[] = [
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['b'] },
    ];
    const levels = topoGroupLevels(phases);
    expect(levels).toHaveLength(3);
    expect(levels[0]!.map(p => p.id)).toEqual(['a']);
    expect(levels[1]!.map(p => p.id)).toEqual(['b']);
    expect(levels[2]!.map(p => p.id)).toEqual(['c']);
  });

  it('groups independent phases into same level', () => {
    // Diamond: a -> b,c -> d
    const phases: TestPhase[] = [
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a'] },
      { id: 'd', depends_on: ['b', 'c'] },
    ];
    const levels = topoGroupLevels(phases);
    expect(levels).toHaveLength(3);
    expect(levels[0]!.map(p => p.id)).toEqual(['a']);
    expect(levels[1]!.map(p => p.id).sort()).toEqual(['b', 'c']);
    expect(levels[2]!.map(p => p.id)).toEqual(['d']);
  });

  it('throws on cycle', () => {
    const phases: TestPhase[] = [
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: ['a'] },
    ];
    expect(() => topoGroupLevels(phases)).toThrow('Cycle detected');
  });

  it('throws on missing dependency', () => {
    const phases: TestPhase[] = [
      { id: 'a', depends_on: ['nonexistent'] },
    ];
    expect(() => topoGroupLevels(phases)).toThrow('does not exist');
  });

  it('handles complex DAG with mixed independent and dependent phases', () => {
    // a,b independent; c depends on a; d depends on b; e depends on c,d
    const phases: TestPhase[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c', depends_on: ['a'] },
      { id: 'd', depends_on: ['b'] },
      { id: 'e', depends_on: ['c', 'd'] },
    ];
    const levels = topoGroupLevels(phases);
    expect(levels).toHaveLength(3);
    expect(levels[0]!.map(p => p.id).sort()).toEqual(['a', 'b']);
    expect(levels[1]!.map(p => p.id).sort()).toEqual(['c', 'd']);
    expect(levels[2]!.map(p => p.id)).toEqual(['e']);
  });

  it('does not place a phase until ALL dependencies are satisfied (catches every→some mutation)', () => {
    // Phase 'd' depends on both 'b' and 'c'. If deps.every() were mutated to
    // deps.some(), 'd' would be placed as soon as either 'b' or 'c' is placed
    // (level 1) instead of waiting for both (level 2).
    const phases: TestPhase[] = [
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a'] },
      { id: 'd', depends_on: ['b', 'c'] },
    ];
    const levels = topoGroupLevels(phases);

    // 'd' must NOT be in level 1 — it requires both 'b' and 'c'
    const level1Ids = levels[1]!.map(p => p.id);
    expect(level1Ids).not.toContain('d');

    // 'd' must be in level 2
    const level2Ids = levels[2]!.map(p => p.id);
    expect(level2Ids).toContain('d');
  });

  it('detects three-node cycle', () => {
    const phases: TestPhase[] = [
      { id: 'a', depends_on: ['c'] },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['b'] },
    ];
    expect(() => topoGroupLevels(phases)).toThrow('Cycle detected');
    expect(() => topoGroupLevels(phases)).toThrow('a, b, c');
  });
});
