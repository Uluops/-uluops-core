import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/ai/Semaphore.js';

describe('Semaphore', () => {
  it('never runs more than `permits` tasks concurrently', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });

    await Promise.all(Array.from({ length: 8 }, task));

    expect(maxActive).toBe(2);
    expect(active).toBe(0);
  });

  it('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);

    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    // If the permit leaked, this second task would hang forever.
    const result = await sem.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('queues callers beyond the permit count and drains them in order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const tasks = [1, 2, 3].map((n) =>
      sem.run(async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 2));
      }),
    );

    // Second and third are queued behind the first.
    expect(sem.pending).toBe(2);
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it('clamps non-positive permit counts to at least 1 (no deadlock)', async () => {
    const sem = new Semaphore(0);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });
});

/**
 * `Semaphore(NaN)` deadlocked permanently — and the constructor comment named that exact
 * failure while guarding only two of the three values that cause it.
 *
 * POSITIVE CONTROL: revert to `Math.max(1, Math.floor(permits))` and the first test TIMES
 * OUT rather than failing, which is itself the point — this defect has no error, no
 * rejection and no diagnostic. `Math.max(1, Math.floor(NaN))` is NaN, `acquire()`'s
 * `NaN > 0` is false, so every caller queues forever and the process never exits.
 *
 * Reachable from outside: `AIProvider` and `ResolvedConfig` are both exported and
 * `new Semaphore(config.maxConcurrency)` reads a public field.
 */
describe('Semaphore — a malformed permit count cannot deadlock the engine', () => {
  it.each([[NaN], [Infinity], [-1], [0]])('still runs work with permits=%s', async (bad) => {
    const s = new Semaphore(bad as number);
    expect(Number.isFinite(s.availablePermits)).toBe(true);
    expect(s.availablePermits).toBeGreaterThanOrEqual(1);

    // The measured defect was a HANG, so assert settlement, not just a value.
    await expect(Promise.race([
      s.run(async () => 'done'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlocked')), 2_000)),
    ])).resolves.toBe('done');
  }, 10_000);

  it('still LIMITS concurrency for a well-formed count — the negative control', async () => {
    // Without this, "never deadlocks" would pass for a semaphore that let everything
    // through, silently removing the throttle that stops fan-out x retry amplifying a
    // rate limit.
    const s = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => s.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight -= 1;
    })));
    expect(peak).toBeLessThanOrEqual(2);
  }, 10_000);
});
