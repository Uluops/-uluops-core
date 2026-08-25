import { describe, it, expect } from 'vitest';
import { clampModelBound, finitePositive, externalInt } from '../../src/utils/externalValue.js';

/**
 * The OPERATOR's bound is external data too.
 *
 * `clampModelBound` was written to stop a MODEL from raising a ceiling, and its docstring
 * records the measurement that motivated it: "a model sending `timeoutMs: 0` ran the full
 * 5,011 ms to completion and reported a clean `exitCode: 0`". The operator side of the same
 * helper was never guarded — and a `0` ceiling did not merely fail to bound, it collapsed
 * the range: `clampToRange(n, 1, 0)` is `Math.min(Math.max(n,1), 0)`, which is `0` for every
 * input. `exec({ timeout: 0 })` means no timeout at all, so a model-issued `npm run dev`
 * under a `shellTimeoutMs: 0` config ran unbounded with full host access.
 *
 * The `0` reaches it through `options?.shellTimeoutMs ?? SHELL_COMMAND_TIMEOUT_MS`, where
 * `??` preserves zero — the same absent-vs-zero conflation this release exists to correct,
 * on the one seam written to enforce the bound.
 *
 * POSITIVE CONTROL: remove the `if (max < min) return min` guard from `clampToRange` and
 * the inverted-range block fails; remove the `finitePositive(operatorDefault)` fallback
 * from `clampModelBound` and it fails too.
 */
describe('clampModelBound — an unusable operator ceiling cannot disable the bound', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('falls back to a real bound when the operator ceiling is %s', (_label, ceiling) => {
    const withValue = clampModelBound(5_000, ceiling as number);
    const withoutValue = clampModelBound(undefined, ceiling as number);

    // The specific failure: 0, meaning "run forever".
    expect(withValue).not.toBe(0);
    expect(withoutValue).not.toBe(0);
    // And a real, finite, positive bound — not Infinity, which is no bound wearing a number.
    for (const v of [withValue, withoutValue]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('still lets a model LOWER the ceiling and never raise it — the negative control', () => {
    // Without this, "unusable ceilings fall back" would also pass for an implementation
    // that had stopped clamping altogether, which is the failure in the other direction.
    expect(clampModelBound(5_000, 30_000)).toBe(5_000);   // model lowers: honoured
    expect(clampModelBound(99_999, 2_000)).toBe(2_000);   // model raises: refused
    expect(clampModelBound(undefined, 2_000)).toBe(2_000); // omitted: operator default
    // An UNUSABLE supplied value clamps to the FLOOR, not to the operator default. Pinned
    // here as the actual behaviour, because the helper's own prose and two sibling test
    // names in shellExecutor.bounds.test.ts say "falls back to the operator default"
    // instead — and StepsExecutor's 'timeout: 0 is still bounded' test requires the floor
    // reading (elapsed < 3,500 ms against a 4 s sleep, under a 60 s default). Whichever
    // reading wins, it must be one decision applied at both call sites; see the note on
    // clampModelBound. What is NOT in question is that both are bounded.
    expect(clampModelBound(0, 2_000)).toBe(1);
    expect(clampModelBound(-1, 2_000)).toBe(1);
    // NaN is not a finite integer, so it takes the fallback path — unlike 0 and -1.
    expect(clampModelBound(Number.NaN, 2_000)).toBe(2_000);
  });

  it('an inverted range resolves to the FLOOR, not the ceiling', () => {
    // The helper enforces a minimum; a nonsensical maximum must not be able to breach it.
    expect(externalInt(5_000, { min: 1, max: 0, fallback: 0 })).toBe(1);
    expect(externalInt(undefined, { min: 10, max: 5, fallback: 7 })).toBe(10);
    // Sane ranges are untouched.
    expect(externalInt(50, { min: 1, max: 100, fallback: 10 })).toBe(50);
  });
});

describe('finitePositive — the shared predicate behind the seams', () => {
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], ['5000'], [null], [undefined]])(
    'rejects %p', v => expect(finitePositive(v)).toBeUndefined(),
  );

  it('accepts genuine positive numbers — the negative control', () => {
    // Without this, "rejects the bad" is indistinguishable from "rejects everything".
    expect(finitePositive(1)).toBe(1);
    expect(finitePositive(30_000)).toBe(30_000);
    expect(finitePositive(0.5)).toBe(0.5);
  });
});
