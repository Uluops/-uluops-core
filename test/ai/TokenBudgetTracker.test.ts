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

  it('initializes at zero usage', () => {
    const tracker = new TokenBudgetTracker(200_000);
    const status = tracker.getStatus();
    expect(status.usedTotal).toBe(0);
    expect(status.percentUsed).toBe(0);
    expect(status.remaining).toBe(200_000);
  });
});
