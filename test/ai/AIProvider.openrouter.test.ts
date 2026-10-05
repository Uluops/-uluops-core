/**
 * OpenRouter provider support — slices 1b and 1e of the OpenRouter plan (v0.6.1).
 *
 * Runs against the REAL `@openrouter/ai-sdk-provider@2.10.0` (a devDependency here; consumers
 * install it themselves, like the other dynamic providers). Private methods are reached through
 * a typed cast: they are the unit under test, and going through `generate()` would bury each
 * behaviour under a mocked tool loop.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { APICallError } from 'ai';
import { AIProvider, SHELL_SCHEMA_FALLBACK_PROVIDERS } from '../../src/ai/AIProvider.js';
import { resolveAIConfig } from '../../src/client/UluOpsClient.js';
import { ConfigurationError } from '../../src/errors/index.js';
import type { ModelCatalog, ResolvedModel } from '../../src/ai/ModelCatalog.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { UsageMetrics } from '../../src/types/ai.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

const config: ResolvedConfig = {
  apiKey: 'test-api-key',
  ai: {
    providers: { openrouter: { apiKey: 'test-openrouter-key' } },
    defaultProvider: 'openrouter',
  },
  registryUrl: 'https://registry.example.com',
  submissionUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: false,
  timeout: 300_000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
  maxConcurrency: 8,
  allowStageSteps: false,
};

const catalog = { resolve: vi.fn(), listAliases: vi.fn(), listModels: vi.fn(), refresh: vi.fn() } as unknown as ModelCatalog;

function model(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4-flash',
    providerModelId: 'deepseek/deepseek-v4-flash',
    tier: 'standard',
    capabilities: { tools: true, vision: false, streaming: true, extendedThinking: false },
    registered: true,
    resolvedFrom: 'openrouter:deepseek/deepseek-v4-flash',
    ...overrides,
  };
}

interface Internals {
  providers: Map<string, unknown>;
  buildProviderOptions(r: ResolvedModel, o?: Record<string, unknown>, b?: number): Record<string, Record<string, unknown>> | undefined;
  mapUsage(usage: unknown, meta?: Record<string, unknown>, provider?: string, modelId?: string): UsageMetrics;
  detectUsageShapeDrift(meta?: Record<string, unknown>): string[];
  mapAPICallError(error: APICallError, resolved?: ResolvedModel): Error;
}
const internals = (p: AIProvider) => p as unknown as Internals;

afterEach(() => vi.restoreAllMocks());

// ─── S1–S3: loading ──────────────────────────────────────────────────────────

describe('S1–S3: loading the OpenRouter provider', () => {
  it('loads @openrouter/ai-sdk-provider through createOpenRouter', async () => {
    const provider = new AIProvider(config, catalog, noopLogger);
    await provider.ensureProvider('openrouter');
    expect(internals(provider).providers.has('openrouter')).toBe(true);
  });

  it('OPENROUTER_API_KEY alone configures the provider (auto-detect)', () => {
    const resolved = resolveAIConfig(undefined, { OPENROUTER_API_KEY: 'sk-or-test' });
    expect(resolved.providers['openrouter']).toEqual({ apiKey: 'sk-or-test' });
  });

  it('the install hint names the real package and its pin, not @ai-sdk/openrouter', () => {
    expect(AIProvider.installHintFor('openrouter')).toBe('npm install @openrouter/ai-sdk-provider@2.10.0');
    expect(AIProvider.installHintFor('mistral')).toBe('npm install @ai-sdk/mistral');
  });

  // 1e install guard: npm `latest` is 3.1.0 (peer ai ^7), which imports fine and then fails
  // inside the AI SDK in wording that names nothing core controls.
  it('refuses a provider package whose major differs from the pin, naming both', async () => {
    vi.spyOn(AIProvider, 'readInstalledVersion').mockReturnValue('3.1.0');
    const provider = new AIProvider(config, catalog, noopLogger);
    const err = await provider.ensureProvider('openrouter').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toContain('3.1.0');
    expect((err as Error).message).toContain('2.10.0');
  });

  it('packageFor names the override package, and @ai-sdk/<name> otherwise', () => {
    expect(AIProvider.packageFor('openrouter')).toBe('@openrouter/ai-sdk-provider');
    expect(AIProvider.packageFor('mistral')).toBe('@ai-sdk/mistral');
  });

  it('a provider package that is not installed keeps the import error as cause', async () => {
    const provider = new AIProvider({ ...config, ai: { ...config.ai, providers: { mistral: { apiKey: 'k' } } } }, catalog, noopLogger);
    const err = await provider.ensureProvider('mistral').catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain('npm install @ai-sdk/mistral');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('accepts the pinned version', async () => {
    vi.spyOn(AIProvider, 'readInstalledVersion').mockReturnValue('2.10.0');
    const provider = new AIProvider(config, catalog, noopLogger);
    await expect(provider.ensureProvider('openrouter')).resolves.toBeUndefined();
  });
});

// ─── S4: options builder ─────────────────────────────────────────────────────

describe('S4: OpenRouter provider options', () => {
  const build = (r: ResolvedModel, user?: Record<string, unknown>) =>
    internals(new AIProvider(config, catalog, noopLogger)).buildProviderOptions(r, user)?.['openrouter'];

  it('forces require_parameters even when the caller sets it false', () => {
    const opts = build(model(), { openrouter: { provider: { require_parameters: false, sort: 'price' } } });
    expect(opts?.['provider']).toEqual({ sort: 'price', require_parameters: true });
  });

  it('forces usage.include even when the caller sets it false', () => {
    const opts = build(model(), { openrouter: { usage: { include: false } } });
    expect(opts?.['usage']).toEqual({ include: true });
  });

  it('maps the thinking budget to reasoning.max_tokens for a thinking-capable model', () => {
    const opts = build(model({ capabilities: { tools: true, extendedThinking: true } as ResolvedModel['capabilities'] }));
    expect(opts?.['reasoning']).toEqual({ max_tokens: 10_000 });
  });

  it('sends no reasoning option for a model without extendedThinking', () => {
    expect(build(model())?.['reasoning']).toBeUndefined();
  });

  it('a caller reasoning: null counts as unset: the default applies, no bare null is sent', () => {
    const opts = build(
      model({ capabilities: { tools: true, extendedThinking: true } as ResolvedModel['capabilities'] }),
      { openrouter: { reasoning: null } },
    );
    expect(opts?.['reasoning']).toEqual({ max_tokens: 10_000 });
  });

  it('sends no reasoning option when the configured thinking budget is not finite and positive', () => {
    for (const bad of [Number.NaN, 0, -5]) {
      const opts = internals(new AIProvider({ ...config, defaultThinkingBudget: bad }, catalog, noopLogger))
        .buildProviderOptions(model({ capabilities: { tools: true, extendedThinking: true } as ResolvedModel['capabilities'] }))?.['openrouter'];
      expect(opts?.['reasoning']).toBeUndefined();
    }
  });

  it('a non-object caller provider block is replaced, not spread into index keys', () => {
    const opts = build(model(), { openrouter: { provider: 'price' } });
    expect(opts?.['provider']).toEqual({ require_parameters: true });
  });

  it("keeps a caller's own reasoning block", () => {
    const opts = build(
      model({ capabilities: { tools: true, extendedThinking: true } as ResolvedModel['capabilities'] }),
      { openrouter: { reasoning: { effort: 'low' } } },
    );
    expect(opts?.['reasoning']).toEqual({ effort: 'low' });
  });
});

// ─── S6a + C7: usage ─────────────────────────────────────────────────────────

/**
 * Modelled on the Phase 0 trace (DeepSeek V4 Flash via OpenRouter, traces/phase0-spike-findings.md): the
 * key layout is the provider's, but `cost` is the 3-step SUM, which no single step's block carries.
 */
const openrouterMeta = {
  openrouter: {
    provider: 'Relace',
    reasoning_details: [],
    usage: {
      promptTokens: 1564, promptTokensDetails: { cachedTokens: 1280 },
      completionTokens: 178, completionTokensDetails: { reasoningTokens: 50 },
      totalTokens: 1742, cost: 0.000271, costDetails: { upstreamInferenceCost: 0.000271 },
    },
  },
};

describe('S6a: OpenRouter usage', () => {
  it('reports no usage-shape drift for an openrouter metadata block', () => {
    const provider = new AIProvider(config, catalog, noopLogger);
    expect(internals(provider).detectUsageShapeDrift(openrouterMeta)).toEqual([]);
  });

  // e3536a74 / slice 1c: the billed figure depends on `usage.cost`, an INNER key. Against
  // 0.46.0 this returns [] — the outer `usage` survives and satisfies the check — and every
  // run silently falls back to the estimate.
  it('reports drift when usage survives but usage.cost does not', () => {
    const warn = vi.fn();
    const provider = new AIProvider(config, catalog, { ...noopLogger, warn });
    const { cost: _cost, ...usageWithoutCost } = (openrouterMeta.openrouter as { usage: Record<string, unknown> }).usage;
    const meta = { openrouter: { ...openrouterMeta.openrouter, usage: usageWithoutCost } };
    expect(internals(provider).detectUsageShapeDrift(meta)).toEqual(['openrouter']);
    expect(warn.mock.calls[0]![0]).toContain('usage.cost');
  });

  it('keeps input_tokens cache-exclusive', () => {
    const usage = internals(new AIProvider(config, catalog, noopLogger)).mapUsage(
      { inputTokens: 1564, outputTokens: 178, inputTokenDetails: { noCacheTokens: 284, cacheReadTokens: 1280, cacheWriteTokens: 0 }, outputTokenDetails: { reasoningTokens: 50 } },
      openrouterMeta, 'openrouter', 'deepseek/deepseek-v4-flash',
    );
    expect(usage.input_tokens).toBe(284);
    expect(usage.cache_read_input_tokens).toBe(1280);
  });

  it('falls back to the openrouter block for cache reads when the standard field is absent', () => {
    const usage = internals(new AIProvider(config, catalog, noopLogger)).mapUsage(
      { inputTokens: 1564, outputTokens: 178 },
      openrouterMeta, 'openrouter', 'deepseek/deepseek-v4-flash',
    );
    expect(usage.cache_read_input_tokens).toBe(1280);
    expect(usage.input_tokens).toBe(284);
  });
});

describe('C7: reasoning bucket by upstream family', () => {
  const map = (modelId: string) => internals(new AIProvider(config, catalog, noopLogger)).mapUsage(
    { inputTokens: 100, outputTokens: 900, outputTokenDetails: { reasoningTokens: 891 } },
    {}, 'openrouter', modelId,
  );

  it('a google/* slug lands in thinking_tokens, as the direct Google route does', () => {
    const usage = map('google/gemini-2.5-flash-lite');
    expect(usage.thinking_tokens).toBe(891);
    expect(usage.reasoning_tokens).toBeUndefined();
  });

  it('a non-google slug stays in reasoning_tokens', () => {
    const usage = map('openai/gpt-oss-120b');
    expect(usage.reasoning_tokens).toBe(891);
    expect(usage.thinking_tokens).toBeUndefined();
  });
});

// ─── S5: shell fallback ──────────────────────────────────────────────────────

describe('S5: schema fallback bash, OpenRouter only (D8)', () => {
  it('OpenRouter gets a tool named bash; google still gets none', () => {
    const provider = new AIProvider(config, catalog, noopLogger);
    expect(Object.keys(provider.createProviderShellTool('openrouter', process.cwd()) ?? {})).toEqual(['bash']);
    expect(provider.createProviderShellTool('google', process.cwd())).toBeUndefined();
  });

  it('exposes the fallback set so the executor can mark it', () => {
    expect([...SHELL_SCHEMA_FALLBACK_PROVIDERS]).toEqual(['openrouter']);
  });

  // Real process. The timing bound shows the call returned early (the child was signalled); the
  // text shows how it was reported. Node rejects an aborted exec with the STRING code ABORT_ERR,
  // which the spawn-failure branch used to claim ("could not be started") before the
  // cancellation check ran.
  it('cancelling during a long command returns early and reports a cancel, not a spawn failure', async () => {
    const provider = new AIProvider(config, catalog, noopLogger);
    const tools = provider.createProviderShellTool('openrouter', process.cwd(), 30_000) as Record<string, { execute: (i: unknown, o: unknown) => Promise<string> }>;
    const ac = new AbortController();
    const started = Date.now();
    const run = tools['bash']!.execute({ command: 'sleep 20' }, { abortSignal: ac.signal, toolCallId: 't', messages: [] });
    setTimeout(() => ac.abort(), 200);
    const out = await run;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out).toContain('cancelled');
    expect(out).not.toContain('could not be started');
  });
});

// ─── 1e: 400 on an unregistered model ────────────────────────────────────────

describe('1e: a 400 on an unregistered model names the default budget', () => {
  const err400 = new APICallError({
    message: "This endpoint's maximum context length is 32768 tokens. However, you requested about 41000 tokens.",
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
  });

  it('names the 200k default and the unregistered status', () => {
    const provider = new AIProvider(config, catalog, noopLogger);
    const mapped = internals(provider).mapAPICallError(err400, model({ registered: false, contextWindow: undefined }));
    expect(mapped.message).toContain('did not resolve from the model catalog');
    expect(mapped.message).toContain('200,000');
    expect(mapped.message).toContain('maximum context length');
  });

  it("an unknown slug's 400 is not blamed on the budget", () => {
    const typo = new APICallError({
      message: 'deepseek/deepsek-v4 is not a valid model ID', url: 'u', requestBodyValues: {}, statusCode: 400,
    });
    const mapped = internals(new AIProvider(config, catalog, noopLogger)).mapAPICallError(typo, model({ registered: false }));
    expect(mapped.message).not.toContain('context budget');
  });

  it("names the operator's contextBudget when one is set", () => {
    const provider = new AIProvider({ ...config, contextBudget: 120_000 }, catalog, noopLogger);
    const mapped = internals(provider).mapAPICallError(err400, model({ registered: false, contextWindow: undefined }));
    expect(mapped.message).toContain('120,000');
  });

  it('a registered model keeps the plain 400 message', () => {
    const provider = new AIProvider(config, catalog, noopLogger);
    const mapped = internals(provider).mapAPICallError(err400, model({ registered: true, contextWindow: 32_768 }));
    expect(mapped.message).not.toContain('did not resolve from the model catalog');
  });
});

// ─── Error shapes measured in Phase 0 ────────────────────────────────────────

describe('OpenRouter error shapes', () => {
  const map = (e: APICallError, r?: ResolvedModel) => internals(new AIProvider(config, catalog, noopLogger)).mapAPICallError(e, r);

  it('an error in a 200 body maps by its numeric code', () => {
    const inBody = new APICallError({
      message: 'Rate limit exceeded upstream', url: 'u', requestBodyValues: {}, statusCode: 200,
      data: { code: 429, message: 'Rate limit exceeded upstream' },
    });
    expect(map(inBody, model()).name).toBe('RateLimitError');
  });

  it('a 200 with no numeric body code is left as it was', () => {
    const odd = new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 200, data: { code: 'weird' } });
    expect(map(odd, model()).message).toContain('HTTP 200');
  });

  it('a no-endpoint 404 on a registered model is not reported as a stale catalog', () => {
    const noEndpoint = new APICallError({
      message: 'No endpoints found that support the requested parameters', url: 'u', requestBodyValues: {}, statusCode: 404,
      data: { error: { message: 'No endpoints found', code: 404, metadata: { failed_routing_step: 'Filter by Parameters' } } },
    });
    const mapped = map(noEndpoint, model({ registered: true }));
    expect(mapped.message).toContain('Filter by Parameters');
    expect(mapped.message).not.toContain('STALE');
  });

  it('a plain 404 on a registered model still says the catalog is stale', () => {
    const plain = new APICallError({ message: 'not found', url: 'u', requestBodyValues: {}, statusCode: 404 });
    expect(map(plain, model({ registered: true })).message).toContain('STALE');
  });
});
