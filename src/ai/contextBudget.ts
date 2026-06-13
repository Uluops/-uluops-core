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
export function deriveContextBudget(input: DeriveContextBudgetInput): number {
  const window = input.modelWindow && input.modelWindow > 0 ? input.modelWindow : undefined;

  if (input.operatorBudget != null) {
    return window ? Math.min(input.operatorBudget, window) : input.operatorBudget;
  }

  if (window) return window;

  return DEFAULT_CONTEXT_BUDGET;
}
