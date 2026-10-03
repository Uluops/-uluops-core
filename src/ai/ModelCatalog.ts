import type {
  RegistryClient as RegistrySdk,
  Model,
  ModelCost,
  ModelAlias as RegistryModelAlias,
  AliasResolution,
  ModelCapabilities,
  ModelTier,
} from '@uluops/registry-sdk';
import { isNotFoundError as isRegistryNotFound } from '@uluops/registry-sdk/errors';
import { SDK_VERSION as REGISTRY_SDK_VERSION } from '@uluops/registry-sdk/config/constants';
import { ModelNotFoundError, CapabilityError, ConfigurationError } from '../errors/index.js';
import type { Logger } from '@uluops/sdk-core';

/**
 * Validate registry pricing at the trust seam before it can reach arithmetic.
 *
 * `ModelCost` declares `input`/`output` as required `number`s, but that is a
 * COMPILE-TIME claim over data that arrives as untrusted network JSON —
 * `@uluops/registry-sdk` performs no runtime validation of it (types only). A row with a
 * null, missing, or non-numeric rate makes `usage.output_tokens * cost.output` evaluate to
 * NaN, and a NaN cost JSON-serializes to `null`, which is indistinguishable from an
 * unpriced model and blanks an entire pipeline's recorded spend.
 *
 * This is the same failure the token-side finiteness guard prevents, at the OTHER operand
 * of the same multiply — the guard was applied to the tokens and not to the rates.
 *
 * Polarity follows the documented rule for pricing: unusable rates yield `undefined`
 * (honest-absent, costUsd stays unknown), never zero rates, because a $0 cost is a claim
 * and an absent cost is an admission. The optional cache rates are dropped individually
 * when unusable — computeCostUsd then falls back to the full input rate, a conservative
 * overstatement that is already its documented behavior for a model with no cache rate.
 */
export function sanitizeModelCost(cost: ModelCost | null | undefined): ModelCost | undefined {
  if (!cost) return undefined;
  const usable = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!usable(cost.input) || !usable(cost.output)) return undefined;
  return {
    input: cost.input,
    output: cost.output,
    ...(usable(cost.cacheRead) ? { cacheRead: cost.cacheRead } : {}),
    ...(usable(cost.cacheWrite) ? { cacheWrite: cost.cacheWrite } : {}),
    ...(cost.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: cost.sourceUpdatedAt } : {}),
  };
}


/**
 * Resolved model with provider routing information
 */
export interface ResolvedModel {
  /** Provider name (e.g., 'anthropic', 'openai') */
  provider: string;

  /** Model ID in registry (e.g., 'claude-sonnet-4-5-20250929') */
  modelId: string;

  /** Provider-specific model ID for AI SDK */
  providerModelId: string;

  /** Model tier for cost estimation */
  tier: ModelTier;

  /** Model capabilities */
  capabilities: ModelCapabilities;

  /**
   * Whether this model was found in the registry catalog.
   *
   * `false` means the catalog had no row and the fields above are fabricated
   * defaults (`tier: 'standard'`, DEFAULT_CAPABILITIES) — the model may still
   * be perfectly valid at the provider, e.g. private or preview access.
   *
   * This bit exists so a provider 404 can be explained correctly. Without it
   * the two causes arrive identically at the error mapper and the user is told
   * nothing useful:
   *   registered && 404 -> the catalog is STALE; the model was withdrawn
   *                        upstream and the local catalog has not caught up
   *   !registered && 404 -> the name is likely wrong, or the account lacks
   *                        access; there was never a catalog row to be stale
   *
   * Required, not optional, so every construction site must state its answer —
   * a defaulted `false` would silently mislabel registered models as typos.
   */
  registered: boolean;

  /**
   * Model's real context window in tokens (registry `limits.context`).
   * Undefined when the registry has no window for this model (null/0 limit, or
   * an unregistered model). Consumed by deriveContextBudget() to size the budget
   * guards against the actual window rather than a static default.
   */
  contextWindow?: number;

  /**
   * Pricing (USD per MILLION tokens) from the registry. Undefined on every
   * degraded resolution path — unregistered model, registry-outage offline
   * fallback, alias without an embedded model — and for registry rows that
   * are unpriced (wire cost: null). Absence flows through to
   * costUsd === undefined; never coerced to zero rates (honest-absent,
   * costusd-pricing-population spec v0.6.0).
   */
  cost?: ModelCost;

  /** Original input that resolved to this model */
  resolvedFrom: string;
}

/**
 * Options for model resolution
 */
export interface ResolveOptions {
  /** Capabilities the model must support */
  requiredCapabilities?: Array<keyof ModelCapabilities>;

  /** Preferred provider (used when resolving by tier) */
  preferredProvider?: string;
}

const VALID_TIERS: readonly string[] = ['budget', 'standard', 'premium', 'reasoning'];

// Capabilities assumed for models ABSENT from the registry — reached only on two
// paths: an unregistered explicit provider:modelId (resolveExplicit) and an alias
// whose resolution carries no model object (toResolvedModel). Registered models and
// tier resolution use the registry's own capabilities.
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: false,
  tools: true,
  streaming: true,
  extendedThinking: false,
  // Default-deny is intentional, not a placeholder: with no registry data we can't
  // know a model supports JSON-schema structured output, and assuming true produces
  // hard API errors when wrong. false routes to text extraction, which works for any
  // model emitting a JSON fence (and is non-destructive since the Option B extraction
  // fix). Register the model to opt it into structured output. Do NOT flip to true.
  structuredOutput: false,
  // Absence/true = allowed. Only false (set in the catalog for Google/Gemini)
  // disables structured output when tools are present.
  structuredOutputWithTools: true,
};

/**
 * Last-resort alias table for registry OUTAGES only (issue 172518e2): a cold
 * process resolving a well-known alias while the registry is unreachable
 * previously failed before any LLM call, with no offline path — the offline
 * quick-start covers definition resolution but not model aliases. Consulted
 * exclusively on transport errors (never on 404 — an alias the registry says
 * doesn't exist still fails), never cached (registry recovery wins), and
 * resolves with DEFAULT_CAPABILITIES (default-deny structured output).
 * A registry ROUTE miss (404 with `details.reason: 'route'`, raised as
 * ConfigurationError since 0.45.0) counts as a transport failure here: the
 * request reached no catalog endpoint, so for these aliases it falls back like
 * an outage. That path is effectively unreachable today, since none of these
 * aliases contains '/' and the path form for them is always routed.
 *
 * DECAY SURFACE (2026-07-10, cf. issue 70cb73e3): these are date-stamped
 * vendor IDs and are the fastest-decaying strings in the codebase. They only
 * matter during a registry outage; a stale entry fails at the provider call
 * instead of at resolution — still strictly later than today's failure point.
 * Refresh alongside registry model syncs.
 */
const OFFLINE_FALLBACK_ALIASES: Record<string, { provider: string; modelId: string }> = {
  sonnet: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
  haiku: { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  opus: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
};

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Registry-backed model catalog with in-memory caching.
 *
 * Resolution priority:
 * 1. Explicit provider:modelId (e.g., "anthropic:claude-sonnet-4-5-20250929")
 * 2. Registry alias (e.g., "sonnet") via models.resolveAlias()
 * 3. Tier name (e.g., "premium") — resolves to first available model for tier
 * 4. During a registry outage only: OFFLINE_FALLBACK_ALIASES for well-known aliases
 *
 * Cache is in-memory only. Call refresh() to clear after admin syncs models.
 * No auto-sync or TTL — model sync is an admin operation.
 */
export class ModelCatalog {
  private aliasCache = new Map<string, AliasResolution>();
  private modelCache = new Map<string, Model>();
  private logger: Logger;

  constructor(private sdk: RegistrySdk, logger?: Logger) {
    this.logger = logger ?? noopLogger;
  }

  /**
   * Resolve a model input to a fully-qualified ResolvedModel.
   *
   * @param input - Alias ('sonnet'), tier ('premium'), or 'provider:modelId'
   * @param opts - Resolution options (capability checks, provider preference)
   * @returns The fully-qualified {@link ResolvedModel} — `provider`, `modelId`,
   *   `providerModelId`, tier, and the resolved capability set.
   * @throws {ModelNotFoundError} If alias/model cannot be resolved
   * @throws {CapabilityError} If model lacks required capabilities
   * @throws {ConfigurationError} If the registry answers a route miss (404 with
   *   `details.reason: 'route'`) — the lookup matched no registry endpoint, so the catalog was
   *   never asked. That is a client/registry version mismatch, not an unregistered model; the
   *   message names the input and the installed registry-sdk version.
   * @example
   * ```typescript
   * await catalog.resolve('sonnet');                                  // alias
   * await catalog.resolve('premium');                                 // tier
   * await catalog.resolve('anthropic:claude-sonnet-4-6');             // explicit provider:modelId
   * await catalog.resolve('openrouter:anthropic/claude-sonnet-4');    // id containing '/' (registry-sdk 0.58.0+)
   * ```
   */
  async resolve(input: string, opts?: ResolveOptions): Promise<ResolvedModel> {
    // 1. Explicit provider:modelId
    if (input.includes(':')) {
      return this.resolveExplicit(input, opts);
    }

    // 2. Try alias resolution. A transport error (registry outage, not a 404)
    // falls back to the offline table for well-known aliases before failing —
    // a cold process must be able to resolve 'sonnet' while the registry is
    // down (issue 172518e2).
    let aliasResult: AliasResolution | null;
    try {
      aliasResult = await this.resolveAlias(input);
    } catch (error) {
      const fallback = this.resolveOfflineFallback(input, error, opts);
      if (fallback) return fallback;
      throw error;
    }
    if (aliasResult) {
      const resolved = this.toResolvedModel(aliasResult, input);
      this.validateCapabilities(resolved, opts?.requiredCapabilities);
      return resolved;
    }

    // 3. Try tier resolution
    const tierResult = await this.resolveByTier(input, opts);
    if (tierResult) return tierResult;

    // Inline what we can name for free. VALID_TIERS is a static const, so listing
    // it costs nothing and covers the common typo. The alias list requires a
    // registry round-trip and is therefore BEST-EFFORT: if that call fails we
    // keep the original ModelNotFoundError rather than surfacing a network error
    // in its place — masking "your model name is wrong" with "the registry is
    // down" would send the reader after the wrong problem entirely.
    let aliasHint = 'Use catalog.listAliases() to see available aliases.';
    try {
      const aliases = await this.listAliases();
      if (aliases.length > 0) {
        const names = aliases.map((a) => a.alias).sort();
        const shown = names.slice(0, 20).join(', ');
        aliasHint = `Available aliases: ${shown}${names.length > 20 ? `, … (${names.length} total, see catalog.listAliases())` : ''}.`;
      }
    } catch {
      // Keep the discovery-method hint; the original failure is what matters.
    }

    throw new ModelNotFoundError(
      `Cannot resolve model "${input}". Not found as an alias, a tier, or provider:modelId. ` +
      `Valid tiers: ${VALID_TIERS.join(', ')}. ${aliasHint}`,
    );
  }

  /**
   * List all available model aliases from the registry.
   *
   * @returns The array of {@link RegistryModelAlias} (alias → provider/model mappings).
   */
  async listAliases(): Promise<RegistryModelAlias[]> {
    const result = await this.sdk.models.listAliases();
    return result.aliases;
  }

  /**
   * List available models, optionally filtered.
   *
   * @param filter - Optional filters: `provider`, `tier`, and `capability`
   *   (a key of {@link ModelCapabilities}, e.g. `'tools'`, `'extendedThinking'`).
   * @returns The matching array of {@link Model} entries from the registry.
   */
  async listModels(filter?: {
    provider?: string;
    tier?: ModelTier;
    capability?: keyof ModelCapabilities;
  }): Promise<Model[]> {
    const result = await this.sdk.models.list(filter);
    return result.models;
  }

  /**
   * Clear in-memory cache. Call after admin syncs models in the registry.
   */
  refresh(): void {
    this.aliasCache.clear();
    this.modelCache.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Resolution Strategies
  // ─────────────────────────────────────────────────────────────────────────

  private async resolveExplicit(
    providerModelId: string,
    opts?: ResolveOptions,
  ): Promise<ResolvedModel> {
    const colonIdx = providerModelId.indexOf(':');
    const provider = providerModelId.substring(0, colonIdx);
    const modelId = providerModelId.substring(colonIdx + 1);

    // Look up in registry for capabilities/tier
    const model = await this.getModel(provider, modelId);
    if (!model) {
      // Allow unregistered models (user may have access to models not in registry)
      const resolved: ResolvedModel = {
        provider,
        modelId,
        providerModelId: modelId,
        tier: 'standard',
        capabilities: DEFAULT_CAPABILITIES,
        // No catalog row — deliberately allowed through (the caller may have
        // access to models the registry does not list).
        registered: false,
        resolvedFrom: providerModelId,
      };
      this.validateCapabilities(resolved, opts?.requiredCapabilities);
      return resolved;
    }

    const resolved: ResolvedModel = {
      provider: model.provider,
      modelId: model.modelId,
      providerModelId: model.providerModelId ?? model.modelId,
      tier: model.tier,
      capabilities: model.capabilities,
      contextWindow: model.limits?.context || undefined,
      cost: sanitizeModelCost(model.cost),
      registered: true,
      resolvedFrom: providerModelId,
    };

    this.validateCapabilities(resolved, opts?.requiredCapabilities);
    return resolved;
  }

  private async resolveAlias(alias: string): Promise<AliasResolution | null> {
    const cached = this.aliasCache.get(alias);
    if (cached !== undefined) return cached;

    try {
      const result = await this.sdk.models.resolveAlias(alias);
      this.aliasCache.set(alias, result);
      return result;
    } catch (error) {
      if (this.isNotFoundError(error)) return null;
      throw this.routeMissError(error, 'resolveAlias', alias) ?? error;
    }
  }

  private async resolveByTier(
    tier: string,
    opts?: ResolveOptions,
  ): Promise<ResolvedModel | null> {
    if (!VALID_TIERS.includes(tier)) return null;

    const models = await this.sdk.models.list({
      tier: tier as ModelTier,
      ...(opts?.preferredProvider ? { provider: opts.preferredProvider } : {}),
    });

    const model = models.models[0];
    if (!model) return null;

    const resolved: ResolvedModel = {
      provider: model.provider,
      modelId: model.modelId,
      providerModelId: model.providerModelId ?? model.modelId,
      tier: model.tier,
      capabilities: model.capabilities,
      contextWindow: model.limits?.context || undefined,
      cost: sanitizeModelCost(model.cost),
      registered: true,
      resolvedFrom: tier,
    };

    this.validateCapabilities(resolved, opts?.requiredCapabilities);
    return resolved;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Cache + Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async getModel(provider: string, modelId: string): Promise<Model | null> {
    const key = `${provider}:${modelId}`;
    if (this.modelCache.has(key)) return this.modelCache.get(key)!;

    try {
      const model = await this.sdk.models.get(provider, modelId);
      this.modelCache.set(key, model);
      return model;
    } catch (error) {
      if (this.isNotFoundError(error)) return null;
      throw this.routeMissError(error, 'get', key) ?? error;
    }
  }

  /**
   * Offline outage fallback (issue 172518e2). Returns a ResolvedModel from the
   * static table when the alias is well-known, or null (caller rethrows the
   * registry error). Deliberately NOT cached — once the registry recovers, the
   * next cold resolution must use its authoritative mapping.
   */
  private resolveOfflineFallback(
    alias: string,
    cause: unknown,
    opts?: ResolveOptions,
  ): ResolvedModel | null {
    const entry = OFFLINE_FALLBACK_ALIASES[alias];
    if (!entry) return null;

    this.logger.warn(
      `Registry unreachable while resolving model alias "${alias}" (${cause instanceof Error ? cause.message : String(cause)}) — ` +
      `falling back to baked-in ${entry.provider}:${entry.modelId} with default-deny capabilities. ` +
      `Capabilities and context window are unknown offline; structured output is disabled for this run.`,
    );

    const resolved: ResolvedModel = {
      provider: entry.provider,
      modelId: entry.modelId,
      providerModelId: entry.modelId,
      tier: 'standard',
      capabilities: DEFAULT_CAPABILITIES,
      // Registry was unreachable, so registration is UNKNOWN. Reported as
      // false: claiming `true` here would let a stale-catalog message be shown
      // on the strength of a lookup that never happened.
      registered: false,
      resolvedFrom: alias,
    };
    this.validateCapabilities(resolved, opts?.requiredCapabilities);
    return resolved;
  }

  /**
   * Check if an error is a 404/not-found from the registry API.
   *
   * Uses registry-sdk's own guard. It is an `instanceof` check, so it must come from the package
   * that throws. Until registry-sdk 0.58.0 that package carried its own nested @uluops/sdk-core
   * (0.18.0, against core's 0.18.1); 0.58.0 dedupes onto core's copy, but importing the guard from
   * registry-sdk keeps working whichever way the tree resolves. A structural check on `status` was
   * used here until issue d99bb92f. The SDK error carries `statusCode`, so that check never
   * matched: every registry 404 was rethrown, unregistered models failed resolution instead of
   * taking DEFAULT_CAPABILITIES, and alias misses never fell through to tier resolution.
   *
   * A 404 whose `details.reason` is `'route'` is **not** "not found" (OpenRouter plan S11): the
   * request matched no registry endpoint, so the catalog was never asked. Treating it as
   * unregistered would silently give a registered model DEFAULT_CAPABILITIES. `'model'`, `'alias'`
   * and an absent reason (a registry deployed before the field existed) mean not-found as before.
   */
  private isNotFoundError(error: unknown): boolean {
    return isRegistryNotFound(error) && !isRouteMiss(error);
  }

  /**
   * Wrap a registry route miss so the message names what was being looked up. The bare SDK message
   * ("The requested endpoint does not exist") names neither the model nor the operation.
   * Returns undefined for any other error, which the caller rethrows unchanged.
   */
  private routeMissError(error: unknown, operation: 'get' | 'resolveAlias', input: string): ConfigurationError | undefined {
    if (!isRegistryNotFound(error) || !isRouteMiss(error)) return undefined;
    return new ConfigurationError(
      `Registry lookup for "${input}" (models.${operation}) matched no registry endpoint ` +
        `(404, details.reason "route"), so the model catalog was never queried. ` +
        `This client uses @uluops/registry-sdk ${REGISTRY_SDK_VERSION}; ids and aliases containing "/" ` +
        `need registry-sdk 0.58.0+ against a registry API with the /models/lookup route.`,
      { cause: error },
    );
  }

  private toResolvedModel(alias: AliasResolution, input: string): ResolvedModel {
    const model = alias.model;
    const [targetProvider, targetModelId] = splitAliasTarget(alias.target);
    return {
      provider: model?.provider ?? targetProvider ?? 'unknown',
      modelId: model?.modelId ?? targetModelId ?? alias.target,
      providerModelId: model?.providerModelId ?? targetModelId ?? alias.target,
      tier: model?.tier ?? 'standard',
      capabilities: model?.capabilities ?? DEFAULT_CAPABILITIES,
      contextWindow: model?.limits?.context || undefined,
      cost: sanitizeModelCost(model?.cost),
      // The alias resolved, but the response may carry no model object; only
      // the object's presence proves a catalog row exists.
      registered: model !== undefined,
      resolvedFrom: input,
    };
  }

  private validateCapabilities(
    model: ResolvedModel,
    required?: Array<keyof ModelCapabilities>,
  ): void {
    if (!required || required.length === 0) return;

    const missing = required.filter(cap => !model.capabilities[cap]);
    if (missing.length > 0) {
      throw new CapabilityError(
        `Model "${model.resolvedFrom}" (${model.provider}:${model.modelId}) ` +
        `lacks required capabilities: ${missing.join(', ')}. ` +
        `Model capabilities: ${JSON.stringify(model.capabilities)}`,
      );
    }
  }
}

/** True when a registry 404 says no endpoint matched (`details.reason === 'route'`). */
function isRouteMiss(error: unknown): boolean {
  const details = (error as { details?: unknown }).details;
  return typeof details === 'object' && details !== null && (details as { reason?: unknown }).reason === 'route';
}

/**
 * Split an alias target into provider and model id at its FIRST separator, whichever of `/` or `:`
 * comes first (C24). The registry emits `provider/modelId` (registry services/model/index.ts:1216),
 * and an OpenRouter model id itself contains `/` and may end in `:free`, so
 * `openrouter/meta-llama/llama-3.3-70b-instruct:free` is provider `openrouter` + the rest. The
 * `provider:modelId` form is still accepted. Until this, the target was split on every `:` and only
 * the second part kept, so a `/` target became one provider string with no model id.
 */
function splitAliasTarget(target: string): [string | undefined, string | undefined] {
  const at = [target.indexOf('/'), target.indexOf(':')].filter(i => i > 0);
  if (at.length === 0) return [undefined, undefined];
  const i = Math.min(...at);
  return [target.slice(0, i), target.slice(i + 1) || undefined];
}
