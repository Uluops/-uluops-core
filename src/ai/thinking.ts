/**
 * Extended thinking: capability, opt-in policy, per-provider gate, and the run-condition record
 * (thinking-capability-restore spec v0.7.0, §3, §5.2, §6, §7.3).
 *
 * Two independent predicates replace the single capability read every gate used to make:
 * {@link canThink} (can the model think — a model fact) and the resolved opt-in (did the operator ask
 * — policy, default off). A gate fires only when both hold, the provider has a mapping, and the
 * caller did not supply its own provider-native block. The run records what was requested, what was
 * applied, and why not when it was not: requested is not applied.
 *
 * This module holds policy and arithmetic only. It imports types, never executors or clients, so the
 * builders in AIProvider gain call sites, not policy.
 */
import type { ResolvedModel } from './ModelCatalog.js';
import type { RunConditions, ThinkingNotAppliedReason } from '../types/agent.js';
import { finitePositive } from '../utils/externalValue.js';

/** The client-level switch. `'declared'` (honour the agent's own preference) is deferred (OD-18). */
export type ThinkingMode = 'off' | 'on';

/** Anthropic requires `budget_tokens >= 1024`; Google and OpenRouter share the floor (§6.2, §6.4). */
export const MIN_THINKING_BUDGET = 1024;

/**
 * Providers with a thinking mapping in this release (OD-12, OD-13). Direct Anthropic is mapped in
 * 0.52.0 together with the structured-output degrade; until then an opt-in there records
 * `'no-mapping'`, like any provider without a mapping.
 */
export const MAPPED_THINKING_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'google', 'openrouter']);

/** Anthropic beta that lets Claude think between tool calls, not only on the first step (OD-22, probes P6D-P6H). */
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

/**
 * Can this model think? Reads the normalized capability (`reasoning`, with its deprecated alias
 * `extendedThinking`) and falls back to the registry tier, as `isReasoning` always did — so the
 * temperature strip keyed to it covers exactly the rows it covered before (Step 0 id-set check:
 * capability − tier = ∅, 2026-10-08).
 */
export function canThink(resolved: Pick<ResolvedModel, 'capabilities' | 'tier'>): boolean {
  const caps = resolved.capabilities as { reasoning?: unknown; extendedThinking?: unknown };
  return caps.reasoning === true || caps.extendedThinking === true || resolved.tier === 'reasoning';
}

/** `'on'`/`'off'`, case and surrounding space ignored; anything else (booleans included) is undefined. */
export function thinkingModeValue(value: unknown): ThinkingMode | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : undefined;
}

/**
 * Resolve the client mode from config, then env. The first layer that SET a value decides; unset is
 * `undefined`, `null` or a blank string. A malformed value is `'off'` at the layer that set it and
 * does not fall through (OD-6, D7's rule) — and is reported back so the caller can warn where a
 * logger exists (`resolveAIConfig` has none).
 */
export function resolveThinkingMode(configValue: unknown, envValue: unknown): {
  mode: ThinkingMode;
  source: 'config' | 'env' | 'default';
  malformed?: { layer: 'config' | 'env'; value: string };
} {
  const layers = [['config', configValue], ['env', envValue]] as const;
  for (const [layer, raw] of layers) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue;
    const mode = thinkingModeValue(raw);
    return mode !== undefined
      ? { mode, source: layer }
      : { mode: 'off', source: layer, malformed: { layer, value: String(raw).slice(0, 40) } };
  }
  return { mode: 'off', source: 'default' };
}

/**
 * The per-run layer (`ExecutionOptions.extendedThinking` on `runAgent`) is a boolean. Anything else
 * that is set — the string `"false"` is the dangerous one — is off at this layer, flagged so the
 * caller warns, and does not fall through to config (OD-6).
 */
export function perRunThinking(value: unknown): { set: false } | { set: true; value: boolean; malformed: boolean } {
  if (value === undefined || value === null) return { set: false };
  return typeof value === 'boolean'
    ? { set: true, value, malformed: false }
    : { set: true, value: false, malformed: true };
}

/** Inputs to the per-provider gate. `maxTokens` must already be seamed (a finite positive integer). */
export interface ThinkingGateInput {
  requested: boolean;
  provider: string;
  /** Provider-side model id — for OpenRouter, `anthropic/…` marks the probed upstream (§6.4). */
  providerModelId: string;
  capable: boolean;
  /** The caller's own provider-native thinking block is present (it always wins, §5.2). */
  callerNative: boolean;
  /** …and that block explicitly turns thinking OFF ({@link nativeThinkingDisabled}). */
  callerNativeOff?: boolean;
  /** `config.defaultThinkingBudget`, raw. */
  budget: unknown;
  maxTokens: number;
  /** Registry `limits.output`; undefined = unknown. */
  maxOutputTokens?: number;
}

/** What the gate decided. The builders emit exactly this; nothing else decides. */
export type ThinkingPlan =
  | { applied: false; reason: ThinkingNotAppliedReason; native?: true }
  | { applied: true; native: true }
  | { applied: true; native: false; kind: 'effort' }
  | {
      applied: true;
      native: false;
      kind: 'budget';
      budget: number;
      /** OpenRouter only: the `max_tokens` to send instead of `maxTokens`, when it differs. */
      maxOutputTokens?: number;
      /** OpenRouter `anthropic/` upstream: send the interleaved-thinking beta (OD-22). */
      interleaved?: boolean;
      /** The budget was lowered so the answer keeps at least half of `maxTokens` (logged once, §6.2/§6.4). */
      capped?: boolean;
    };

/** OpenRouter upstream ids covered by the Phase 0 probes (P4, P6F): the `max_tokens` rule and the beta apply only there. */
export function isOpenRouterAnthropic(providerModelId: string): boolean {
  return providerModelId.startsWith('anthropic/');
}

/**
 * The per-provider gate (§5.2 step 4, §6). Reasons are single-valued and the first that applies
 * wins: not-requested → not-capable → no-mapping → invalid-budget. A caller-native block is checked
 * first and recorded as applied with source `'native'` — the request carried thinking whoever put it
 * there (§7.3); it bypasses core's caps, and the record says so by its source.
 */
export function planThinking(input: ThinkingGateInput): ThinkingPlan {
  // A native block that turns thinking off is recorded as off, not as "applied" — the record must not
  // say thinking was on for a run whose caller disabled it (core 0.51.0 review: P2, F4).
  if (input.callerNative && input.callerNativeOff) return { applied: false, reason: 'caller-native', native: true };
  if (input.callerNative) return { applied: true, native: true };
  if (!input.requested) return { applied: false, reason: 'not-requested' };
  if (!input.capable) return { applied: false, reason: 'not-capable' };
  if (!MAPPED_THINKING_PROVIDERS.has(input.provider)) return { applied: false, reason: 'no-mapping' };

  // OpenAI takes an effort, not a budget (§6.3): core sends 'medium' and ignores the budget.
  if (input.provider === 'openai') return { applied: true, native: false, kind: 'effort' };

  const budget = finitePositive(input.budget);
  if (budget === undefined) return { applied: false, reason: 'invalid-budget' };
  const whole = Math.floor(budget);

  if (input.provider === 'google') {
    // Google counts thinking inside maxOutputTokens (probe P5: budget >= cap left 30 visible tokens).
    // Cap at half the allowance so the answer keeps at least half; below the floor, send nothing —
    // never a capped 0, which some Gemini models read as "thinking off".
    const cap = Math.floor(input.maxTokens / 2);
    const sent = Math.min(whole, cap);
    if (sent < MIN_THINKING_BUDGET) return { applied: false, reason: 'invalid-budget' };
    return { applied: true, native: false, kind: 'budget', budget: sent, ...(sent < whole ? { capped: true } : {}) };
  }

  // OpenRouter counts the budget inside max_tokens (probe P4), and a budget >= max_tokens is not
  // rejected — OpenRouter silently raises the cap to budget + 1 and bills past it. So on the probed
  // upstream, raise max_tokens by the budget (capped at the model's output limit) to keep the visible
  // allowance the direct route gives. On EVERY upstream the answer keeps at least half the caller's
  // allowance (OD-25): budget <= sent max_tokens − ceil(maxTokens / 2). Off anthropic/ that is Google's
  // half-cap; on an uncapped anthropic/ raise it never binds; when the model limit caps the raise it
  // shrinks the budget instead of the answer (core 0.51.0 review: code-auditor, P7/P9, F1).
  const anthropicUpstream = isOpenRouterAnthropic(input.providerModelId);
  const raised = input.maxTokens + whole;
  const sentMax = anthropicUpstream
    ? (input.maxOutputTokens !== undefined ? Math.min(raised, input.maxOutputTokens) : raised)
    : input.maxTokens;
  const sent = Math.min(whole, sentMax - Math.ceil(input.maxTokens / 2));
  if (sent < MIN_THINKING_BUDGET) return { applied: false, reason: 'invalid-budget' };
  return {
    applied: true,
    native: false,
    kind: 'budget',
    budget: sent,
    ...(sentMax !== input.maxTokens ? { maxOutputTokens: sentMax } : {}),
    ...(anthropicUpstream ? { interleaved: true } : {}),
    ...(sent < whole ? { capped: true } : {}),
  };
}

/**
 * Did the caller supply its own provider-native thinking option? It always wins (§5.2), so the gate
 * records it as native instead of emitting its own. Keys are the ones each builder used to check.
 */
export function hasNativeThinking(provider: string, providerOptions: unknown): boolean {
  if (typeof providerOptions !== 'object' || providerOptions === null) return false;
  const block = (providerOptions as Record<string, unknown>)[provider];
  if (typeof block !== 'object' || block === null) return false;
  const b = block as Record<string, unknown>;
  switch (provider) {
    case 'anthropic': return 'thinking' in b;
    case 'openai': return 'reasoningEffort' in b;
    case 'google': return 'thinkingConfig' in b;
    // `reasoning: null` counts as unset, as it always did in the OpenRouter builder.
    case 'openrouter': return b['reasoning'] != null;
    default: return false;
  }
}

/**
 * Does the caller's native block explicitly turn thinking OFF? The explicit-off shapes each provider
 * documents; anything else present is treated as "on" (the caller asked for some thinking shape).
 * `reasoningEffort: 'minimal'` is NOT off — gpt-5 still reasons at minimal.
 */
export function nativeThinkingDisabled(provider: string, providerOptions: unknown): boolean {
  if (!hasNativeThinking(provider, providerOptions)) return false;
  const b = (providerOptions as Record<string, Record<string, unknown>>)[provider]!;
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});
  switch (provider) {
    case 'anthropic': return obj(b['thinking'])['type'] === 'disabled';
    case 'openai': return b['reasoningEffort'] === 'none';
    case 'google': return obj(b['thinkingConfig'])['thinkingBudget'] === 0;
    case 'openrouter': {
      const r = obj(b['reasoning']);
      return r['enabled'] === false || r['effort'] === 'none' || r['max_tokens'] === 0;
    }
    default: return false;
  }
}

/** The request-level parts of a plan that are not provider options: OpenRouter's raised max_tokens and the beta header. */
export function thinkingRequestShape(plan: ThinkingPlan): { maxOutputTokens?: number; headers?: Record<string, string> } {
  if (!plan.applied || plan.native || plan.kind !== 'budget') return {};
  return {
    ...(plan.maxOutputTokens !== undefined ? { maxOutputTokens: plan.maxOutputTokens } : {}),
    ...(plan.interleaved ? { headers: { 'x-anthropic-beta': INTERLEAVED_THINKING_BETA } } : {}),

  };
}

/** What `AIProvider` reports for one generation — on the result, and on any error it throws after the gate ran. */
export interface ThinkingOutcome {
  applied: boolean;
  notAppliedReason?: ThinkingNotAppliedReason;
  /** The request carried the caller's own provider-native thinking block. */
  native?: boolean;
  /** The budget core sent; absent for effort/adaptive shapes and when nothing was sent. */
  budget?: number;
  interleaved?: boolean;
  /** The max_tokens core actually sent when it raised it for thinking (OpenRouter `anthropic/`). */
  maxTokensSent?: number;
  structuredOutputDegraded?: 'thinking';
}

/** The plan, as the outcome a builder reports back. */
export function outcomeOf(plan: ThinkingPlan): ThinkingOutcome {
  if (!plan.applied) return { applied: false, notAppliedReason: plan.reason, ...(plan.native ? { native: true } : {}) };
  if (plan.native) return { applied: true, native: true };
  return {
    applied: true,
    ...(plan.kind === 'budget' ? { budget: plan.budget } : {}),
    ...(plan.kind === 'budget' && plan.interleaved ? { interleaved: true } : {}),
  };
}

/**
 * Claude ids that think whatever is sent — the provider's `rejectsThinkingDisabled` flag
 * (`@ai-sdk/anthropic` 3.0.127 dist, its own model table; re-check on every pin bump).
 */
const ALWAYS_THINKING_CLAUDE = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5'];
/** Upstreams whose reasoning-capable models reason with nothing sent: OpenAI gpt-5.x (probe P7), Gemini 2.5, DeepSeek and xAI reasoners. */
const DEFAULT_REASONING_UPSTREAMS: ReadonlySet<string> = new Set(['openai', 'google', 'deepseek', 'xai', 'x-ai']);

/**
 * Does this model reason when core sends nothing? Drives `offMeans: 'provider-default'` (OD-3(b)), so
 * a run with thinking not applied on such a model is not read as "no thinking". A coarse, documented
 * heuristic — by upstream, plus the always-thinking Claude ids — not a measurement; the measurement
 * is `thinkingObserved`.
 */
export function reasonsByDefault(resolved: Pick<ResolvedModel, 'capabilities' | 'tier' | 'provider' | 'providerModelId'>): boolean {
  if (!canThink(resolved)) return false;
  const routed = resolved.provider === 'openrouter';
  const upstream = routed ? resolved.providerModelId.split('/')[0] ?? '' : resolved.provider;
  const model = (routed ? resolved.providerModelId.slice(upstream.length + 1) : resolved.providerModelId).replace(/\./g, '-');
  if (upstream === 'anthropic') return ALWAYS_THINKING_CLAUDE.some(id => model.startsWith(id));
  return DEFAULT_REASONING_UPSTREAMS.has(upstream);
}

// ── Thrown-path carrier (§3 items 1-4) ───────────────────────────────────────────────────────────

/**
 * String key, not a Symbol: a second copy of core in one dependency tree must still read what the
 * first wrote (the `hasBilledMetrics` reasoning, errors/index.ts). The brand makes a foreign error
 * that happens to carry an unrelated `thinking` property read as `undefined`.
 */
const CARRIER_KEY = 'thinking';
const CARRIER_BRAND = 'uluops.thinking/1';

/** What travels on a thrown error: the provider's outcome and, once AgentExecutor has seen it, the full run conditions. */
export interface ThinkingCarrier extends ThinkingOutcome {
  runConditions?: RunConditions;
}

const REASONS: ReadonlySet<string> = new Set<ThinkingNotAppliedReason>([
  'caller-native', 'not-requested', 'not-capable', 'no-mapping', 'invalid-budget', 'pre-build-failure',
]);

/**
 * Attach `carrier` to `error` as a non-enumerable property. Never throws and never replaces the
 * error: a primitive, a frozen or non-extensible object, or a property that refuses redefinition all
 * leave the original to propagate without a carrier (`ensureProvider` can rethrow an arbitrary value).
 */
export function attachThinking(error: unknown, carrier: ThinkingCarrier): void {
  if (typeof error !== 'object' || error === null || !Object.isExtensible(error)) return;
  // Never overwrite a foreign `thinking` property: only core's own (branded) carrier is replaced.
  if (Object.prototype.hasOwnProperty.call(error, CARRIER_KEY) && thinkingOutcomeOf(error) === undefined) return;
  try {
    Object.defineProperty(error, CARRIER_KEY, {
      value: { ...carrier, brand: CARRIER_BRAND },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // AUDIT-OK(no_empty_catch): the attach is best-effort by contract — a proxy or an exotic object that
    // refuses the define leaves the original error to propagate without a carrier, never a new error.
  }
}

/** The carrier on a thrown error, or undefined. Validates the shape, not mere presence. */
export function thinkingOutcomeOf(error: unknown): ThinkingCarrier | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  let value: unknown;
  try {
    value = (error as Record<string, unknown>)[CARRIER_KEY];
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v['brand'] !== CARRIER_BRAND || typeof v['applied'] !== 'boolean') return undefined;
  if (v['notAppliedReason'] !== undefined && !REASONS.has(v['notAppliedReason'] as string)) return undefined;
  const carrier: Record<string, unknown> = { ...v };
  delete carrier['brand'];
  return carrier as unknown as ThinkingCarrier;
}

// ── Run conditions and the notice (§3, §7.3) ─────────────────────────────────────────────────────

/** Inputs `AgentExecutor` holds when it builds the record: the decision half from its own resolution. */
export interface ThinkingDecision {
  requested: boolean;
  mode: ThinkingMode;
  source: 'request' | 'config' | 'env' | 'default';
}

/**
 * Build the run-condition record from the decision (AgentExecutor) and the outcome (AIProvider).
 * `outcome` undefined means no builder ran — the run threw first — which is `'pre-build-failure'`
 * when thinking was requested and `'not-requested'` otherwise.
 *
 * @param reasoningTokens - Reasoning/thinking tokens measured on the result; undefined when unknown
 *   (thrown runs, providers that do not report them).
 * @param reasonsByDefault - Whether this provider/model reasons with nothing sent (`offMeans`, OD-3(b)).
 */
export function buildRunConditions(
  decision: ThinkingDecision,
  outcome: ThinkingOutcome | undefined,
  reasoningTokens: number | undefined,
  reasonsByDefault: boolean,
): RunConditions {
  const o: ThinkingOutcome = outcome
    ?? { applied: false, notAppliedReason: decision.requested ? 'pre-build-failure' : 'not-requested' };
  return {
    extendedThinking: decision.requested,
    extendedThinkingMode: decision.mode,
    extendedThinkingSource: o.native ? 'native' : decision.source,
    thinkingApplied: o.applied,
    ...(o.applied ? {} : { thinkingNotAppliedReason: o.notAppliedReason ?? 'not-requested' }),
    ...(o.budget !== undefined ? { thinkingBudget: o.budget } : {}),
    ...(o.interleaved ? { thinkingInterleaved: true } : {}),
    ...(o.maxTokensSent !== undefined ? { maxTokensSent: o.maxTokensSent } : {}),
    ...(o.structuredOutputDegraded ? { structuredOutputDegraded: o.structuredOutputDegraded } : {}),
    thinkingObserved: reasoningTokens === undefined ? 'unknown' : reasoningTokens > 0 ? 'yes' : 'no',
    ...(!o.applied && reasonsByDefault ? { offMeans: 'provider-default' as const } : {}),
  };
}

/**
 * The applied-keyed notice, or undefined when thinking was not requested (§3). `warn` when not
 * applied, or when the source is the environment — a sticky lever an operator may not know is set;
 * `info` otherwise. One line per agent run.
 */
export function thinkingNotice(rc: RunConditions): { level: 'warn' | 'info'; text: string } | undefined {
  if (!rc.extendedThinking) {
    // Not requested through core, but the caller's own native options turned thinking on: say so —
    // it is the one thinking path core neither caps nor otherwise reports (core 0.51.0 review: P3).
    return rc.extendedThinkingSource === 'native' && rc.thinkingApplied
      ? { level: 'info', text: "Extended thinking on (set by the caller's provider-native options; not capped by core) — thinking tokens are billed as output." }
      : undefined;
  }
  const lever = rc.extendedThinkingSource === 'env' ? 'the ULUOPS_EXTENDED_THINKING environment variable'
    : rc.extendedThinkingSource === 'config' ? 'ai.extendedThinking in the client config'
    : rc.extendedThinkingSource === 'request' ? "this run's extendedThinking option"
    : rc.extendedThinkingSource === 'native' ? "the caller's provider-native thinking options"
    : 'the default';
  if (!rc.thinkingApplied) {
    return { level: 'warn', text: `Extended thinking requested (by ${lever}) but not applied: ${rc.thinkingNotAppliedReason}.` };
  }
  const detail = rc.thinkingBudget !== undefined ? `, budget ${rc.thinkingBudget} tokens` : '';
  return {
    level: rc.extendedThinkingSource === 'env' ? 'warn' : 'info',
    text: `Extended thinking on (set by ${lever}${detail}) — thinking tokens are billed as output.`,
  };
}
