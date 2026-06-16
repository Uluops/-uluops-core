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
   * Record token usage from a completed step.
   *
   * @param inputTokens - Full context window size for the latest API call.
   *   This **replaces** the prior value (it is the total, not a delta), because
   *   it represents the whole input window the next call will carry.
   * @param outputTokens - Output tokens for this step; **accumulated** across steps.
   */
  update(inputTokens: number, outputTokens: number): void {
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
