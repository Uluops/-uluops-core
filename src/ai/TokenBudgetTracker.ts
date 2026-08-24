import type { Logger } from '@uluops/sdk-core';
import { finiteNonNegative } from '../utils/externalValue.js';
import { DEFAULT_CONTEXT_BUDGET } from '../constants.js';

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

  /**
   * @param budget context-token budget. Validated HERE, not assumed validated upstream.
   *
   * TokenBudgetTracker is exported from the package root, so a library consumer can
   * construct it directly and IS an external input source. Two waivers in this file
   * previously justified unguarded reads with "deriveContextBudget rejects such budgets
   * upstream" — true of the one in-package call path, and false of the type, which requires
   * no such caller. `new TokenBudgetTracker(NaN)` made `isOverThreshold()` permanently
   * false, `percentUsed` 0, and `markBrakeInert()` unreachable: a budget that silently does
   * not exist, which is precisely the "nothing degrades silently" invariant
   * `budget.brake-inert` was added to satisfy.
   *
   * An unusable budget falls back to the documented default rather than throwing: this is a
   * telemetry object, and failing a whole run because a cost ceiling was malformed trades a
   * reporting fault for an execution fault. The warning is how it stops being silent.
   */
  // EXTERNAL-OK: the constructor IS the seam for this channel — finiteNonNegative runs on the next line.
  constructor(budget: number, logger?: Logger) {
    // finiteNonNegative, NOT usableBudget — the distinction is load-bearing and tested.
    //
    // ZERO IS A DELIBERATE VALUE HERE ("no budget"), pinned by a test asserting
    // `percentUsed: 0, remaining: 0`. NaN/Infinity/negative are MALFORMED. Collapsing the
    // two would replace a documented contract with a fallback — the mirror image of the
    // defect this release is about: over-generalizing a class until it swallows an
    // intentional case. `deriveContextBudget` treats 0 as unusable because a zero
    // *derivation* has no threshold to compute; a zero tracker is just a tracker of zero.
    const usable = finiteNonNegative(budget);
    if (usable === undefined) {
      logger?.warn(
        `TokenBudgetTracker received a non-finite or negative budget (${String(budget)}); `
        + `falling back to ${DEFAULT_CONTEXT_BUDGET}. Every budget guard would otherwise be `
        + 'silently inert — isOverThreshold() permanently false and markBrakeInert() unreachable.',
      );
    }
    this.budget = usable ?? DEFAULT_CONTEXT_BUDGET;
  }

  private readonly budget: number;

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

  private brakeInertFlag = false;

  /**
   * Record that the budget threshold was crossed while the wrap-up brake COULD NOT act.
   *
   * Withdrawing the false `budget.forced-wrap-up` marker (0.42.0) was correct — the run
   * was reporting a wrap-up that never happened — but replacing a false claim with silence
   * trades one reporting defect for another. `types/degradation.ts` conditions the
   * PASS+partial decision on invariant (1), "every coverage reduction emits a marker;
   * nothing degrades silently", and a caller whose configured cost control provably did
   * not apply has something it needs to know.
   *
   * Severity is INFO, deliberately, and this is a judgment call worth naming: nothing was
   * cut short, so the run is genuinely `complete` and must not be downgraded to `partial`.
   * What failed is the caller's cost ceiling, not the agent's coverage. Marking it
   * `degraded` would re-introduce exactly the false `partial` that was just removed.
   */
  markBrakeInert(): void {
    this.brakeInertFlag = true;
  }

  /** Whether the budget threshold was crossed with the wrap-up brake unable to engage. */
  get brakeInert(): boolean {
    return this.brakeInertFlag;
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
    // Validated HERE, not only in the constructor. This is a PUBLIC method on a
    // root-exported class taking raw numbers, and it is the constructor's defect one method
    // over: measured, `update(NaN, 10)` made usedTotal/remaining/percentUsed all NaN
    // (serializing to null) and `isOverThreshold` permanently false — so the brake became
    // unreachable and `markBrakeInert()` was never called, meaning NO marker. That is the
    // constructor's own documented failure mode, verbatim, on the adjacent entry point.
    //
    // It is also not merely telemetry: ToolAdapter returns `getStatus()` to the MODEL as
    // `get_token_budget`, so the model would read `usedTotal: null` as a measurement.
    //
    // Unusable values are DROPPED rather than coerced: a step that reports no usable count
    // says nothing about the window, and overwriting the last real measurement with a
    // fabricated one is the defect, not the fix.
    const usableInput = finiteNonNegative(inputTokens);
    const usableOutput = finiteNonNegative(outputTokens);
    if (usableInput === undefined) return;
    inputTokens = usableInput;
    outputTokens = usableOutput ?? 0;

    // A conversation only grows; a real step-over-step shrink means content was
    // removed from the window (provider-side context eviction). Detect it here
    // rather than in the provider because inputTokens is the only signal the AI
    // SDK step hook exposes uniformly.
    const drop = this.currentContextTokens - inputTokens;
    if (
      // FABRICATION-OK: "is there a PRIOR measurement to compare against" — a zero previous window
      // means no baseline, not a measured zero.
      this.currentContextTokens > 0 &&
      // FABRICATION-OK: asks whether there IS a measurement, not what it is — a zero window gives no
      // delta to compare against.
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
    // FABRICATION-OK: division guard. A zero budget cannot yield a percentage and 0 is the
    // only non-NaN answer.
    //
    // The previous reason added "and deriveContextBudget rejects a zero budget upstream",
    // which is FALSE of this class: the constructor deliberately PRESERVES a budget of 0 as
    // a tested contract meaning "no budget". The guard was right and its justification cited
    // a rejection this class goes out of its way not to perform.
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
    // FABRICATION-OK: a non-positive budget has no threshold to be over, so false is the
    // only meaningful answer.
    //
    // NOT because "deriveContextBudget rejects such budgets upstream" — that was the old
    // reason and it is false of a class that deliberately supports budget 0. Note the real
    // consequence, which the old reason obscured: with budget 0 this returns false forever,
    // so the brake never engages and `markBrakeInert()` is never called. A caller who
    // passes 0 gets a silently inert budget with no marker. That is a genuine gap in the
    // "nothing degrades silently" invariant and is recorded here rather than papered over.
    return this.budget > 0 && this.currentContextTokens >= this.budget * threshold;
  }
}
