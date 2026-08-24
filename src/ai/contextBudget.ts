import { DEFAULT_CONTEXT_BUDGET } from '../constants.js';

export { DEFAULT_CONTEXT_BUDGET };

export interface DeriveContextBudgetInput {
  /**
   * The resolved model's real context window in tokens (registry `limits.context`).
   * Treat `0`, negative, or `undefined` as "unknown".
   */
  modelWindow?: number;
  /**
   * The operator-configured context budget, if explicitly set. `undefined` means
   * the operator did not set one (so we are free to use the model's full window).
   */
  operatorBudget?: number;
}

/**
 * Derive the effective context budget the engine should enforce its soft guards
 * against (80% wrap-up, 50% Anthropic eviction).
 *
 * Rule (agreed in Cluster A plan):
 *   1. Operator explicitly set a budget → it caps everything: min(operatorBudget, window).
 *      An operator budget can never exceed the model's physical window.
 *   2. No operator budget, window known → use the FULL window.
 *   3. Window unknown → fall back to DEFAULT_CONTEXT_BUDGET.
 *
 * This replaces the previous behavior where every guard was computed off a single
 * static 200k budget regardless of the model, which left sub-200k models with a
 * wrap-up guard sitting above their hard limit (run died on provider HTTP 400
 * instead of degrading gracefully).
 */
/** A budget is usable only if it is a finite, positive number. Absent, 0, negative, NaN
 *  and Infinity are all "no usable budget" — see deriveContextBudget for what each does
 *  when it slips through. */
function usableBudget(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function deriveContextBudget(input: DeriveContextBudgetInput): number {
  const window = usableBudget(input.modelWindow);

  // The operator budget is CONFIG — external input, same as a provider payload or an
  // authored weight — and it was passed through on a bare `!= null` check. Both unusable
  // values fail badly and neither announces itself:
  //
  //   budget 0   -> upperThreshold 0, so the wrap-up latch engages on step 1 and the
  //                 agent can never call a tool, while the run reports a
  //                 `budget.forced-wrap-up` marker and `partial` completeness — a
  //                 degradation that is real but whose stated cause is wrong.
  //   budget NaN -> every threshold comparison is false, so the brake is SILENTLY INERT
  //                 with no `markBrakeInert()` call. That is precisely the gap
  //                 `budget.brake-inert` was added to close, reopened one layer up:
  //                 types/degradation.ts invariant (1) is "nothing degrades silently".
  //
  // An unusable operator budget is treated as absent, so the derivation falls through to
  // the model window or the documented default — a working brake on a real number,
  // rather than a broken one on a meaningless configured value.
  const operator = usableBudget(input.operatorBudget);
  if (operator !== undefined) {
    return window ? Math.min(operator, window) : operator;
  }

  if (window) return window;

  return DEFAULT_CONTEXT_BUDGET;
}
