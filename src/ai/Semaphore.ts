import { finitePositive } from '../utils/externalValue.js';
import { DEFAULT_MAX_CONCURRENCY } from '../constants.js';
/**
 * Minimal async counting semaphore — no external dependency.
 *
 * Bounds the number of concurrently-running async tasks. Used by AIProvider to
 * cap total in-flight LLM generation calls for ONE AIProvider instance,
 * regardless of how many workflow phases, parallel steps, or inline pipeline
 * agents fan out at once within that instance. This prevents unbounded
 * fan-out × per-request retry from amplifying a provider rate limit (the
 * protective retry inverting into the dominant stressor). The bound is per
 * instance, not per process — see AIProvider.concurrencyLimiter.
 *
 * Permits are handed off directly from `release()` to the next waiter so the
 * available count never transiently overshoots the configured limit.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    // Always allow at least one in-flight call; a zero/negative limit would deadlock.
    //
    // NaN was the third value, and it produced EXACTLY the deadlock this comment names.
    // `Math.max(1, Math.floor(NaN))` is NaN, `acquire()`'s `NaN > 0` is false, so every
    // caller queues forever. Measured: availablePermits NaN, run() never settles, pending 1.
    // Not a rejection — a HANG: no error, no timeout, no diagnostic, the process never
    // exits. Reachable from outside, since AIProvider and ResolvedConfig are both exported
    // and `new Semaphore(config.maxConcurrency)` reads a public field.
    //
    // The guard covered the two values someone thought of and missed the one that had the
    // worst failure mode, which is this release's whole subject.
    this.available = Math.max(1, Math.floor(finitePositive(permits) ?? DEFAULT_MAX_CONCURRENCY));
  }

  /** Number of permits not currently held. Primarily for tests/diagnostics. */
  get availablePermits(): number {
    return this.available;
  }

  /** Number of callers currently waiting for a permit. Primarily for tests/diagnostics. */
  get pending(): number {
    return this.queue.length;
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the permit straight to the next waiter — do not bump `available`.
      next();
    } else {
      this.available++;
    }
  }

  /**
   * Acquire a permit, run `fn`, and release the permit even if `fn` throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
