/**
 * Tracks context window usage across steps and provides budget status.
 *
 * Each step's `inputTokens` from the AI SDK represents the TOTAL input tokens
 * for that API call (including all previous conversation + cached tokens).
 * This means the last step's `inputTokens` IS the current context window size.
 * We replace (not accumulate) the input value on each update.
 *
 * Output tokens are incremental per step and accumulated normally.
 *
 * Used by:
 * - ToolAdapter: exposes `get_token_budget` synthetic tool
 * - AIProvider: updated via `onStepFinish` callback
 * - AgentExecutor: passed `contextBudget` to configure the tracker
 */
export class TokenBudgetTracker {
  /** Current context window size (last step's total input tokens) */
  private currentContextTokens = 0;
  /** Cumulative output tokens across all steps */
  private cumulativeOutput = 0;
  /** Whether the context-budget wrap-up latch is currently engaged. */
  private forcedWrapUpFlag = false;
  /** Whether a context eviction (step-over-step window shrink) was observed. Sticky. */
  private contextEvictedFlag = false;
  /** Total tokens observed dropped across all detected evictions. */
  private evictedTokensTotal = 0;

  /**
   * Minimum step-over-step context shrink treated as an eviction, as a fraction
   * of the previous window. The conversation only grows (messages append), so a
   * genuine drop means content was removed — in practice Anthropic context
   * management clearing old tool uses at its 50%-of-budget trigger, which drops
   * whole tool results at once. The tolerance exists only to absorb provider
   * token-accounting jitter between calls, not to classify small evictions.
   */
  private static readonly EVICTION_DROP_FRACTION = 0.05;

  constructor(private budget: number) {}

  /**
   * Record the final state of the budget wrap-up latch. Set when the latch
   * engages (≥80% of budget) and cleared when it releases (<70%, hysteresis),
   * so the value reflects whether the run *ended* in forced wrap-up — a run
   * that latched then recovered is not left flagged. Read by AgentExecutor to
   * emit a `budget.forced-wrap-up` degradation marker.
   *
   * @param engaged - `true` if the wrap-up latch is currently engaged, `false` if released.
   */
  markForcedWrapUp(engaged: boolean): void {
    this.forcedWrapUpFlag = engaged;
  }

  /** Whether the wrap-up latch was engaged at the end of the run. */
  get forcedWrapUp(): boolean {
    return this.forcedWrapUpFlag;
  }

  /**
   * Whether a context eviction was observed at any point in the run. Unlike the
   * wrap-up latch this is sticky: evicted tool results are gone for the rest of
   * the run, so there is no "recovered" state. Read by AgentExecutor to emit a
   * `context.evicted` degradation marker — without it, coverage loss below the
   * wrap-up latch would report completeness 'complete' (issue fdaa0b24).
   */
  get contextEvicted(): boolean {
    return this.contextEvictedFlag;
  }

  /** Total tokens dropped across detected evictions (detail for the marker). */
  get evictedTokens(): number {
    return this.evictedTokensTotal;
  }

  /**
   * Record token usage from a completed step.
   *
   * @param inputTokens - Full context window size for the latest API call.
   *   This **replaces** the prior value (it is the total, not a delta), because
   *   it represents the whole input window the next call will carry.
   * @param outputTokens - Output tokens for this step; **accumulated** across steps.
   */
  update(inputTokens: number, outputTokens: number): void {
    // A conversation only grows; a real step-over-step shrink means content was
    // removed from the window (provider-side context eviction). Detect it here
    // rather than in the provider because inputTokens is the only signal the AI
    // SDK step hook exposes uniformly.
    const drop = this.currentContextTokens - inputTokens;
    if (
      this.currentContextTokens > 0 &&
      inputTokens > 0 &&
      drop > this.currentContextTokens * TokenBudgetTracker.EVICTION_DROP_FRACTION
    ) {
      this.contextEvictedFlag = true;
      this.evictedTokensTotal += drop;
    }
    this.currentContextTokens = inputTokens;
    this.cumulativeOutput += outputTokens;
  }

  /**
   * Get current budget status for the LLM.
   *
   * `usedTotal` represents the current context window size, which is
   * what determines whether we'll hit the model's context limit.
   */
  getStatus(): {
    budget: number;
    usedInput: number;
    usedOutput: number;
    usedTotal: number;
    remaining: number;
    percentUsed: number;
  } {
    const usedTotal = this.currentContextTokens;
    const remaining = Math.max(0, this.budget - usedTotal);
    const percentUsed = this.budget > 0 ? Math.round((usedTotal / this.budget) * 100) : 0;

    return {
      budget: this.budget,
      usedInput: this.currentContextTokens,
      usedOutput: this.cumulativeOutput,
      usedTotal,
      remaining,
      percentUsed,
    };
  }

  /**
   * Check if context window usage has exceeded a threshold percentage.
   */
  isOverThreshold(threshold: number): boolean {
    return this.budget > 0 && this.currentContextTokens >= this.budget * threshold;
  }
}
