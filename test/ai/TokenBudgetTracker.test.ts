import { describe, it, expect } from 'vitest';
import { TokenBudgetTracker } from '../../src/ai/TokenBudgetTracker.js';

describe('TokenBudgetTracker', () => {
  it('tracks cumulative token usage', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.update(5000, 2000);
    tracker.update(3000, 1000);

    const status = tracker.getStatus();
    expect(status.budget).toBe(100_000);
    expect(status.usedInput).toBe(8000);
    expect(status.usedOutput).toBe(3000);
    expect(status.usedTotal).toBe(11000);
    expect(status.remaining).toBe(89000);
    expect(status.percentUsed).toBe(11);
  });

  it('reports 0% when budget is 0', () => {
    const tracker = new TokenBudgetTracker(0);
    const status = tracker.getStatus();
    expect(status.percentUsed).toBe(0);
    expect(status.remaining).toBe(0);
  });

  it('remaining never goes negative', () => {
    const tracker = new TokenBudgetTracker(1000);
    tracker.update(800, 400);
    const status = tracker.getStatus();
    expect(status.remaining).toBe(0);
    expect(status.percentUsed).toBe(120);
  });

  it('isOverThreshold checks correctly', () => {
    const tracker = new TokenBudgetTracker(100_000);
    expect(tracker.isOverThreshold(0.80)).toBe(false);

    tracker.update(70_000, 11_000);
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
