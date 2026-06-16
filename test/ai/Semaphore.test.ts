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
