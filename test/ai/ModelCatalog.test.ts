import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelCatalog } from '../../src/ai/ModelCatalog.js';
import { ModelNotFoundError, CapabilityError } from '../../src/errors/index.js';
import type { RegistryClient as RegistrySdk } from '@uluops/registry-sdk';
import type { Model, AliasResolution } from '@uluops/registry-sdk';

/** Simulate a 404 error from the registry SDK (has status property like ApiError) */
function makeNotFoundError(message = 'Not found'): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = 404;
  return err;
}

// ─── Test Data Factories ─────────────────────────────────────────────────────

function makeModel(overrides?: Partial<Model>): Model {
  return {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    description: 'Fast, capable model',
    providerModelId: 'claude-sonnet-4-5-20250929',
    capabilities: { vision: true, tools: true, streaming: true, extendedThinking: false },
    limits: { context: 200_000, output: 16_384 },
    tier: 'premium',
    status: 'active',
    ...overrides,
  };
}

function makeAliasResolution(overrides?: Partial<AliasResolution>): AliasResolution {
  return {
    alias: 'sonnet',
    target: 'anthropic:claude-sonnet-4-5-20250929',
    model: makeModel(),
    ...overrides,
  };
}

function mockSdk(overrides?: {
  resolveAlias?: ReturnType<typeof vi.fn>;
  getModel?: ReturnType<typeof vi.fn>;
  listModels?: ReturnType<typeof vi.fn>;
  listAliases?: ReturnType<typeof vi.fn>;
}): RegistrySdk {
  return {
    models: {
      resolveAlias: overrides?.resolveAlias ?? vi.fn().mockResolvedValue(makeAliasResolution()),
      get: overrides?.getModel ?? vi.fn().mockResolvedValue(makeModel()),
      list: overrides?.listModels ?? vi.fn().mockResolvedValue({ models: [makeModel()] }),
      listAliases: overrides?.listAliases ?? vi.fn().mockResolvedValue({ aliases: [] }),
    },
  } as unknown as RegistrySdk;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ModelCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── resolve(): Alias Resolution ─────────────────────────────────────────

  describe('resolve via alias', () => {
    it('resolves an alias to a ResolvedModel', async () => {
      const sdk = mockSdk();
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('sonnet');

      expect(result.provider).toBe('anthropic');
      expect(result.modelId).toBe('claude-sonnet-4-5-20250929');
      expect(result.providerModelId).toBe('claude-sonnet-4-5-20250929');
      expect(result.tier).toBe('premium');
      expect(result.resolvedFrom).toBe('sonnet');
      expect(result.capabilities.tools).toBe(true);
    });

    it('caches alias resolution results', async () => {
      const resolveAlias = vi.fn().mockResolvedValue(makeAliasResolution());
      const sdk = mockSdk({ resolveAlias });
      const catalog = new ModelCatalog(sdk);

      await catalog.resolve('sonnet');
      await catalog.resolve('sonnet');

      expect(resolveAlias).toHaveBeenCalledTimes(1);
    });

    it('handles alias without model details (target-only)', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockResolvedValue(
          makeAliasResolution({ model: null, target: 'anthropic:claude-haiku-4-5' }),
        ),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('haiku');

      expect(result.provider).toBe('anthropic');
      expect(result.modelId).toBe('claude-haiku-4-5');
      expect(result.tier).toBe('standard'); // default when model is null
    });

    it('falls through to tier when alias not found', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError()),
        listModels: vi.fn().mockResolvedValue({ models: [makeModel({ tier: 'budget' })] }),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('budget');

      expect(result.tier).toBe('budget');
      expect(result.resolvedFrom).toBe('budget');
    });
  });

  // ─── resolve(): Explicit provider:modelId ─────────────────────────────────

  describe('resolve via explicit provider:modelId', () => {
    it('resolves registered model by provider:modelId', async () => {
      const sdk = mockSdk();
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('anthropic:claude-sonnet-4-5-20250929');

      expect(result.provider).toBe('anthropic');
      expect(result.modelId).toBe('claude-sonnet-4-5-20250929');
      expect(result.resolvedFrom).toBe('anthropic:claude-sonnet-4-5-20250929');
      expect(sdk.models.get).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-5-20250929');
    });

    it('allows unregistered models with default capabilities', async () => {
      const sdk = mockSdk({
        getModel: vi.fn().mockRejectedValue(makeNotFoundError()),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('openai:gpt-4o');

      expect(result.provider).toBe('openai');
      expect(result.modelId).toBe('gpt-4o');
      expect(result.tier).toBe('standard');
      expect(result.capabilities.tools).toBe(true);
      expect(result.capabilities.vision).toBe(false);
    });

    it('caches model lookups by provider:modelId', async () => {
      const getModel = vi.fn().mockResolvedValue(makeModel());
      const sdk = mockSdk({ getModel });
      const catalog = new ModelCatalog(sdk);

      await catalog.resolve('anthropic:claude-sonnet-4-5-20250929');
      await catalog.resolve('anthropic:claude-sonnet-4-5-20250929');

      expect(getModel).toHaveBeenCalledTimes(1);
    });
  });

  // ─── resolve(): contextWindow plumbing ────────────────────────────────────

  describe('contextWindow from limits.context', () => {
    it('copies the window from limits.context on explicit resolution', async () => {
      const sdk = mockSdk({ getModel: vi.fn().mockResolvedValue(makeModel({ limits: { context: 128_000, output: 8_192 } })) });
      const result = await new ModelCatalog(sdk).resolve('anthropic:claude-sonnet-4-5-20250929');
      expect(result.contextWindow).toBe(128_000);
    });

    it('copies the window through alias resolution', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockResolvedValue(makeAliasResolution({ model: makeModel({ limits: { context: 1_000_000, output: 64_000 } }) })),
      });
      const result = await new ModelCatalog(sdk).resolve('sonnet');
      expect(result.contextWindow).toBe(1_000_000);
    });

    it('leaves contextWindow undefined when limits is absent', async () => {
      const noLimits = makeModel();
      delete (noLimits as Record<string, unknown>).limits;
      const sdk = mockSdk({ getModel: vi.fn().mockResolvedValue(noLimits) });
      const result = await new ModelCatalog(sdk).resolve('anthropic:claude-sonnet-4-5-20250929');
      expect(result.contextWindow).toBeUndefined();
    });

    it('treats a 0 limit as unknown (undefined)', async () => {
      const sdk = mockSdk({ getModel: vi.fn().mockResolvedValue(makeModel({ limits: { context: 0, output: 0 } })) });
      const result = await new ModelCatalog(sdk).resolve('anthropic:claude-sonnet-4-5-20250929');
      expect(result.contextWindow).toBeUndefined();
    });

    it('leaves contextWindow undefined for unregistered models', async () => {
      const sdk = mockSdk({ getModel: vi.fn().mockRejectedValue(makeNotFoundError()) });
      const result = await new ModelCatalog(sdk).resolve('openai:gpt-4o');
      expect(result.contextWindow).toBeUndefined();
    });
  });

  // ─── resolve(): Tier Resolution ───────────────────────────────────────────

  describe('resolve via tier', () => {
    it('resolves a valid tier name to first matching model', async () => {
      const premiumModel = makeModel({ tier: 'premium' });
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError('Not an alias')),
        listModels: vi.fn().mockResolvedValue({ models: [premiumModel] }),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('premium');

      expect(result.tier).toBe('premium');
      expect(result.resolvedFrom).toBe('premium');
    });

    it('passes preferredProvider to tier list call', async () => {
      const listModels = vi.fn().mockResolvedValue({ models: [makeModel()] });
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError('Not an alias')),
        listModels,
      });
      const catalog = new ModelCatalog(sdk);

      await catalog.resolve('premium', { preferredProvider: 'anthropic' });

      expect(listModels).toHaveBeenCalledWith({
        tier: 'premium',
        provider: 'anthropic',
      });
    });

    it('rejects invalid tier names', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError('Not an alias')),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(catalog.resolve('invalid-tier')).rejects.toThrow(ModelNotFoundError);
    });

    it('throws ModelNotFoundError when tier has no models', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError('Not an alias')),
        listModels: vi.fn().mockResolvedValue({ models: [] }),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(catalog.resolve('budget')).rejects.toThrow(ModelNotFoundError);
      await expect(catalog.resolve('budget')).rejects.toThrow('Cannot resolve model "budget"');
    });

    it('accepts all valid tier names', async () => {
      for (const tier of ['budget', 'standard', 'premium', 'reasoning']) {
        const sdk = mockSdk({
          resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError('Not an alias')),
          listModels: vi.fn().mockResolvedValue({ models: [makeModel({ tier: tier as Model['tier'] })] }),
        });
        const catalog = new ModelCatalog(sdk);
        const result = await catalog.resolve(tier);
        expect(result.resolvedFrom).toBe(tier);
      }
    });
  });

  // ─── resolve(): Capability Validation ─────────────────────────────────────

  describe('capability validation', () => {
    it('passes when model has all required capabilities', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockResolvedValue(
          makeAliasResolution({
            model: makeModel({ capabilities: { vision: true, tools: true, streaming: true, extendedThinking: true } }),
          }),
        ),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('sonnet', {
        requiredCapabilities: ['vision', 'tools', 'extendedThinking'],
      });

      expect(result.capabilities.vision).toBe(true);
      expect(result.capabilities.extendedThinking).toBe(true);
    });

    it('throws CapabilityError when model lacks required capabilities', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockResolvedValue(
          makeAliasResolution({
            model: makeModel({ capabilities: { vision: false, tools: true, streaming: true, extendedThinking: false } }),
          }),
        ),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(
        catalog.resolve('sonnet', { requiredCapabilities: ['vision', 'extendedThinking'] }),
      ).rejects.toThrow(CapabilityError);

      await expect(
        catalog.resolve('sonnet', { requiredCapabilities: ['vision'] }),
      ).rejects.toThrow('lacks required capabilities: vision');
    });

    it('skips validation when no requiredCapabilities provided', async () => {
      const sdk = mockSdk();
      const catalog = new ModelCatalog(sdk);

      // Should not throw even though model lacks some capabilities
      const result = await catalog.resolve('sonnet');
      expect(result).toBeDefined();
    });

    it('skips validation when requiredCapabilities is empty array', async () => {
      const sdk = mockSdk();
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.resolve('sonnet', { requiredCapabilities: [] });
      expect(result).toBeDefined();
    });

    it('validates capabilities for explicit provider:modelId (registered)', async () => {
      const sdk = mockSdk({
        getModel: vi.fn().mockResolvedValue(
          makeModel({ capabilities: { vision: false, tools: true, streaming: true, extendedThinking: false } }),
        ),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(
        catalog.resolve('anthropic:claude-haiku-4-5', { requiredCapabilities: ['vision'] }),
      ).rejects.toThrow(CapabilityError);
    });

    it('validates capabilities for explicit provider:modelId (unregistered)', async () => {
      const sdk = mockSdk({
        getModel: vi.fn().mockRejectedValue(makeNotFoundError()),
      });
      const catalog = new ModelCatalog(sdk);

      // Unregistered models get DEFAULT_CAPABILITIES (vision: false)
      await expect(
        catalog.resolve('openai:gpt-4o', { requiredCapabilities: ['vision'] }),
      ).rejects.toThrow(CapabilityError);
    });

    it('validates capabilities for tier resolution', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError('Not an alias')),
        listModels: vi.fn().mockResolvedValue({
          models: [makeModel({ capabilities: { vision: false, tools: true, streaming: true, extendedThinking: false } })],
        }),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(
        catalog.resolve('premium', { requiredCapabilities: ['vision'] }),
      ).rejects.toThrow(CapabilityError);
    });

    it('includes model details in CapabilityError message', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockResolvedValue(
          makeAliasResolution({
            model: makeModel({
              modelId: 'claude-haiku-4-5',
              capabilities: { vision: false, tools: true, streaming: true, extendedThinking: false },
            }),
          }),
        ),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(
        catalog.resolve('haiku', { requiredCapabilities: ['vision', 'extendedThinking'] }),
      ).rejects.toThrow(/haiku.*lacks required capabilities: vision, extendedThinking/);
    });
  });

  // ─── resolve(): Error Cases ───────────────────────────────────────────────

  describe('error cases', () => {
    it('throws ModelNotFoundError for unknown input', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError()),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(catalog.resolve('nonexistent')).rejects.toThrow(ModelNotFoundError);
      await expect(catalog.resolve('nonexistent')).rejects.toThrow(
        'Cannot resolve model "nonexistent"',
      );
    });

    it('error message suggests listAliases()', async () => {
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(makeNotFoundError()),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(catalog.resolve('bad')).rejects.toThrow('listAliases()');
    });

    it('re-throws network/auth errors from resolveAlias for aliases outside the offline table', async () => {
      const networkError = new Error('Network timeout');
      const sdk = mockSdk({
        resolveAlias: vi.fn().mockRejectedValue(networkError),
      });
      const catalog = new ModelCatalog(sdk);

      // 'my-custom-alias' has no baked-in fallback — the outage must surface.
      await expect(catalog.resolve('my-custom-alias')).rejects.toThrow('Network timeout');
    });

    // ── Offline outage fallback (issue 172518e2) ─────────────────────────
    describe('offline fallback aliases', () => {
      it('resolves a well-known alias from the baked-in table during a registry outage', async () => {
        const sdk = mockSdk({
          resolveAlias: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        });
        const warn = vi.fn();
        const catalog = new ModelCatalog(sdk, { debug() {}, info() {}, warn, error() {} });

        const resolved = await catalog.resolve('sonnet');

        expect(resolved.provider).toBe('anthropic');
        expect(resolved.resolvedFrom).toBe('sonnet');
        // Default-deny capabilities offline — structured output must not be assumed.
        expect(resolved.capabilities.structuredOutput).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Registry unreachable'));
      });

      it('does NOT use the fallback for a 404 (alias genuinely unknown)', async () => {
        const notFound = Object.assign(new Error('not found'), { status: 404 });
        const sdk = mockSdk({
          resolveAlias: vi.fn().mockRejectedValue(notFound),
          listModels: vi.fn().mockResolvedValue({ models: [] }),
        });
        const catalog = new ModelCatalog(sdk);

        // 404 → alias path yields null → tier fails → ModelNotFoundError, not a fallback resolve.
        await expect(catalog.resolve('sonnet')).rejects.toThrow('Cannot resolve model');
      });

      it('does not cache the fallback — registry recovery wins on the next resolve', async () => {
        const resolveAlias = vi.fn()
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))
          .mockResolvedValueOnce({
            alias: 'sonnet',
            target: 'anthropic:claude-registry-model',
            model: null,
          });
        const sdk = mockSdk({ resolveAlias });
        const catalog = new ModelCatalog(sdk);

        const offline = await catalog.resolve('sonnet');
        const online = await catalog.resolve('sonnet');

        expect(offline.modelId).not.toBe('claude-registry-model');
        expect(online.modelId).toBe('claude-registry-model');
        expect(resolveAlias).toHaveBeenCalledTimes(2);
      });
    });

    it('re-throws non-404 errors from getModel instead of masking as null', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const sdk = mockSdk({
        getModel: vi.fn().mockRejectedValue(authError),
      });
      const catalog = new ModelCatalog(sdk);

      await expect(catalog.resolve('anthropic:claude-sonnet-4-5')).rejects.toThrow('Unauthorized');
    });
  });

  // ─── listAliases / listModels ─────────────────────────────────────────────

  describe('listAliases', () => {
    it('returns aliases from registry', async () => {
      const aliases = [{ alias: 'sonnet', target: 'anthropic:claude-sonnet-4-5' }];
      const sdk = mockSdk({
        listAliases: vi.fn().mockResolvedValue({ aliases }),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.listAliases();
      expect(result).toEqual(aliases);
    });
  });

  describe('listModels', () => {
    it('returns models from registry', async () => {
      const models = [makeModel()];
      const sdk = mockSdk({
        listModels: vi.fn().mockResolvedValue({ models }),
      });
      const catalog = new ModelCatalog(sdk);

      const result = await catalog.listModels();
      expect(result).toEqual(models);
    });

    it('passes filter options to SDK', async () => {
      const listModels = vi.fn().mockResolvedValue({ models: [] });
      const sdk = mockSdk({ listModels });
      const catalog = new ModelCatalog(sdk);

      await catalog.listModels({ provider: 'anthropic', tier: 'premium' });
      expect(listModels).toHaveBeenCalledWith({ provider: 'anthropic', tier: 'premium' });
    });
  });

  // ─── refresh ──────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('clears both alias and model caches', async () => {
      const resolveAlias = vi.fn().mockResolvedValue(makeAliasResolution());
      const getModel = vi.fn().mockResolvedValue(makeModel());
      const sdk = mockSdk({ resolveAlias, getModel });
      const catalog = new ModelCatalog(sdk);

      // Populate caches
      await catalog.resolve('sonnet');
      await catalog.resolve('anthropic:claude-sonnet-4-5-20250929');
      expect(resolveAlias).toHaveBeenCalledTimes(1);
      expect(getModel).toHaveBeenCalledTimes(1);

      // Clear and re-resolve
      catalog.refresh();
      await catalog.resolve('sonnet');
      await catalog.resolve('anthropic:claude-sonnet-4-5-20250929');

      // Should have called SDK again after cache clear
      expect(resolveAlias).toHaveBeenCalledTimes(2);
      expect(getModel).toHaveBeenCalledTimes(2);
    });
  });
});
