/**
 * Tracks cumulative token usage across steps and provides budget status.
 *
 * Used by:
 * - ToolAdapter: exposes `get_token_budget` synthetic tool
 * - AIProvider: updated via `onStepFinish` callback
 * - AgentExecutor: passed `contextBudget` to configure the tracker
 */
export class TokenBudgetTracker {
  private usedInput = 0;
  private usedOutput = 0;

  constructor(private budget: number) {}

  /**
   * Record token usage from a completed step.
   */
  update(inputTokens: number, outputTokens: number): void {
    this.usedInput += inputTokens;
    this.usedOutput += outputTokens;
  }

  /**
   * Get current budget status for the LLM.
   */
  getStatus(): {
    budget: number;
    usedInput: number;
    usedOutput: number;
    usedTotal: number;
    remaining: number;
    percentUsed: number;
  } {
    const usedTotal = this.usedInput + this.usedOutput;
    const remaining = Math.max(0, this.budget - usedTotal);
    const percentUsed = this.budget > 0 ? Math.round((usedTotal / this.budget) * 100) : 0;

    return {
      budget: this.budget,
      usedInput: this.usedInput,
      usedOutput: this.usedOutput,
      usedTotal,
      remaining,
      percentUsed,
    };
  }

  /**
   * Check if usage has exceeded a threshold percentage.
   */
  isOverThreshold(threshold: number): boolean {
    const usedTotal = this.usedInput + this.usedOutput;
    return usedTotal >= this.budget * threshold;
  }
}
