import type {
  RegistryClient as RegistrySdk,
  Model,
  ModelAlias as RegistryModelAlias,
  AliasResolution,
  ModelCapabilities,
  ModelTier,
} from '@uluops/registry-sdk';
import { ModelNotFoundError, CapabilityError } from '../errors/index.js';
import type { Logger } from '@uluops/sdk-core';

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
   * Model's real context window in tokens (registry `limits.context`).
   * Undefined when the registry has no window for this model (null/0 limit, or
   * an unregistered model). Consumed by deriveContextBudget() to size the budget
   * guards against the actual window rather than a static default.
   */
  contextWindow?: number;

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

    throw new ModelNotFoundError(
      `Cannot resolve model "${input}". Not found as alias, tier, or provider:modelId. ` +
      `Use catalog.listAliases() to see available aliases.`,
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
      throw error;
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
      throw error;
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
      resolvedFrom: alias,
    };
    this.validateCapabilities(resolved, opts?.requiredCapabilities);
    return resolved;
  }

  /** Check if an error is a 404/not-found from the registry API */
  private isNotFoundError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'status' in error) {
      return (error as { status: number }).status === 404;
    }
    return false;
  }

  private toResolvedModel(alias: AliasResolution, input: string): ResolvedModel {
    const model = alias.model;
    const targetParts = alias.target.split(':');
    return {
      provider: model?.provider ?? targetParts[0] ?? 'unknown',
      modelId: model?.modelId ?? targetParts[1] ?? alias.target,
      providerModelId: model?.providerModelId ?? targetParts[1] ?? alias.target,
      tier: model?.tier ?? 'standard',
      capabilities: model?.capabilities ?? DEFAULT_CAPABILITIES,
      contextWindow: model?.limits?.context || undefined,
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
