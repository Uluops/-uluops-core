/**
 * Minimal async counting semaphore — no external dependency.
 *
 * Bounds the number of concurrently-running async tasks. Used by AIProvider to
 * cap total in-flight LLM generation calls across the whole engine, regardless
 * of how many workflow phases, parallel steps, or inline pipeline agents fan
 * out at once. This prevents unbounded fan-out × per-request retry from
 * amplifying a provider rate limit (the protective retry inverting into the
 * dominant stressor).
 *
 * Permits are handed off directly from `release()` to the next waiter so the
 * available count never transiently overshoots the configured limit.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    // Always allow at least one in-flight call; a zero/negative limit would deadlock.
    this.available = Math.max(1, Math.floor(permits));
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
