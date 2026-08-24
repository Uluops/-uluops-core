import { describe, it, expect } from 'vitest';
import { TokenBudgetTracker } from '../../src/ai/TokenBudgetTracker.js';

describe('TokenBudgetTracker', () => {
  it('tracks context window size from latest step input tokens', () => {
    const tracker = new TokenBudgetTracker(100_000);
    // Step 1: 5000 input (full context), 2000 output
    tracker.update(5000, 2000);
    // Step 2: 8000 input (full context grew), 1000 output
    tracker.update(8000, 1000);

    const status = tracker.getStatus();
    expect(status.budget).toBe(100_000);
    // usedInput = latest step's input (context window size)
    expect(status.usedInput).toBe(8000);
    // usedOutput = cumulative across all steps
    expect(status.usedOutput).toBe(3000);
    // usedTotal = context window size (what matters for the budget)
    expect(status.usedTotal).toBe(8000);
    expect(status.remaining).toBe(92000);
    expect(status.percentUsed).toBe(8);
  });

  it('replaces input on each update (not accumulates)', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.update(10_000, 500);
    tracker.update(15_000, 500);
    tracker.update(20_000, 500);

    const status = tracker.getStatus();
    expect(status.usedInput).toBe(20_000); // Latest, not 45_000
    expect(status.usedOutput).toBe(1500); // Cumulative
    expect(status.usedTotal).toBe(20_000);
  });

  it('reports 0% when budget is 0', () => {
    const tracker = new TokenBudgetTracker(0);
    const status = tracker.getStatus();
    expect(status.percentUsed).toBe(0);
    expect(status.remaining).toBe(0);
  });

  it('remaining never goes negative', () => {
    const tracker = new TokenBudgetTracker(1000);
    tracker.update(1200, 400);
    const status = tracker.getStatus();
    expect(status.remaining).toBe(0);
    expect(status.percentUsed).toBe(120);
  });

  it('isOverThreshold checks context size against budget', () => {
    const tracker = new TokenBudgetTracker(100_000);
    expect(tracker.isOverThreshold(0.80)).toBe(false);

    // Context window at 85K — over 80% threshold
    tracker.update(85_000, 1_000);
    expect(tracker.isOverThreshold(0.80)).toBe(true);
    expect(tracker.isOverThreshold(0.90)).toBe(false);
  });

  it('isOverThreshold returns true at exact boundary (>=, not >)', () => {
    const tracker = new TokenBudgetTracker(100_000);
    // Exactly 80,000 == 80% of 100,000 — should trigger (>=)
    tracker.update(80_000, 500);
    expect(tracker.isOverThreshold(0.80)).toBe(true);
  });

  it('isOverThreshold returns false just below boundary', () => {
    const tracker = new TokenBudgetTracker(100_000);
    // 79,999 < 80% of 100,000 — should NOT trigger
    tracker.update(79_999, 500);
    expect(tracker.isOverThreshold(0.80)).toBe(false);
  });

  it('isOverThreshold returns false when budget is 0', () => {
    const tracker = new TokenBudgetTracker(0);
    tracker.update(1000, 500);
    expect(tracker.isOverThreshold(0.80)).toBe(false);
  });

  it('initializes at zero usage', () => {
    const tracker = new TokenBudgetTracker(200_000);
    const status = tracker.getStatus();
    expect(status.usedTotal).toBe(0);
    expect(status.percentUsed).toBe(0);
    expect(status.remaining).toBe(200_000);
  });

  it('detects context eviction from a step-over-step window shrink', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.update(80_000, 500);
    tracker.update(120_000, 500);
    expect(tracker.contextEvicted).toBe(false);
    // Provider context management cleared old tool uses — window drops
    tracker.update(60_000, 500);
    expect(tracker.contextEvicted).toBe(true);
    expect(tracker.evictedTokens).toBe(60_000);
  });

  it('eviction flag is sticky and evicted tokens accumulate across evictions', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.update(100_000, 500);
    tracker.update(50_000, 500); // eviction 1: 50k dropped
    tracker.update(110_000, 500); // grows again
    tracker.update(70_000, 500); // eviction 2: 40k dropped
    expect(tracker.contextEvicted).toBe(true);
    expect(tracker.evictedTokens).toBe(90_000);
  });

  it('ignores small drops within token-accounting jitter tolerance', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.update(100_000, 500);
    // 4% drop — below the 5% eviction floor
    tracker.update(96_000, 500);
    expect(tracker.contextEvicted).toBe(false);
    expect(tracker.evictedTokens).toBe(0);
  });

  it('does not treat a missing usage reading (0 input tokens) as eviction', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.update(100_000, 500);
    // Step hook reports usage.inputTokens ?? 0 when the SDK omits usage
    tracker.update(0, 500);
    expect(tracker.contextEvicted).toBe(false);
  });

  it('does not flag eviction on the first step or normal growth', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.update(5_000, 500);
    tracker.update(30_000, 500);
    tracker.update(90_000, 500);
    expect(tracker.contextEvicted).toBe(false);
  });

  it('forcedWrapUp defaults to false and reflects the latest markForcedWrapUp', () => {
    const tracker = new TokenBudgetTracker(200_000);
    expect(tracker.forcedWrapUp).toBe(false);
    tracker.markForcedWrapUp(true);
    expect(tracker.forcedWrapUp).toBe(true);
    tracker.markForcedWrapUp(false); // released (hysteresis)
    expect(tracker.forcedWrapUp).toBe(false);
  });
});

/**
 * A library consumer is an external input source.
 *
 * POSITIVE CONTROL: revert the constructor to `constructor(private budget: number) {}` and
 * the malformed cases below fail — every guard reports as though the budget were fine.
 *
 * This class is exported from the package root, so `new TokenBudgetTracker(NaN)` is
 * reachable from outside. Two waivers in this file previously justified unguarded reads
 * with "deriveContextBudget rejects such budgets upstream" — true of the single in-package
 * call path, and false of the TYPE, which requires no such caller. The failure was silent
 * in the worst way: isOverThreshold() permanently false and markBrakeInert() unreachable,
 * so a run with no working cost ceiling reported no degradation at all.
 */
describe('TokenBudgetTracker — a malformed budget cannot silently disable the guards', () => {
  it.each([[NaN], [Infinity], [-Infinity], [-1000]])(
    'falls back to a usable budget for %s and warns', (bad) => {
      const warn = vi.fn();
      const tracker = new TokenBudgetTracker(bad as number, { debug() {}, info() {}, warn, error() {} });

      tracker.update(500_000, 1_000);
      // The guard must be able to fire at all — with NaN it never could.
      expect(Number.isFinite(tracker.getStatus().budget)).toBe(true);
      expect(tracker.getStatus().budget).toBeGreaterThan(0);
      expect(tracker.isOverThreshold(0.8)).toBe(true);
      // And nothing degrades silently.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('silently inert'));
    });

  it('PRESERVES a deliberate zero budget — the negative control', () => {
    // 0 means "no budget" and is a tested contract (percentUsed 0, remaining 0). It is NOT
    // malformed, and collapsing it into the fallback would replace a documented behaviour
    // with a guess — over-generalizing the class until it swallows an intentional case.
    const warn = vi.fn();
    const tracker = new TokenBudgetTracker(0, { debug() {}, info() {}, warn, error() {} });

    expect(tracker.getStatus().percentUsed).toBe(0);
    expect(tracker.getStatus().remaining).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a well-formed budget completely alone', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.update(50_000, 500);
    expect(tracker.getStatus().budget).toBe(100_000);
    expect(tracker.getStatus().usedTotal).toBe(50_000);
  });
});

/**
 * `update()` is a PUBLIC method on a root-exported class, and it was the constructor's
 * defect one method over.
 *
 * POSITIVE CONTROL: remove the `finiteNonNegative` guards from `update()` and these fail.
 *
 * Measured before the fix: `update(NaN, 10)` made usedTotal / remaining / percentUsed all
 * NaN — serializing to `null` — and `isOverThreshold` permanently false, so the brake was
 * unreachable and `markBrakeInert()` was never called, meaning NO marker. That is the
 * constructor's own documented failure mode, verbatim, on the adjacent entry point.
 *
 * It is not merely telemetry: `ToolAdapter` returns `getStatus()` to the MODEL as
 * `get_token_budget`, so the model would read `usedTotal: null` as a measurement.
 */
describe('TokenBudgetTracker.update — a malformed step cannot blind the guards', () => {
  it.each([[NaN], [Infinity], [-500]])('ignores a step reporting %s input tokens', (bad) => {
    const t = new TokenBudgetTracker(100_000);
    t.update(50_000, 1_000);          // a real measurement
    t.update(bad as number, 10);      // a malformed one

    // The last REAL measurement must stand — a step reporting nothing usable says nothing
    // about the window, and overwriting it with a fabricated value is the defect.
    expect(t.getStatus().usedTotal).toBe(50_000);
    expect(Number.isFinite(t.getStatus().percentUsed)).toBe(true);
    expect(Number.isNaN(t.getStatus().remaining)).toBe(false);
    // And what the MODEL is handed stays a measurement, not null.
    expect(JSON.stringify(t.getStatus())).not.toContain('null');
  });

  it('the threshold guard still fires after a malformed step', () => {
    // The consequence that mattered: NaN made isOverThreshold permanently false, so the
    // brake could never engage and markBrakeInert() was never reached — silent inertness.
    const t = new TokenBudgetTracker(100_000);
    t.update(90_000, 1_000);
    t.update(NaN, 1_000);
    expect(t.isOverThreshold(0.8)).toBe(true);
  });

  it('a genuine ZERO input step is still recorded — the negative control', () => {
    const t = new TokenBudgetTracker(100_000);
    t.update(50_000, 1_000);
    t.update(0, 10);
    expect(t.getStatus().usedTotal).toBe(0);
  });
});
