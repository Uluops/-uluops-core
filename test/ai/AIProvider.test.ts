import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIProvider } from '../../src/ai/AIProvider.js';
import { TokenBudgetTracker } from '../../src/ai/TokenBudgetTracker.js';
import type { ModelCatalog, ResolvedModel } from '../../src/ai/ModelCatalog.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';
import { APICallError, RetryError, NoOutputGeneratedError, NoObjectGeneratedError } from 'ai';
import {
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  TimeoutError,
  CancelledError,
  SdkApiError,
  ConfigurationError,
} from '../../src/errors/index.js';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A REAL `APICallError` — symbol-branded, the way the provider actually raises it.
 * A plain Error with a `statusCode` bolted on is NOT one, and core's guard is now
 * brand-based, so a lookalike no longer maps. Building the genuine article is what
 * makes these tests exercise the branch they claim to.
 */
function makeApiCallError(message: string, statusCode: number): Error {
  return new APICallError({
    message,
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode,
  });
}

// PARTIAL mock of the AI SDK. `generateText` is stubbed; everything else — crucially
// the error classes (APICallError, RetryError, NoObjectGeneratedError,
// NoOutputGeneratedError) — comes from the REAL module.
//
// This used to be a total mock, which meant the SDK's error classes did not exist in
// these tests at all. That forced the error-mapping tests to fabricate lookalikes
// (`Object.assign(new Error(), { statusCode: 403 })`, `error.name = 'RetryError'`), and
// those lookalikes only ever matched because core's guards were structural. The mock
// and the guards agreed with each other and both disagreed with the SDK: `RetryError`
// is really named `AI_RetryError`, and `AbortSignal.timeout()` raises `TimeoutError`,
// not `AbortError` — so two mapping branches were dead while their tests stayed green.
// Keeping the real classes here is what makes these tests capable of failing.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
  tool: vi.fn((t: unknown) => t),
  Output: { object: vi.fn((schema: unknown) => ({ type: 'output-object', schema })) },
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-model' })) as any;
    provider.tools = {
      bash_20250124: vi.fn((opts: any) => ({ type: 'provider-defined-tool', name: 'bash', execute: opts.execute })),
    };
    return provider;
  }),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-openai-model' })) as any;
    provider.tools = {
      shell: vi.fn((opts: any) => ({ type: 'provider-defined-tool', name: 'shell', execute: opts.execute })),
    };
    return provider;
  }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-google-model' })) as any;
    provider.tools = {
      googleSearch: vi.fn(() => ({ type: 'provider-defined-tool', name: 'google_search' })),
      codeExecution: vi.fn(() => ({ type: 'provider-defined-tool', name: 'code_execution' })),
      urlContext: vi.fn(() => ({ type: 'provider-defined-tool', name: 'url_context' })),
    };
    return provider;
  }),
}));

const mockConfig: ResolvedConfig = {
  apiKey: 'test-api-key',
  ai: {
    providers: { anthropic: { apiKey: 'test-anthropic-key' } },
    defaultProvider: 'anthropic',
  },
  registryUrl: 'https://registry.example.com',
  submissionUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,

  timeout: 300_000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
  maxConcurrency: 8,
  allowStageSteps: false,
};

function makeResolvedModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    providerModelId: 'claude-sonnet-4-5-20250929',
    tier: 'premium',
    capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false },
    registered: true,
    resolvedFrom: 'alias',
    ...overrides,
  };
}

function mockCatalog(overrides?: Partial<ModelCatalog>): ModelCatalog {
  return {
    resolve: vi.fn().mockResolvedValue(makeResolvedModel()),
    listAliases: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ModelCatalog;
}

describe('AIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generate', () => {
    it('calls generateText with correct parameters', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'Analysis complete',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [
          { toolCalls: [{ id: '1' }, { id: '2' }] },
          { toolCalls: [] },
        ],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      const result = await provider.generate({
        model: 'sonnet',
        system: 'You are a code reviewer.',
        prompt: 'Review this code.',
      });

      expect(result.text).toBe('Analysis complete');
      expect(result.usage.input_tokens).toBe(100);
      expect(result.usage.output_tokens).toBe(50);
      expect(result.toolCallCount).toBe(2);
      expect(result.model).toBe('anthropic:claude-sonnet-4-5-20250929');
      expect(result.provider).toBe('anthropic');
      expect(result.steps).toBe(2);
      expect(result.finishReason).toBe('stop');

      // Should have called catalog.resolve with the model alias
      expect(catalog.resolve).toHaveBeenCalledWith('sonnet', {
        requiredCapabilities: undefined,
      });
    });

    // ── Usage-metadata shape-drift detection (issue adaaa4b9) ──────────────
    it('flags a provider whose metadata is non-empty but unrecognizable', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockResolvedValue({
        text: 'ok',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [],
        finishReason: 'stop',
        // Simulates a provider-SDK rename: cacheCreationInputTokens → cache_creation
        providerMetadata: { anthropic: { cache_creation: 5, cache_read: 3 } },
      } as never);

      const warn = vi.fn();
      const provider = new AIProvider(mockConfig, mockCatalog(), { debug() {}, info() {}, warn, error() {} });
      const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

      expect(result.usageShapeDrift).toEqual(['anthropic']);
      // The warning NAMES the depended-on fields that went missing, rather than saying
      // only that the shape is unrecognized — the detector now asserts presence of the
      // keys an extract tier actually reads.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('none of the fields its extract tier reads are present'),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cacheCreationInputTokens'));

      // Chronic once present — warn fires once per provider per process, but
      // the per-run drift flag keeps flowing.
      const again = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
      expect(again.usageShapeDrift).toEqual(['anthropic']);
      expect(warn.mock.calls.filter(c => String(c[0]).includes('may silently read zero'))).toHaveLength(1);
    });

    it('does not flag recognized, empty, or absent provider metadata', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      const base = { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, steps: [], finishReason: 'stop' };
      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);

      // Recognized shape (current SDK fields)
      mockGenerateText.mockResolvedValueOnce({ ...base, providerMetadata: { anthropic: { cacheCreationInputTokens: 5, cacheReadInputTokens: 0 } } } as never);
      expect((await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' })).usageShapeDrift).toBeUndefined();

      // Empty provider object — fields legitimately omitted, not drift
      mockGenerateText.mockResolvedValueOnce({ ...base, providerMetadata: { anthropic: {} } } as never);
      expect((await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' })).usageShapeDrift).toBeUndefined();

      // No provider metadata at all
      mockGenerateText.mockResolvedValueOnce({ ...base, providerMetadata: undefined } as never);
      expect((await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' })).usageShapeDrift).toBeUndefined();
    });

    /**
     * The detector iterated `RECOGNIZED_USAGE_KEYS` — three hardcoded names — so a provider
     * added through `ai.additionalProviders` was never looked at. An instrument enumerating
     * by NAME over a closed list, aimed at a population that is open by construction: the
     * operator supplies the names, and the table cannot grow to meet them. The check could
     * only ever confirm the three it already knew.
     *
     * The consequence is not cosmetic. mapUsage dispatches to three extract tiers by name,
     * so an unlisted provider's cache and reasoning counts are dropped, the metrics read
     * zero, and computeCostUsd undercounts by exactly the cache-served pool it never saw —
     * silently, with no marker.
     *
     * POSITIVE CONTROL: restore the `Object.entries(AIProvider.RECOGNIZED_USAGE_KEYS)` loop
     * and the first three fail — the drift array comes back undefined. The last is the
     * negative control and passes either way.
     */
    it('flags a provider present in the payload that no extract tier reads', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockResolvedValue({
        text: 'ok',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [],
        finishReason: 'stop',
        // A provider added via ai.additionalProviders, reporting real cache tokens that
        // nothing in core will ever read.
        providerMetadata: { mistral: { cachedTokens: 4_000, reasoningTokens: 200 } },
      } as never);

      const warn = vi.fn();
      const provider = new AIProvider(mockConfig, mockCatalog(), { debug() {}, info() {}, warn, error() {} });
      const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

      expect(result.usageShapeDrift).toEqual(['mistral']);
      // The message must NOT say "unrecognized shape" — that sends the reader looking for
      // a rename that never happened. Nothing was renamed; nothing was ever read.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NO extract tier reads it'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('additionalProviders'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('its shape is unrecognized'));
    });

    it('reports an unread provider ALONGSIDE a drifted known one, not instead of it', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockResolvedValue({
        text: 'ok',
        usage: { inputTokens: 10, outputTokens: 5 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          anthropic: { cache_creation: 5 },        // renamed — drifted
          groq: { somethingUseful: 1 },            // unlisted — unread
        },
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

      expect(result.usageShapeDrift).toEqual(expect.arrayContaining(['anthropic', 'groq']));
      expect(result.usageShapeDrift).toHaveLength(2);
    });

    it('warns once per unlisted provider per process, like drift', async () => {
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockResolvedValue({
        text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, steps: [], finishReason: 'stop',
        providerMetadata: { cohere: { tokens: 1 } },
      } as never);

      const warn = vi.fn();
      const provider = new AIProvider(mockConfig, mockCatalog(), { debug() {}, info() {}, warn, error() {} });
      await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
      const second = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

      // The per-run flag keeps flowing; the log does not repeat.
      expect(second.usageShapeDrift).toEqual(['cohere']);
      expect(warn.mock.calls.filter(c => String(c[0]).includes('NO extract tier reads it'))).toHaveLength(1);
    });

    it('an EMPTY unlisted provider block is not flagged — the negative control', async () => {
      // Without this, "unlisted providers are flagged" would also pass for an
      // implementation that flagged every payload key unconditionally, including the
      // legitimately-omitted case the detector was explicitly built to stay quiet about.
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockResolvedValueOnce({
        text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, steps: [], finishReason: 'stop',
        providerMetadata: { mistral: {} },
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      expect((await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' })).usageShapeDrift).toBeUndefined();
    });

    // ── Structured-output-with-tools capability gating (Option C) ──────────
    // useStructuredOutput is true only when the model supports structured output
    // AND it is not the case that tools are present on a model whose
    // structuredOutputWithTools capability is false (Google/Gemini). generateText
    // receives an `output` key only when structured output is enabled.
    function mockStopResult() {
      return {
        text: '{}',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never;
    }

    it('disables structured output when structuredOutputWithTools is false and tools are present', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      mockGenerateText.mockResolvedValueOnce(mockStopResult());

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeResolvedModel({
          provider: 'google',
          capabilities: { tools: true, streaming: true, structuredOutput: true, structuredOutputWithTools: false },
        })),
      });
      const googleCfg: ResolvedConfig = {
        ...mockConfig,
        ai: {
          providers: { anthropic: { apiKey: 'test-anthropic-key' }, google: { apiKey: 'test-google-key' } },
          defaultProvider: 'anthropic',
        },
      };
      const provider = new AIProvider(googleCfg, catalog, noopLogger);
      await provider.generate({
        model: 'gemini',
        system: 's',
        prompt: 'p',
        tools: { read_file: {} } as never,
        output: { schema: {} } as never,
      });

      const callArg = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg).not.toHaveProperty('output');
    });

    it('enables structured output when structuredOutputWithTools is false but no tools are present', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      mockGenerateText.mockResolvedValueOnce(mockStopResult());

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeResolvedModel({
          provider: 'google',
          capabilities: { tools: true, streaming: true, structuredOutput: true, structuredOutputWithTools: false },
        })),
      });
      const googleCfg: ResolvedConfig = {
        ...mockConfig,
        ai: {
          providers: { anthropic: { apiKey: 'test-anthropic-key' }, google: { apiKey: 'test-google-key' } },
          defaultProvider: 'anthropic',
        },
      };
      const provider = new AIProvider(googleCfg, catalog, noopLogger);
      await provider.generate({
        model: 'gemini',
        system: 's',
        prompt: 'p',
        output: { schema: {} } as never,
      });

      const callArg = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg).toHaveProperty('output');
    });

    it('enables structured output when structuredOutputWithTools is absent (allowed by default)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      mockGenerateText.mockResolvedValueOnce(mockStopResult());

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeResolvedModel({
          capabilities: { tools: true, streaming: true, structuredOutput: true },
        })),
      });
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 's',
        prompt: 'p',
        tools: { read_file: {} } as never,
        output: { schema: {} } as never,
      });

      const callArg = mockGenerateText.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg).toHaveProperty('output');
    });

    it('applies modelOverride from config', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const configWithOverride: ResolvedConfig = {
        ...mockConfig,
        ai: { ...mockConfig.ai, modelOverride: 'haiku' },
      };
      const provider = new AIProvider(configWithOverride, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      // Should resolve 'haiku' (override) instead of 'sonnet' (requested)
      expect(catalog.resolve).toHaveBeenCalledWith('haiku', {
        requiredCapabilities: undefined,
      });
    });

    it('passes requiredCapabilities to catalog', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
        requiredCapabilities: ['tools', 'vision'],
      });

      expect(catalog.resolve).toHaveBeenCalledWith('sonnet', {
        requiredCapabilities: ['tools', 'vision'],
      });
    });

    it('maps usage with cache metrics from inputTokenDetails', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        // Realistic v6 shape: the SDK emits noCacheTokens alongside the cache fields,
        // and `inputTokens` is the cache-INCLUSIVE total (125 + 50 + 25 = 200).
        // This fixture previously omitted noCacheTokens and asserted input_tokens
        // stayed 200 — certifying the very cache-inclusive double-count the engine
        // was corrected to stop producing.
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          inputTokenDetails: {
            noCacheTokens: 125,
            cacheReadTokens: 50,
            cacheWriteTokens: 25,
          },
        },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const result = await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      expect(result.usage.input_tokens).toBe(125);
      expect(result.usage.input_tokens).not.toBe(200);
      expect(result.usage.output_tokens).toBe(100);
      expect(result.usage.cache_read_input_tokens).toBe(50);
      expect(result.usage.cache_creation_input_tokens).toBe(25);
    });

    it('does not silently keep a cache-inclusive total when noCacheTokens is absent', async () => {
      // The narrow shape the normalization fallback exists for: details present but
      // noCacheTokens missing. The SDK is not expected to emit this, but the type
      // permits it independently, and if it ever occurred the pre-fix behaviour
      // (keep the cache-inclusive total) is the failure we must not silently revert to.
      const { generateText } = await import('ai');
      vi.mocked(generateText).mockResolvedValueOnce({
        text: 'done',
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 50, cacheWriteTokens: 25 },
        },
        steps: [],
        finishReason: 'stop',
        providerMetadata: { someprovider: { cachedTokens: 50 } },
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

      // Falls back to removing every cache pool, counting the cache-served pool once
      // under whichever name it arrived: 200 − 50 (cache_read, preferred over the
      // identical cached_input) − 25 (cache_write) = 125.
      expect(result.usage.input_tokens).toBe(125);
      expect(result.usage.input_tokens).not.toBe(200);
    });

    it('maps cache metrics from Anthropic provider metadata as fallback', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 200, outputTokens: 100 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          anthropic: {
            cacheCreationInputTokens: 30,
            cacheReadInputTokens: 60,
          },
        },
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const result = await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      expect(result.usage.cache_creation_input_tokens).toBe(30);
      expect(result.usage.cache_read_input_tokens).toBe(60);
    });

    it('maps 429 to RateLimitError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = makeApiCallError('Rate limited', 429);
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(RateLimitError);
    });

    it('maps 401 to UnauthorizedError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = makeApiCallError('Invalid API key', 401);
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(UnauthorizedError);
    });

    // A provider 404 has two unrelated causes. Before `ResolvedModel.registered`
    // they arrived identically at the mapper and the user was told only
    // "Provider returned HTTP 404", which points at neither cause. These three
    // tests are written so that collapsing the branches again fails them: the
    // last one asserts the two messages actually DIFFER, which no single-branch
    // implementation can satisfy.
    async function capture404Message(registered: boolean): Promise<string> {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = makeApiCallError('model not found', 404);
      mockGenerateText.mockRejectedValueOnce(error);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeResolvedModel({ registered })),
      } as unknown as Partial<ModelCatalog>);

      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      try {
        await provider.generate({ model: 'sonnet', system: 'test', prompt: 'test' });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('generate() resolved — expected it to throw, so the assertions below never ran');
    }

    it('404 on a REGISTERED model blames the stale catalog, not the model name', async () => {
      const msg = await capture404Message(true);
      expect(msg).toMatch(/STALE/);
      // Must NOT send the user hunting for a typo — the name came from the catalog.
      expect(msg).not.toMatch(/typos/);
    });

    it('404 on an UNREGISTERED model points at the name/access, not staleness', async () => {
      const msg = await capture404Message(false);
      expect(msg).toMatch(/typos|access/);
      expect(msg).not.toMatch(/STALE/);
    });

    it('CONTROL — the two 404 messages differ (a collapsed branch fails here)', async () => {
      const registeredMsg = await capture404Message(true);
      const unregisteredMsg = await capture404Message(false);
      expect(registeredMsg).not.toBe(unregisteredMsg);
    });

    it('maps 403 to ForbiddenError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = makeApiCallError('Forbidden', 403);
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(ForbiddenError);
    });

    it('maps 5xx to ServiceUnavailableError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = makeApiCallError('Internal server error', 500);
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(ServiceUnavailableError);
    });

    it('maps a real AbortSignal.timeout rejection (DOMException named TimeoutError) to TimeoutError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      // What AbortSignal.timeout() actually raises (verified live): name 'TimeoutError'.
      const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(TimeoutError);
    });

    /**
     * A caller CANCEL and an elapsed TIMEOUT both arrive here as a DOMException, and the
     * classifier could not tell them apart — every abort mapped to
     * `TimeoutError(timeoutMs)`, a duration nobody measured for an event that did not
     * occur. An operator reading that raises the timeout, which cannot help; a
     * timeout-keyed retry policy retries work the user asked to stop.
     *
     * The discriminator is the CALLER's signal, kept as its own object rather than merged
     * into what the classifier inspects.
     *
     * POSITIVE CONTROL: remove the `callerSignal?.aborted` branch from `mapError` and the
     * first three fail with TimeoutError. The fourth is the negative control and passes
     * either way — it is what stops "everything is a cancel" from looking correct.
     */
    it('maps an abort attributable to the CALLER signal to CancelledError, not TimeoutError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      const controller = new AbortController();
      controller.abort();

      mockGenerateText.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet', system: 'test', prompt: 'test',
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      })).rejects.toThrow(CancelledError);
    });

    it('reports a cancel as a cancel even when the abort surfaces as a TimeoutError DOMException', async () => {
      // AbortSignal.any() propagates whichever member fired, so a cancel racing a timeout
      // signal can surface under either name. Attribution must come from the signal, not
      // from the DOMException's name.
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      const controller = new AbortController();
      controller.abort();

      mockGenerateText.mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError'));

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const err = await provider.generate({
        model: 'sonnet', system: 'test', prompt: 'test',
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CancelledError);
      expect(err).not.toBeInstanceOf(TimeoutError);
    });

    it('attributes a cancel that surfaces WRAPPED in a RetryError', async () => {
      // A cancel landing during a retried request comes back wrapped. The recursive unwrap
      // has to carry the signal, or the attribution is lost one layer down where the outer
      // classification never sees it.
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      const controller = new AbortController();
      controller.abort();

      mockGenerateText.mockRejectedValueOnce(new RetryError({
        message: 'Retries exhausted',
        reason: 'abort',
        errors: [new DOMException('The operation was aborted', 'AbortError')],
      }));

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet', system: 'test', prompt: 'test',
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      })).rejects.toThrow(CancelledError);
    });

    it('an abort with NO caller signal is still a TimeoutError — the negative control', async () => {
      // Without this, "aborts are cancels" would pass for an implementation that had
      // stopped reporting timeouts at all. An UN-aborted caller signal is checked too:
      // presence of a signal is not the discriminator, having FIRED is.
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      const live = new AbortController(); // supplied, never aborted

      mockGenerateText.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet', system: 'test', prompt: 'test',
        timeoutMs: 30_000,
        abortSignal: live.signal,
      })).rejects.toThrow(TimeoutError);

      mockGenerateText.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
      await expect(provider.generate({
        model: 'sonnet', system: 'test', prompt: 'test', timeoutMs: 30_000,
      })).rejects.toThrow(TimeoutError);
    });

    it('hands generateText a signal that carries BOTH the timeout and the caller cancel', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      mockGenerateText.mockResolvedValueOnce({
        text: 'ok', usage: {}, totalUsage: {}, steps: [], finishReason: 'stop',
      } as never);

      const controller = new AbortController();
      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await provider.generate({
        model: 'sonnet', system: 'test', prompt: 'test',
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      });

      const passed = mockGenerateText.mock.calls[0]![0]!.abortSignal!;
      expect(passed).toBeDefined();
      expect(passed.aborted).toBe(false);
      // Firing the CALLER's controller must abort what the request is actually listening
      // to. Before the merge, `timeoutMs` won outright and the caller signal was dropped
      // on the floor — a cancel could not reach the request at all.
      controller.abort();
      expect(passed.aborted).toBe(true);
    });

    /**
     * EVERY request carries a timeout. There is no reachable path that installs none.
     *
     * `mergeAbortSignals` tested `options.timeoutMs ?` — truthiness — so a `0` was dropped
     * and generateText ran with NO abort signal. `0` is the conventional Node spelling of
     * "no timeout" (`execFile` means exactly that) and it reached here through three public
     * `??` chains that all preserved it. A provider that accepts the connection and never
     * answers then leaves the promise pending forever inside `concurrencyLimiter.run`,
     * whose `finally` never runs — the Semaphore permit is never released and every other
     * agent in the process parks behind it, with no error, no log and no exit.
     *
     * POSITIVE CONTROL: restore `options.timeoutMs ? AbortSignal.timeout(...) : undefined`
     * and the first three fail with `abortSignal` undefined.
     */
    it.each([
      ['zero — the conventional "no timeout" spelling', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('installs a timeout anyway when timeoutMs is %s', async (_label, bad) => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      mockGenerateText.mockResolvedValueOnce({
        text: 'ok', usage: {}, totalUsage: {}, steps: [], finishReason: 'stop',
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await provider.generate({
        model: 'sonnet', system: 't', prompt: 't', timeoutMs: bad as number,
      });

      const passed = mockGenerateText.mock.calls[0]![0]!.abortSignal;
      expect(passed).toBeDefined();
      expect(passed!.aborted).toBe(false);
    });

    it('a usable timeoutMs is still honoured, and a cancel still merges — the negative control', async () => {
      // Without this, "always installs a timeout" would also pass for an implementation
      // that ignored the caller's value, or that dropped the cancel signal while adding one.
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);
      mockGenerateText.mockResolvedValueOnce({
        text: 'ok', usage: {}, totalUsage: {}, steps: [], finishReason: 'stop',
      } as never);

      const controller = new AbortController();
      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await provider.generate({
        model: 'sonnet', system: 't', prompt: 't', timeoutMs: 30_000, abortSignal: controller.signal,
      });

      const passed = mockGenerateText.mock.calls[0]![0]!.abortSignal!;
      expect(passed.aborted).toBe(false);
      controller.abort();
      expect(passed.aborted).toBe(true);
    });

    it('maps RetryError to SdkApiError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = new RetryError({
        message: 'Retries exhausted',
        reason: 'maxRetriesExceeded',
        errors: [new Error('attempt 1'), new Error('attempt 2')],
      });
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(SdkApiError);
    });
  });

  describe('buildBudgetPrepareStep (via generate)', () => {
    it('forces toolChoice none when context budget exceeds 80%', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 85000, outputTokens: 2000 },
        steps: [{ toolCalls: [] }],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
        contextBudget: 100_000,
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.prepareStep).toBeDefined();

      // Simulate being under budget
      const resultUnder = call.prepareStep({
        steps: [{ usage: { inputTokens: 50_000, outputTokens: 1000 } }],
      });
      expect(resultUnder.toolChoice).toBeUndefined();

      // Simulate being over 80% budget
      const resultOver = call.prepareStep({
        steps: [{ usage: { inputTokens: 85_000, outputTokens: 1000 } }],
      });
      expect(resultOver.toolChoice).toBe('none');
    });

    it('does not trigger at exactly 79.9% budget but triggers at exactly 80%', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 80000, outputTokens: 2000 },
        steps: [{ toolCalls: [] }],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
        contextBudget: 100_000,
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.prepareStep).toBeDefined();

      // At 79,999 input tokens (79.999%) — just under boundary, no wrap-up
      const resultJustUnder = call.prepareStep({
        steps: [{ usage: { inputTokens: 79_999, outputTokens: 1 } }],
      });
      expect(resultJustUnder.toolChoice).toBeUndefined();

      // At 80,000 input tokens (80%) — exactly at boundary, forces wrap-up
      const resultExact = call.prepareStep({
        steps: [{ usage: { inputTokens: 80_000, outputTokens: 0 } }],
      });
      expect(resultExact.toolChoice).toBe('none');
    });

    it('releases the wrap-up latch once context recovers below 70% (hysteresis)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50000, outputTokens: 2000 },
        steps: [{ toolCalls: [] }],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
        contextBudget: 100_000,
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;

      // Cross 80% → latch on
      expect(call.prepareStep({ steps: [{ usage: { inputTokens: 85_000 } }] }).toolChoice).toBe('none');

      // Still in the band (between 70% and 80%) → stays latched
      expect(call.prepareStep({ steps: [{ usage: { inputTokens: 75_000 } }] }).toolChoice).toBe('none');

      // Drop below 70% (e.g. provider context eviction) → latch releases, tools re-enabled
      expect(call.prepareStep({ steps: [{ usage: { inputTokens: 65_000 } }] }).toolChoice).toBeUndefined();

      // And it can re-latch if context climbs back over 80%
      expect(call.prepareStep({ steps: [{ usage: { inputTokens: 90_000 } }] }).toolChoice).toBe('none');
    });

    it('sets the budget tracker forcedWrapUp flag on latch and clears it on release', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50000, outputTokens: 2000 },
        steps: [{ toolCalls: [] }],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const tracker = new TokenBudgetTracker(100_000);
      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
        contextBudget: 100_000,
        budgetTracker: tracker,
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;

      expect(tracker.forcedWrapUp).toBe(false);
      call.prepareStep({ steps: [{ usage: { inputTokens: 85_000 } }] }); // latch on
      expect(tracker.forcedWrapUp).toBe(true);
      call.prepareStep({ steps: [{ usage: { inputTokens: 65_000 } }] }); // release (<70%)
      expect(tracker.forcedWrapUp).toBe(false);
    });

    it('does not inject prepareStep when no contextBudget', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.prepareStep).toBeUndefined();
    });
  });

  describe('Anthropic context management', () => {
    it('auto-injects contextManagement with clear_tool_uses_20250919', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      const anthropicOpts = call.providerOptions?.anthropic;
      expect(anthropicOpts?.contextManagement).toBeDefined();
      expect(anthropicOpts.contextManagement.edits[0].type).toBe('clear_tool_uses_20250919');
      expect(anthropicOpts.contextManagement.edits[0].trigger.value).toBe(100_000);
      expect(anthropicOpts.contextManagement.edits[0].keep.value).toBe(5);
    });

    it('sizes the eviction trigger off the effective budget (model window), not the static config', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 100, outputTokens: 50 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog();
      const provider = new AIProvider(mockConfig, catalog, noopLogger);
      // AgentExecutor passes the derived effective budget as contextBudget.
      // A 128k-window model must evict at 50% of 128k = 64k, not 100k (50% of 200k).
      await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
        contextBudget: 128_000,
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      const anthropicOpts = call.providerOptions?.anthropic;
      expect(anthropicOpts.contextManagement.edits[0].trigger.value).toBe(64_000);
    });
  });

  describe('ensureProvider', () => {
    it('does not throw for already-loaded providers', async () => {
      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      // anthropic is loaded in constructor
      await expect(provider.ensureProvider('anthropic')).resolves.toBeUndefined();
    });

    it('throws ConfigurationError for unconfigured provider', async () => {
      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.ensureProvider('mistral')).rejects.toThrow(ConfigurationError);
    });
  });

  describe('OpenAI provider', () => {
    const dualConfig: ResolvedConfig = {
      ...mockConfig,
      ai: {
        providers: {
          anthropic: { apiKey: 'test-anthropic-key' },
          openai: { apiKey: 'test-openai-key' },
        },
        defaultProvider: 'anthropic',
      },
    };

    function makeOpenAIModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
      return {
        provider: 'openai',
        modelId: 'gpt-4o',
        providerModelId: 'gpt-4o',
        tier: 'premium',
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false },
        registered: true,
        resolvedFrom: 'alias',
        ...overrides,
      };
    }

    it('initializes OpenAI provider when configured', async () => {
      const provider = new AIProvider(dualConfig, mockCatalog(), noopLogger);
      await expect(provider.ensureProvider('openai')).resolves.toBeUndefined();
    });

    it('generates with OpenAI model', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'OpenAI response',
        usage: { inputTokens: 80, outputTokens: 40 },
        steps: [{ toolCalls: [] }],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeOpenAIModel()),
      });
      const provider = new AIProvider(dualConfig, catalog, noopLogger);
      const result = await provider.generate({
        model: 'gpt-4o',
        system: 'You are a reviewer.',
        prompt: 'Review this.',
      });

      expect(result.text).toBe('OpenAI response');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('openai:gpt-4o');
    });

    it('maps OpenAI cache and reasoning metrics from provider metadata', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 300, outputTokens: 150 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          openai: {
            cachedPromptTokens: 100,
            reasoningTokens: 75,
          },
        },
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeOpenAIModel()),
      });
      const provider = new AIProvider(dualConfig, catalog, noopLogger);
      const result = await provider.generate({
        model: 'gpt-4o',
        system: 'test',
        prompt: 'test',
      });

      // Disentangle (§3.2): OpenAI cachedPromptTokens is cached INPUT, not a cache read.
      expect(result.usage.cached_input_tokens).toBe(100);
      expect(result.usage.cache_read_input_tokens).toBeUndefined();
      expect(result.usage.reasoning_tokens).toBe(75);
    });

    it('auto-sets reasoningEffort for reasoning-capable OpenAI models', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeOpenAIModel({
          modelId: 'o3',
          providerModelId: 'o3',
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: true },
        })),
      });
      const provider = new AIProvider(dualConfig, catalog, noopLogger);
      await provider.generate({
        model: 'o3',
        system: 'test',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.providerOptions.openai.reasoningEffort).toBe('medium');
    });

    it('creates OpenAI shell tool via createProviderShellTool', () => {
      const provider = new AIProvider(dualConfig, mockCatalog(), noopLogger);
      const tools = provider.createProviderShellTool('openai', '/tmp/target', 30_000);
      expect(tools).toBeDefined();
      expect(tools).toHaveProperty('shell');
    });

    it('creates Anthropic bash tool via createProviderShellTool', () => {
      const provider = new AIProvider(dualConfig, mockCatalog(), noopLogger);
      const tools = provider.createProviderShellTool('anthropic', '/tmp/target', 30_000);
      expect(tools).toBeDefined();
      expect(tools).toHaveProperty('bash');
    });

    it('returns undefined for unknown provider shell tool', () => {
      const provider = new AIProvider(dualConfig, mockCatalog(), noopLogger);
      const tools = provider.createProviderShellTool('google', '/tmp/target', 30_000);
      expect(tools).toBeUndefined();
    });

    it('resolveModel returns resolved model with provider', async () => {
      const resolved = makeOpenAIModel();
      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(resolved),
      });
      const provider = new AIProvider(dualConfig, catalog, noopLogger);
      const result = await provider.resolveModel('gpt-4o');
      expect(result.provider).toBe('openai');
      expect(result.modelId).toBe('gpt-4o');
    });

    it('preserves user-supplied reasoningEffort (does not override)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeOpenAIModel({
          modelId: 'o3',
          providerModelId: 'o3',
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: true },
        })),
      });
      const provider = new AIProvider(dualConfig, catalog, noopLogger);
      await provider.generate({
        model: 'o3',
        system: 'test',
        prompt: 'test',
        providerOptions: { openai: { reasoningEffort: 'high' } },
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.providerOptions.openai.reasoningEffort).toBe('high');
    });

    it('uses plain string system message for OpenAI (no cache markup)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeOpenAIModel()),
      });
      const provider = new AIProvider(dualConfig, catalog, noopLogger);
      await provider.generate({
        model: 'gpt-4o',
        system: 'You are helpful.',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      // OpenAI gets plain string, not Anthropic's cache control object
      expect(call.system).toBe('You are helpful.');
    });
  });

  describe('Google provider', () => {
    const googleConfig: ResolvedConfig = {
      ...mockConfig,
      ai: {
        providers: {
          anthropic: { apiKey: 'test-anthropic-key' },
          google: { apiKey: 'test-google-key' },
        },
        defaultProvider: 'anthropic',
      },
    };

    function makeGoogleModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
      return {
        provider: 'google',
        modelId: 'gemini-2.5-flash',
        providerModelId: 'gemini-2.5-flash',
        tier: 'standard',
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false },
        registered: true,
        resolvedFrom: 'alias',
        ...overrides,
      };
    }

    it('initializes when Google credentials configured', async () => {
      const provider = new AIProvider(googleConfig, mockCatalog(), noopLogger);
      await expect(provider.ensureProvider('google')).resolves.toBeUndefined();
    });

    it('generates with Google model', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'Gemini response',
        usage: { inputTokens: 120, outputTokens: 60 },
        steps: [{ toolCalls: [{ id: '1' }] }],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel()),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      const result = await provider.generate({
        model: 'gemini',
        system: 'You are a reviewer.',
        prompt: 'Review this.',
      });

      expect(result.text).toBe('Gemini response');
      expect(result.provider).toBe('google');
      expect(result.model).toBe('google:gemini-2.5-flash');
      expect(result.toolCallCount).toBe(1);
    });

    it('auto-enables thinkingConfig for extendedThinking models', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel({
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: true },
        })),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      await provider.generate({
        model: 'gemini-2.5-flash',
        system: 'test',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.providerOptions.google.thinkingConfig).toEqual({
        thinkingBudget: 10_000,
      });
    });

    it('preserves user-supplied thinkingConfig (does not override)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel({
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: true },
        })),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      await provider.generate({
        model: 'gemini-2.5-flash',
        system: 'test',
        prompt: 'test',
        providerOptions: { google: { thinkingConfig: { thinkingBudget: 5000 } } },
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.providerOptions.google.thinkingConfig).toEqual({
        thinkingBudget: 5000,
      });
    });

    it('does not inject thinkingConfig for non-thinking models', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel()),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      await provider.generate({
        model: 'gemini-2.5-flash',
        system: 'test',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      // No providerOptions injected when no thinking capability
      expect(call.providerOptions?.google?.thinkingConfig).toBeUndefined();
    });

    it('maps cachedContentTokenCount to cached_input_tokens (disentangle §3.2)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 500, outputTokens: 200 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          google: {
            usageMetadata: {
              cachedContentTokenCount: 300,
            },
          },
        },
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel()),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      const result = await provider.generate({
        model: 'gemini',
        system: 'test',
        prompt: 'test',
      });

      expect(result.usage.cached_input_tokens).toBe(300);
      expect(result.usage.cache_read_input_tokens).toBeUndefined();
    });

    it('maps thoughtsTokenCount to thinking_tokens', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 500, outputTokens: 200 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          google: {
            usageMetadata: {
              thoughtsTokenCount: 1500,
            },
          },
        },
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel()),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      const result = await provider.generate({
        model: 'gemini',
        system: 'test',
        prompt: 'test',
      });

      expect(result.usage.thinking_tokens).toBe(1500);
    });

    it('uses plain string system message (no cache markup)', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 50, outputTokens: 25 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {},
      } as never);

      const catalog = mockCatalog({
        resolve: vi.fn().mockResolvedValue(makeGoogleModel()),
      });
      const provider = new AIProvider(googleConfig, catalog, noopLogger);
      await provider.generate({
        model: 'gemini',
        system: 'You are helpful.',
        prompt: 'test',
      });

      const call = mockGenerateText.mock.calls[0]?.[0] as any;
      expect(call.system).toBe('You are helpful.');
    });

    it('returns undefined for shell tool (no Google bash equivalent)', () => {
      const provider = new AIProvider(googleConfig, mockCatalog(), noopLogger);
      const tools = provider.createProviderShellTool('google', '/tmp/target', 30_000);
      expect(tools).toBeUndefined();
    });
  });

  describe('generic provider metadata scan', () => {
    it('extracts cache tokens from unknown provider metadata', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: { inputTokens: 400, outputTokens: 100 },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          deepseek: {
            cachedTokens: 250,
          },
        },
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const result = await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      // Disentangle (§3.2): unknown-provider cached input → cached_input_tokens.
      expect(result.usage.cached_input_tokens).toBe(250);
      expect(result.usage.cache_read_input_tokens).toBeUndefined();
    });

    it('does not override known provider cache values with generic scan', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      mockGenerateText.mockResolvedValueOnce({
        text: 'done',
        usage: {
          inputTokens: 400,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 150 },
        },
        steps: [],
        finishReason: 'stop',
        providerMetadata: {
          someProvider: {
            cachedTokens: 999,
          },
        },
      } as never);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      const result = await provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      });

      // AI SDK standard path value (150) should not be overridden by generic scan (999)
      expect(result.usage.cache_read_input_tokens).toBe(150);
    });
  });

  describe('FACTORY_NAME_OVERRIDES (behavioral)', () => {
    it('ensureProvider succeeds for google using factory name override', async () => {
      // Google uses a non-standard factory name (createGoogleGenerativeAI instead of createGoogle).
      // ensureProvider should use FACTORY_NAME_OVERRIDES to find the correct factory.
      const configWithGoogle: ResolvedConfig = {
        ...mockConfig,
        ai: {
          providers: {
            anthropic: { apiKey: 'test-key' },
            google: { apiKey: 'test-google-key' },
          },
          defaultProvider: 'anthropic',
        },
      };
      const provider = new AIProvider(configWithGoogle, mockCatalog(), noopLogger);

      // ensureProvider should use FACTORY_NAME_OVERRIDES to find createGoogleGenerativeAI
      await expect(provider.ensureProvider('google')).resolves.toBeUndefined();
    });
  });
});

describe('computeCostUsd (spec v0.6.0 Phase 1b — unit criterion 1b.5)', () => {
  const compute = (usage: Record<string, number | undefined>, cost: unknown): number | undefined => {
    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    return (provider as unknown as {
      computeCostUsd: (u: unknown, c: unknown) => number | undefined;
    }).computeCostUsd(usage, cost);
  };
  const sonnet = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  it('matches the hand-computed sonnet 3/15 sample', () => {
    // 1M input * $3/M + 100k output * $15/M = 3 + 1.5 = 4.5
    expect(compute({ input_tokens: 1_000_000, output_tokens: 100_000 }, sonnet)).toBeCloseTo(4.5, 10);
  });

  it('prices Anthropic cache reads/writes at their own rates', () => {
    // 10k in*3 + 1k out*15 + 100k cacheRead*0.3 + 20k cacheWrite*3.75 (per MTok)
    const usd = compute(
      { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 20_000 },
      sonnet,
    );
    expect(usd).toBeCloseTo((10_000 * 3 + 1_000 * 15 + 100_000 * 0.3 + 20_000 * 3.75) / 1e6, 10);
  });

  // NOTE ON FIXTURE SHAPE: input_tokens reaching computeCostUsd is CACHE-EXCLUSIVE —
  // mapUsage normalizes it (see UsageMetrics.input_tokens). The pre-v6 fixtures below
  // passed a GROSS input alongside cached_input_tokens and relied on this function to
  // subtract; that state is no longer reachable. The expected TOTALS are unchanged —
  // only the shape that produces them moved.

  it('prices the cache-served portion at cacheRead, on top of cache-exclusive input', () => {
    // 100k gross of which 40k cache-served arrives as 60k input + 40k cache_read:
    // 60k*3 + 40k*0.3 + 10k out*15
    const usd = compute(
      { input_tokens: 60_000, output_tokens: 10_000, cache_read_input_tokens: 40_000 },
      sonnet,
    );
    expect(usd).toBeCloseTo((60_000 * 3 + 40_000 * 0.3 + 10_000 * 15) / 1e6, 10);
  });

  it('falls back to the input rate for cache reads when no cacheRead rate exists (conservative overstatement)', () => {
    const usd = compute(
      { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 40_000 },
      { input: 3, output: 15 },
    );
    expect(usd).toBeCloseTo((100_000 * 3) / 1e6, 10);
  });

  it('does not double-count when reads and writes are both non-zero (run #69 F1/F2)', () => {
    // v6 unifies both cache-read channels into cache_read_input_tokens: the former
    // 40k "cached input" + 5k "genuine cache reads" is one 45k pool. Input is the
    // cache-exclusive 60k remainder; 2k cache writes priced at their own rate.
    const usd = compute(
      {
        input_tokens: 60_000,
        output_tokens: 10_000,
        cache_read_input_tokens: 45_000,
        cache_creation_input_tokens: 2_000,
      },
      sonnet,
    );
    // Identical total to the pre-v6 expectation — each pool still priced exactly once.
    expect(usd).toBeCloseTo(
      (60_000 * 3 + 45_000 * 0.3 + 10_000 * 15 + 2_000 * 3.75) / 1e6,
      10,
    );
  });

  it('does not charge cache-inclusive input at the full rate (the v6 regression)', () => {
    // Live capture 2026-08-22, claude-haiku-4-5 cache-READ step: raw input 8,
    // cache_read 9904, output 4. Pre-fix, input_tokens carried the 9912 total and the
    // 9904 was charged at the full input rate AND again at the cache rate.
    const usd = compute(
      { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 9904 },
      sonnet,
    );
    expect(usd).toBeCloseTo((8 * 3 + 4 * 15 + 9904 * 0.3) / 1e6, 10);
    // The pre-fix value, asserted as a floor the fix must stay below.
    const preFix = (9912 * 3 + 4 * 15 + 9904 * 0.3) / 1e6;
    expect(usd!).toBeLessThan(preFix);
  });

  it('prices cached_input_tokens when the provider reported no inputTokenDetails', () => {
    // The legacy-metadata fallback path (unknown provider via ai.additionalProviders):
    // mapUsage removes the cached portion from input_tokens but records it as
    // cached_input_tokens, NOT cache_read_input_tokens. Pricing only cache_read made
    // those tokens free — subtracted from input, charged nowhere. Reproduced live at
    // $0.330 vs the correct $0.342 on a 100k/40k split.
    const usd = compute(
      { input_tokens: 60_000, output_tokens: 10_000, cached_input_tokens: 40_000 },
      sonnet,
    );
    expect(usd).toBeCloseTo((60_000 * 3 + 40_000 * 0.3 + 10_000 * 15) / 1e6, 10);
    // Must be strictly greater than the buggy value that ignored the cached pool.
    expect(usd!).toBeGreaterThan((60_000 * 3 + 10_000 * 15) / 1e6);
  });

  it('falls back to the input rate for cache WRITES when no cacheWrite rate exists', () => {
    // Symmetric sibling of the cacheRead fallback test above. Mutation-confirmed gap:
    // changing `cost.cacheWrite ?? cost.input` to `?? 0` priced cache-creation tokens
    // FREE and passed every other test in this file. Same defect class this release
    // exists to close — a cache pool silently costing nothing — on the untested side.
    const usd = compute(
      { input_tokens: 10_000, output_tokens: 1_000, cache_creation_input_tokens: 20_000 },
      { input: 3, output: 15 },
    );
    expect(usd).toBeCloseTo((10_000 * 3 + 1_000 * 15 + 20_000 * 3) / 1e6, 10);
    // Must be strictly greater than the value that prices the write pool at zero.
    expect(usd!).toBeGreaterThan((10_000 * 3 + 1_000 * 15) / 1e6);
  });

  it('does not double-charge when BOTH cache_read and cached_input are present', () => {
    // The v6 details path can populate both (Google sets cache_read from details and
    // cached_input from metadata, to the same number). Exactly one must be priced.
    const usd = compute(
      {
        input_tokens: 60_000,
        output_tokens: 10_000,
        cache_read_input_tokens: 40_000,
        cached_input_tokens: 40_000,
      },
      sonnet,
    );
    expect(usd).toBeCloseTo((60_000 * 3 + 40_000 * 0.3 + 10_000 * 15) / 1e6, 10);
  });

  it('returns undefined — never 0 — when the model carries no pricing', () => {
    expect(compute({ input_tokens: 1_000_000, output_tokens: 100_000 }, undefined)).toBeUndefined();
    expect(compute({ input_tokens: 1_000_000, output_tokens: 100_000 }, null)).toBeUndefined();
  });

  it('returns a REAL 0 for zero usage on a priced model (error-fallback polarity)', () => {
    expect(compute({ input_tokens: 0, output_tokens: 0 }, sonnet)).toBe(0);
  });
});

describe('mapUsage — AI SDK v6 cache-inclusive input normalization', () => {
  const map = (usage: unknown, providerMetadata?: Record<string, unknown>): Record<string, number | undefined> => {
    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    return (provider as unknown as {
      mapUsage: (u: unknown, pm?: Record<string, unknown>) => Record<string, number | undefined>;
    }).mapUsage(usage, providerMetadata);
  };

  // These fixtures are VERBATIM AI SDK v6 usage objects captured from live calls on
  // 2026-08-22 (claude-haiku-4-5, ~10k cached prefix). They exist because every prior
  // token test hand-built a UsageMetrics and so bypassed this function entirely —
  // which is why the v5→v6 change in `inputTokens` semantics went undetected.
  // `inputTokens` here is the provider's `inputTokens.total`: it INCLUDES cache.

  it('excludes cache WRITES from input_tokens (live Anthropic capture)', () => {
    const u = map({
      inputTokens: 9912,
      outputTokens: 4,
      inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 9904 },
    });
    expect(u.input_tokens).toBe(8);
    expect(u.cache_creation_input_tokens).toBe(9904);
    expect(u.cache_read_input_tokens).toBe(0);
  });

  it('excludes cache READS from input_tokens (live Anthropic capture)', () => {
    const u = map({
      inputTokens: 9912,
      outputTokens: 4,
      inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 9904, cacheWriteTokens: 0 },
    });
    expect(u.input_tokens).toBe(8);
    expect(u.cache_read_input_tokens).toBe(9904);
  });

  it('never returns the cache-inclusive total as input_tokens', () => {
    // The single assertion that would have caught the regression at the v6 upgrade.
    const u = map({
      inputTokens: 9912,
      outputTokens: 4,
      inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 9904, cacheWriteTokens: 0 },
    });
    expect(u.input_tokens).not.toBe(9912);
  });

  it('falls back to subtracting a reported cached portion when a provider sends no details', () => {
    // Unknown provider via the generic tier: no inputTokenDetails, cached figure only
    // in providerMetadata. Normalization must still yield cache-exclusive input.
    const u = map({ inputTokens: 100_000, outputTokens: 10_000 }, { someprovider: { cachedTokens: 40_000 } });
    expect(u.cached_input_tokens).toBe(40_000);
    expect(u.input_tokens).toBe(60_000);
  });

  it('clamps the fallback at zero when the cached figure exceeds input', () => {
    const u = map({ inputTokens: 100, outputTokens: 50 }, { someprovider: { cachedTokens: 250 } });
    expect(u.input_tokens).toBe(0);
  });

  it('passes a no-cache call through unchanged (control — the fix must not move this)', () => {
    const u = map({
      inputTokens: 1234,
      outputTokens: 56,
      inputTokenDetails: { noCacheTokens: 1234, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(u.input_tokens).toBe(1234);
    expect(u.output_tokens).toBe(56);
  });
});

describe('aggregate usage across a multi-step tool loop', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reports totalUsage (all steps), not usage (last step only)', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      // Last step only — what the engine used to report.
      usage: {
        inputTokens: 4530, outputTokens: 120,
        inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 4522, cacheWriteTokens: 0 },
      },
      // Sum across all 8 steps of the loop.
      totalUsage: {
        inputTokens: 30_000, outputTokens: 2018,
        inputTokenDetails: { noCacheTokens: 1687, cacheReadTokens: 24_000, cacheWriteTokens: 4313 },
      },
      steps: [{ toolCalls: [{ id: '1' }] }, { toolCalls: [{ id: '2' }] }],
      finishReason: 'stop',
      providerMetadata: {},
    } as never);

    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

    expect(result.usage.input_tokens).toBe(1687);
    expect(result.usage.output_tokens).toBe(2018);
    expect(result.usage.cache_creation_input_tokens).toBe(4313);
    // The last-step figures must NOT be what surfaced.
    expect(result.usage.output_tokens).not.toBe(120);
  });

  it('falls back to usage when totalUsage is absent (pre-v6 mocks/callers)', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 100, outputTokens: 50 },
      steps: [],
      finishReason: 'stop',
      providerMetadata: {},
    } as never);

    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
  });
});

describe('mapUsage — unified reasoning/thinking tokens (v6)', () => {
  const map = (
    usage: unknown,
    providerMetadata?: Record<string, unknown>,
    provider?: string,
  ): Record<string, number | undefined> => {
    const p = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    return (p as unknown as {
      mapUsage: (u: unknown, pm?: Record<string, unknown>, pr?: string) => Record<string, number | undefined>;
    }).mapUsage(usage, providerMetadata, provider);
  };

  // Fixtures are verbatim v6 usage captured live 2026-08-22 from gpt-5-nano. The
  // openai providerMetadata block genuinely contains no usage fields — that is the
  // whole point: extractOpenAIUsage had nothing left to read.
  const OPENAI_META = { openai: { responseId: 'resp_06fec687', serviceTier: 'default' } };

  it('records OpenAI reasoning tokens from outputTokenDetails, not providerMetadata', () => {
    const u = map(
      {
        inputTokens: 11_464,
        outputTokens: 595,
        inputTokenDetails: { noCacheTokens: 11_464, cacheReadTokens: 0 },
        outputTokenDetails: { textTokens: 83, reasoningTokens: 512 },
      },
      OPENAI_META,
      'openai',
    );
    expect(u.reasoning_tokens).toBe(512);
    expect(u.thinking_tokens).toBeUndefined();
  });

  it('routes Google reasoning to thinking_tokens', () => {
    const u = map(
      {
        inputTokens: 20_000,
        outputTokens: 1_500,
        inputTokenDetails: { noCacheTokens: 18_000, cacheReadTokens: 2_000 },
        outputTokenDetails: { textTokens: 1_100, reasoningTokens: 400 },
      },
      undefined,
      'google',
    );
    expect(u.thinking_tokens).toBe(400);
    expect(u.reasoning_tokens).toBeUndefined();
  });

  it('keeps reasoning a SUBSET of output — never added on top', () => {
    const u = map(
      { inputTokens: 100, outputTokens: 595, outputTokenDetails: { textTokens: 83, reasoningTokens: 512 } },
      OPENAI_META,
      'openai',
    );
    // 83 text + 512 reasoning === the 595 reported total; output_tokens is the gross.
    expect(u.output_tokens).toBe(595);
  });

  it('would have recorded NOTHING under the metadata-only path (the regression)', () => {
    // Same live call, but with outputTokenDetails absent — i.e. what the old
    // metadata-only extractor had to work with. Asserts the loss this fix closes.
    const u = map({ inputTokens: 11_464, outputTokens: 595 }, OPENAI_META, 'openai');
    expect(u.reasoning_tokens).toBeUndefined();
  });

  it('still honours a legacy provider build that reports reasoning in metadata', () => {
    const u = map(
      { inputTokens: 100, outputTokens: 300 },
      { openai: { reasoningTokens: 250, responseId: 'resp_x' } },
      'openai',
    );
    expect(u.reasoning_tokens).toBe(250);
  });
});

describe('error mapping — branches that were dead under v5-shaped guards', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const generateWith = async (error: unknown) => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(error);
    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    return provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
  };

  it('unwraps a RetryError to its underlying cause — 429 exhaustion is a RateLimitError', async () => {
    // Previously mapped to SdkApiError(0), so a caller backing off on RateLimitError
    // saw nothing. RetryError carries no statusCode of its own; the cause does.
    // Codes MUST differ across attempts, or "last" and "first" are indistinguishable
    // and this assertion cannot detect a selection bug (mutation-confirmed: with
    // identical codes, swapping errors[length-1] for errors[0] failed nothing).
    const err = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [makeApiCallError('server error', 503), makeApiCallError('rate limited', 429)],
    });
    await expect(generateWith(err)).rejects.toThrow(RateLimitError);
  });

  it('reports the attempt count and reason on an exhausted retry', async () => {
    const err = new RetryError({
      message: 'Failed',
      reason: 'maxRetriesExceeded',
      errors: [makeApiCallError('rate limited', 429), makeApiCallError('boom', 503)],
    });
    await expect(generateWith(err)).rejects.toThrow(/2 attempt\(s\).*maxRetriesExceeded/);
    // The LAST attempt (503) decides the class, not the first (429).
    await expect(generateWith(err)).rejects.toThrow(ServiceUnavailableError);
  });

  it('maps a real AbortSignal.timeout rejection (name "TimeoutError") to TimeoutError', async () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    await expect(generateWith(err)).rejects.toThrow(TimeoutError);
  });

  it('does NOT treat a foreign error carrying statusCode as a provider error', async () => {
    // The old structural guard (`'statusCode' in error`) matched core's own errors and
    // any third-party HTTP error, remapping them as if the provider had returned them.
    const foreign = Object.assign(new Error('registry lookup failed'), { statusCode: 404 });
    // It still normalizes to SdkApiError (everything does), but it must NOT be given
    // the provider-404 diagnosis, which would blame a stale model catalog for what is
    // actually an unrelated HTTP failure.
    await expect(generateWith(foreign)).rejects.toThrow(/registry lookup failed/);
    await expect(generateWith(foreign)).rejects.not.toThrow(/STALE|Provider returned HTTP 404/);
  });
});

describe('structured output — non-"stop" finish must not kill the run (P0)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // useStructuredOutput requires the CAPABILITY, not just an `output` option. Without
  // this the guard under test is never reached and the assertions pass vacuously.
  const structuredOutputCatalog = () => mockCatalog({
    resolve: vi.fn().mockResolvedValue(
      makeResolvedModel({ capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never }),
    ),
  } as never);

  it('returns undefined structuredOutput instead of throwing when the loop hits the step ceiling', async () => {
    const { generateText } = await import('ai');
    // A result whose `output` getter THROWS, exactly as the SDK builds it when the last
    // step did not finish with 'stop'. Reading it unconditionally used to collapse the
    // run into SdkApiError(0) and make MaxStepsExhaustedError unreachable.
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'partial work',
      usage: { inputTokens: 10, outputTokens: 5 },
      totalUsage: { inputTokens: 10, outputTokens: 5 },
      steps: [{ toolCalls: [{ id: '1' }] }],
      finishReason: 'tool-calls',
      providerMetadata: {},
      get output() { throw new Error('NoOutputGeneratedError: must not be read'); },
    } as never);

    const provider = new AIProvider(mockConfig, structuredOutputCatalog(), noopLogger);
    const result = await provider.generate({
      model: 'sonnet',
      system: 's',
      prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });

    expect(result.finishReason).toBe('tool-calls');
    expect(result.structuredOutput).toBeUndefined();
    expect(result.text).toBe('partial work');
  });

  it('still reads output when the run finished with "stop"', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '{}',
      usage: { inputTokens: 10, outputTokens: 5 },
      totalUsage: { inputTokens: 10, outputTokens: 5 },
      steps: [],
      finishReason: 'stop',
      providerMetadata: {},
      output: { score: 91 },
    } as never);

    const provider = new AIProvider(mockConfig, structuredOutputCatalog(), noopLogger);
    const result = await provider.generate({
      model: 'sonnet',
      system: 's',
      prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });
    expect(result.structuredOutput).toEqual({ score: 91 });
  });
});

describe('provider warnings — the SDK drift channel core used to discard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('surfaces provider warnings on the result and logs them', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
      totalUsage: { inputTokens: 10, outputTokens: 5 },
      steps: [],
      finishReason: 'stop',
      providerMetadata: {},
      warnings: [
        { type: 'other', message: 'temperature is not supported when thinking is enabled' },
        { type: 'other', message: 'max_tokens clamped to model ceiling' },
      ],
    } as never);

    const warn = vi.fn();
    const provider = new AIProvider(mockConfig, mockCatalog(), { debug() {}, info() {}, warn, error() {} });
    const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

    expect(result.providerWarnings).toEqual([
      'temperature is not supported when thinking is enabled',
      'max_tokens clamped to model ceiling',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temperature is not supported'));
  });

  it('omits the field entirely when the provider warned about nothing', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      steps: [],
      finishReason: 'stop',
      providerMetadata: {},
      warnings: [],
    } as never);

    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
    expect(result.providerWarnings).toBeUndefined();
  });
});

describe('NoOutputGeneratedError fallback (mutation-identified gap)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Deleting this branch previously failed ZERO tests: the finishReason read guard
  // keeps the SDK from ever raising it, so nothing could observe its removal. It is
  // a second line of defence, and a defence nothing exercises is indistinguishable
  // from one that is not there. This rejects with the real, symbol-branded class.
  const structuredCatalog = (cost?: unknown) => mockCatalog({
    resolve: vi.fn().mockResolvedValue(
      makeResolvedModel({
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never,
        ...(cost ? { cost } : {}),
      } as never),
    ),
  } as never);

  it('degrades to text extraction instead of throwing SdkApiError(0)', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new NoOutputGeneratedError());

    const provider = new AIProvider(mockConfig, structuredCatalog({ input: 3, output: 15 }), noopLogger);
    const result = await provider.generate({
      model: 'sonnet',
      system: 's',
      prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });

    expect(result.structuredOutput).toBeUndefined();
    expect(result.finishReason).toBe('error');
    expect(result.text).toBe('');
    // No step ever reported usage, so the run cost is UNKNOWN, not free. Asserting a
    // real 0 here would fabricate a total; undefined propagates through sumCostUsd as
    // worst-child, which is the honest signal.
    expect(result.costUsd).toBeUndefined();
    expect(result.steps).toBe(0);
  });

  it('reports ACCUMULATED run totals on the fallback, not the last step', async () => {
    // The C1 regression: NoObjectGeneratedError carries lastStep.usage only. A run that
    // executed several steps must report what it actually spent, or a structured-output
    // failure silently understates real cost (measured 96% low on a 7-step run) and
    // zeroes step/tool telemetry.
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (opts: unknown) => {
      const o = opts as { onStepFinish?: (s: unknown) => void };
      for (let i = 0; i < 3; i++) {
        o.onStepFinish?.({
          finishReason: 'tool-calls',
          text: '',
          toolCalls: [{ toolName: 'read_file' }],
          usage: {
            inputTokens: 1_000,
            outputTokens: 100,
            inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
          },
        });
      }
      const err = new NoObjectGeneratedError({
        message: 'No object generated: response did not match schema.',
        text: 'partial text',
        finishReason: 'stop',
      } as never);
      throw err;
    }) as never);

    const provider = new AIProvider(mockConfig, structuredCatalog({ input: 3, output: 15, cacheRead: 0.3 }), noopLogger);
    const result = await provider.generate({
      model: 'sonnet',
      system: 's',
      prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });

    expect(result.text).toBe('partial text');
    expect(result.steps).toBe(3);
    expect(result.toolCallCount).toBe(3);
    // Accumulated: noCache 3*200=600, cacheRead 3*800=2400, output 3*100=300.
    expect(result.usage.input_tokens).toBe(600);
    expect(result.usage.output_tokens).toBe(300);
    expect(result.usage.cache_read_input_tokens).toBe(2_400);
    expect(result.costUsd).toBeCloseTo((600 * 3 + 300 * 15 + 2_400 * 0.3) / 1e6, 10);
  });

  it('keeps costUsd undefined — not 0 — when the model carries no pricing', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new NoOutputGeneratedError());

    const provider = new AIProvider(mockConfig, structuredCatalog(), noopLogger);
    const result = await provider.generate({
      model: 'sonnet',
      system: 's',
      prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });
    expect(result.costUsd).toBeUndefined();
  });

  it('does NOT swallow it when structured output was never requested', async () => {
    // The guard is `useStructuredOutput && isInstance` — without the flag this must
    // still surface as a thrown error rather than a silent degraded result.
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new NoOutputGeneratedError());

    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    await expect(provider.generate({ model: 'sonnet', system: 's', prompt: 'p' })).rejects.toThrow();
  });
});

describe('adversarial provider payloads (ship-gate runtime audit)', () => {
  const map = (usage: unknown, pm?: Record<string, unknown>, provider?: string): Record<string, number | undefined> => {
    const p = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    return (p as unknown as {
      mapUsage: (u: unknown, m?: Record<string, unknown>, pr?: string) => Record<string, number | undefined>;
    }).mapUsage(usage, pm, provider);
  };
  const cost = (usage: Record<string, number | undefined>): number | undefined => {
    const p = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    return (p as unknown as {
      computeCostUsd: (u: unknown, c: unknown) => number | undefined;
    }).computeCostUsd(usage, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  };

  it('clamps a negative noCacheTokens rather than propagating it into cost', () => {
    // OpenAI/Google compute noCache as `prompt − cached` with independently-defaulted
    // operands, so an endpoint omitting prompt_tokens while reporting cached_tokens
    // yields a negative. A negative cost SUBTRACTS from a pipeline roll-up.
    const u = map({
      inputTokens: 1_000,
      outputTokens: 100,
      inputTokenDetails: { noCacheTokens: -500, cacheReadTokens: 1_500, cacheWriteTokens: 0 },
    });
    expect(u.input_tokens).toBe(0);
    expect(u.input_tokens).not.toBeLessThan(0);
    expect(cost(u)!).toBeGreaterThanOrEqual(0);
  });

  it('neutralises NaN before it can reach cost (?? does not catch NaN)', () => {
    const u = map({ inputTokens: NaN, outputTokens: 100 });
    expect(Number.isFinite(u.input_tokens!)).toBe(true);
    expect(u.input_tokens).toBe(0);
    const c = cost(u);
    expect(Number.isFinite(c!)).toBe(true);
    // The failure this prevents: NaN JSON-serializes to null, blanking a whole run.
    expect(JSON.parse(JSON.stringify({ costUsd: c })).costUsd).not.toBeNull();
  });

  it('neutralises Infinity the same way', () => {
    const u = map({ inputTokens: Infinity, outputTokens: 100 });
    expect(u.input_tokens).toBe(0);
    expect(Number.isFinite(cost(u)!)).toBe(true);
  });

  it('removes the cache pools on the legacy path so they are not charged twice', () => {
    // Anthropic-shaped metadata with NO inputTokenDetails — the shape that left
    // input_tokens cache-inclusive and then billed the pool again at its own rate
    // (measured $0.0334692 against a true $0.0037572).
    const u = map({ inputTokens: 9_916, outputTokens: 0 }, {
      anthropic: { cacheReadInputTokens: 9_904, cacheCreationInputTokens: 0 },
    });
    expect(u.input_tokens).toBe(12);
    expect(u.input_tokens).not.toBe(9_916);
    expect(cost(u)).toBeCloseTo((12 * 3 + 9_904 * 0.3) / 1e6, 10);
  });
});

/**
 * ── The class the previous round closed only at its citations ─────────────────────────
 *
 * Every fix in the 0.42.0 cycle was verified at the line it was reported at, and the same
 * defect was then found one path, one file, or one layer away. These tests exist to pin
 * the INVARIANTS rather than the citations:
 *
 *   1. ABSENT IS NOT ZERO — a pool nothing reported must not arrive downstream as 0.
 *   2. THE FALLBACK IS NOT A SECOND PATH — degraded results are built by the same
 *      extraction as successful ones.
 *   3. UNKNOWN COST PROPAGATES AS UNKNOWN — never as a fabricated $0.
 *
 * Each carries a positive control: the comment records what fails when the fix is
 * reverted, and each was confirmed to fail against the pre-fix code before being kept.
 */
describe('AIProvider — absent-vs-zero and fallback-path parity', () => {
  // Reset generateText's implementation, not just its call log. `vi.clearAllMocks()`
  // alone leaves any UNCONSUMED `mockImplementationOnce`/`mockRejectedValueOnce` queued
  // from an earlier describe, and a queued once-impl takes priority over this block's
  // own `mockResolvedValue` — so these tests would silently run someone else's fixture.
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  const stepsCatalog = (cost?: unknown) => mockCatalog({
    resolve: vi.fn().mockResolvedValue(
      makeResolvedModel({
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never,
        ...(cost ? { cost } : {}),
      } as never),
    ),
  } as never);

  /** The SDK's own null-usage shape: present object, every member undefined. */
  const nullUsage = () => ({
    inputTokens: undefined,
    outputTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  });

  /** Drive N steps through onStepFinish, then reject, forcing the fallback path. */
  const runStepsThenFail = async (
    steps: unknown[],
    opts: { cost?: unknown; providerMetadata?: unknown; warnings?: unknown[] } = {},
  ) => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (o: unknown) => {
      const g = o as { onStepFinish?: (s: unknown) => void };
      for (const s of steps) g.onStepFinish?.(s);
      throw new NoObjectGeneratedError({ message: 'no object', text: '', finishReason: 'tool-calls' } as never);
    }) as never);
    const provider = new AIProvider(mockConfig, stepsCatalog(opts.cost), noopLogger);
    return provider.generate({
      model: 'sonnet', system: 's', prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });
  };

  const step = (usage: unknown, extra: Record<string, unknown> = {}) => ({
    finishReason: 'tool-calls', text: '', toolCalls: [{ toolName: 'read_file' }], usage, ...extra,
  });

  // ── Invariant 1: absent is not zero ────────────────────────────────────────────────
  it('reports UNKNOWN cost when steps ran but no step reported a token NUMBER', async () => {
    // POSITIVE CONTROL: revert the `sawUsage` assignment to `if (usage)` and this fails
    // with costUsd === 0. `step.usage` is a REQUIRED field the SDK always materializes via
    // createNullLanguageModelUsage(), so `if (usage)` is a tautology — it meant "a step
    // finished", never "a step reported numbers". The pre-fix test covered only the
    // ZERO-step case, where the flag stayed false for an unrelated reason, so it passed
    // vacuously while three steps produced a fabricated real $0.
    const result = await runStepsThenFail(
      [step(nullUsage()), step(nullUsage()), step(nullUsage())],
      { cost: { input: 3, output: 15 } },
    );

    expect(result.steps).toBe(3);
    expect(result.costUsd).toBeUndefined();
    expect(result.costUsd).not.toBe(0);
  });

  it('keeps a real reported zero distinguishable from nothing reported', async () => {
    // The other side of invariant 1, and the reason the guard reads the NUMBERS rather
    // than the wrapper: a provider that genuinely reports 0 tokens has reported something.
    const result = await runStepsThenFail(
      [step({ ...nullUsage(), inputTokens: 0, outputTokens: 0 })],
      { cost: { input: 3, output: 15 } },
    );

    expect(result.costUsd).toBe(0);
    expect(result.costUsd).not.toBeUndefined();
  });

  it('does not fabricate noCacheTokens: 0 for a provider that reports no token details', async () => {
    // POSITIVE CONTROL: make stepTotalsToUsage emit `noCacheTokens: t.noCacheTokens`
    // unconditionally and this fails with input_tokens === 0 and costUsd === $0.045.
    //
    // The accumulator's `?? 0` destroyed absent-vs-zero, so the converted usage always
    // carried a numeric noCacheTokens — which sent mapUsage down its EXACT normalization
    // branch and zeroed the whole input pool for exactly the population the LEGACY branch
    // exists to serve (providers reporting inputTokens with no inputTokenDetails).
    // Measured against the success path on identical usage: $0.045 vs a true $0.495.
    const legacyStep = step({
      inputTokens: 50_000,
      outputTokens: 1_000,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    });
    const result = await runStepsThenFail([legacyStep, legacyStep, legacyStep], {
      cost: { input: 3, output: 15 },
    });

    expect(result.usage.input_tokens).toBe(150_000);
    expect(result.usage.input_tokens).not.toBe(0);
    expect(result.costUsd).toBeCloseTo((150_000 * 3 + 3_000 * 15) / 1e6, 10);
  });

  // ── Invariant 2: the fallback is not a second construction path ────────────────────
  it('runs the provider extract tiers on the fallback, routing Google thinking correctly', async () => {
    // POSITIVE CONTROL: drop the providerMetadata/provider arguments from
    // buildFallbackResult's mapUsage call and this fails — thinking_tokens undefined,
    // the count landing in reasoning_tokens instead.
    //
    // The fallback used to call mapUsage with one of three arguments, which killed all
    // four extract tiers on the degraded path: Google thinking misrouted, and an unknown
    // provider whose cache pool arrives only in metadata went entirely unpriced.
    const catalogGoogle = mockCatalog({
      resolve: vi.fn().mockResolvedValue(
        makeResolvedModel({
          provider: 'google',
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never,
        } as never),
      ),
    } as never);

    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (o: unknown) => {
      const g = o as { onStepFinish?: (s: unknown) => void };
      g.onStepFinish?.(step(
        {
          inputTokens: 1_000, outputTokens: 400,
          inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: 400 },
        },
        { providerMetadata: { google: { usageMetadata: { thoughtsTokenCount: 400 } } } },
      ));
      throw new NoObjectGeneratedError({ message: 'x', text: '', finishReason: 'tool-calls' } as never);
    }) as never);

    const googleConfig: ResolvedConfig = {
      ...mockConfig,
      ai: {
        ...mockConfig.ai,
        providers: { ...mockConfig.ai.providers, google: { apiKey: 'test-google-key' } },
      },
    };
    const provider = new AIProvider(googleConfig, catalogGoogle, noopLogger);
    const result = await provider.generate({
      model: 'gemini', system: 's', prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });

    expect(result.usage.thinking_tokens).toBe(400);
    expect(result.usage.reasoning_tokens).toBeUndefined();
  });

  it('surfaces providerWarnings and usageShapeDrift on a fallback result', async () => {
    // POSITIVE CONTROL: remove the two spread lines from buildFallbackResult and this
    // fails with both undefined.
    //
    // These are the two instruments this release ADDED to detect silent SDK drift, and
    // they were absent from every degraded result — dark precisely on the path where
    // drift bites. Provider option schemas parse in Zod strip mode, so warnings are the
    // only channel that reports a setting failing to apply.
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (o: unknown) => {
      const g = o as { onStepFinish?: (s: unknown) => void };
      g.onStepFinish?.(step(nullUsage(), {
        warnings: [{ type: 'unsupported', feature: 'thinking', details: 'not on this model' }],
        providerMetadata: { anthropic: { cache_creation: 5, cache_read: 3 } },
      }));
      throw new NoObjectGeneratedError({ message: 'x', text: '', finishReason: 'tool-calls' } as never);
    }) as never);

    const provider = new AIProvider(mockConfig, stepsCatalog(), noopLogger);
    const result = await provider.generate({
      model: 'sonnet', system: 's', prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });

    expect(result.providerWarnings).toEqual(['unsupported: thinking — not on this model']);
    expect(result.usageShapeDrift).toEqual(['anthropic']);
  });
});

describe('AIProvider — CallWarning discriminants and abort names', () => {
  // Reset generateText's implementation, not just its call log. `vi.clearAllMocks()`
  // alone leaves any UNCONSUMED `mockImplementationOnce`/`mockRejectedValueOnce` queued
  // from an earlier describe, and a queued once-impl takes priority over this block's
  // own `mockResolvedValue` — so these tests would silently run someone else's fixture.
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  it('formats every CallWarning variant, not only the message-bearing one', async () => {
    // POSITIVE CONTROL: cast the warning to `{message?: string}` instead of narrowing on
    // `w.type` and the two feature-bearing variants render as "undefined".
    //
    // Only the 'other' fixture was exercised before. 'unsupported' and 'compatibility'
    // carry feature/details and NO message (verified against @ai-sdk/provider's
    // SharedV3Warning), so the untested branch was the discriminated-union field-access
    // class this whole release is about.
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
      steps: [],
      finishReason: 'stop',
      warnings: [
        { type: 'other', message: 'plain message' },
        { type: 'unsupported', feature: 'thinking', details: 'not on this model' },
        { type: 'compatibility', feature: 'toolChoice' },
      ],
    } as never);

    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    const result = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });

    expect(result.providerWarnings).toEqual([
      'plain message',
      'unsupported: thinking — not on this model',
      'compatibility: toolChoice',
    ]);
    // Nothing rendered as the string "undefined" — the failure mode a cast produces.
    for (const w of result.providerWarnings!) expect(w).not.toContain('undefined');
  });

  it.each([
    ['TimeoutError'],
    ['AbortError'],
    ['ResponseAborted'],
  ])('maps a DOMException named %s to TimeoutError', async (name) => {
    // POSITIVE CONTROL: drop any one alternative from the abort-name set and that row
    // fails. Previously only 'TimeoutError' was exercised, so removing the other two
    // would have passed the suite untouched — the guard claimed three names and proved
    // one.
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new DOMException('aborted', name));

    const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
    await expect(
      provider.generate({ model: 'sonnet', system: 's', prompt: 'p', timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

/**
 * The wrap-up brake reports only what actually happened.
 *
 * `structuredOutputMode: 'jsonTool'` — core's own default for every Anthropic structured-
 * output call — makes the provider HARD-OVERRIDE toolChoice to select its json tool, so
 * `prepareStep`'s `toolChoice: 'none'` never applies. The latch nonetheless marked a
 * forced wrap-up, `collectExecutionMarkers` emitted a `severity: 'degraded'` marker, and
 * `deriveCompleteness` returned 'partial'. A complete run on the dominant provider path
 * was stamped degraded for an event that never occurred.
 *
 * Repairing the brake itself means changing structured-output strategy — a separate
 * decision, deliberately not taken here. What is withdrawn is the false CLAIM.
 *
 * POSITIVE CONTROL: drop the `brakeIsHonored &&` guards and the first test fails with
 * forcedWrapUp === true. Confirmed against the pre-fix code.
 */
describe('AIProvider — the wrap-up latch does not claim a brake that cannot engage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  const runWithBudget = async (opts: { structured: boolean }) => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'done',
      usage: { inputTokens: 50_000, outputTokens: 2_000 },
      steps: [{ toolCalls: [] }],
      finishReason: 'stop',
      providerMetadata: {},
    } as never);

    const tracker = new TokenBudgetTracker(100_000);
    const catalog = mockCatalog({
      resolve: vi.fn().mockResolvedValue(
        makeResolvedModel({
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never,
        } as never),
      ),
    } as never);

    await new AIProvider(mockConfig, catalog, noopLogger).generate({
      model: 'sonnet', system: 't', prompt: 't',
      contextBudget: 100_000,
      budgetTracker: tracker,
      ...(opts.structured ? { output: { type: 'output-object', schema: {} } as never } : {}),
    });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as any;
    return { tracker, call };
  };

  it('does NOT latch on an Anthropic jsonTool structured-output run', async () => {
    const { tracker, call } = await runWithBudget({ structured: true });

    // The brake is still attempted — the run's behavior is unchanged.
    expect(call.prepareStep({ steps: [{ usage: { inputTokens: 85_000 } }] }).toolChoice).toBe('none');
    // But nothing claims a wrap-up happened, because the provider ignores that toolChoice.
    expect(tracker.forcedWrapUp).toBe(false);
  });

  it('DOES latch on a non-structured run, where the brake really applies', async () => {
    // The control that proves the guard is not simply disabling the latch everywhere —
    // without it, "does not latch" would pass for the wrong reason.
    const { tracker, call } = await runWithBudget({ structured: false });

    call.prepareStep({ steps: [{ usage: { inputTokens: 85_000 } }] });
    expect(tracker.forcedWrapUp).toBe(true);
    call.prepareStep({ steps: [{ usage: { inputTokens: 65_000 } }] });
    expect(tracker.forcedWrapUp).toBe(false);
  });

  it('still warns at the budget crossing, so the event stays visible', async () => {
    // Withdrawing the marker must not make the budget crossing invisible — the operator
    // still needs to know, and the message says the brake could not engage.
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'done', usage: { inputTokens: 50_000, outputTokens: 2_000 },
      steps: [{ toolCalls: [] }], finishReason: 'stop', providerMetadata: {},
    } as never);

    const warn = vi.fn();
    const catalog = mockCatalog({
      resolve: vi.fn().mockResolvedValue(
        makeResolvedModel({
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never,
        } as never),
      ),
    } as never);

    await new AIProvider(mockConfig, catalog, { debug() {}, info() {}, warn, error() {} }).generate({
      model: 'sonnet', system: 't', prompt: 't',
      contextBudget: 100_000,
      budgetTracker: new TokenBudgetTracker(100_000),
      output: { type: 'output-object', schema: {} } as never,
    });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as any;
    call.prepareStep({ steps: [{ usage: { inputTokens: 85_000 } }] });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Context budget 80% used'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot engage'));
  });
});

/**
 * A throw during result ASSEMBLY must be mapped AND must not lose the billed usage.
 *
 * Narrowing generate()'s try to the provider call alone was right — a throw there is not
 * a generation failure and must not be reported as a zero-cost fallback. But leaving
 * assembly bare traded one defect for another: `result.output` is a throwing getter and
 * mapUsage runs there too, so a throw escaped generate() WITHOUT reaching mapError.
 *
 * POSITIVE CONTROL: remove the second try/catch around buildGenerateResult and both tests
 * below fail — the first with a raw (unmapped) error, the second because no result comes
 * back at all. The previous suite passed that mutation untouched: nothing made assembly
 * throw, so the branch was defended and unexercised, which is indistinguishable from
 * absent. Found by the stage-2 validator's own mutation probe, not by this file's author.
 */
describe('AIProvider — a throw during result assembly is mapped and keeps the usage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  /**
   * Drive real steps (so usage IS billed), return a result whose `output` getter throws
   * during assembly — the SDK's actual shape for an unresolved structured output.
   */
  const runWithThrowingAssembly = async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (o: unknown) => {
      const g = o as { onStepFinish?: (s: unknown) => void };
      g.onStepFinish?.({
        finishReason: 'stop', text: 'partial', toolCalls: [{ toolName: 'read_file' }],
        usage: {
          inputTokens: 10_000, outputTokens: 500,
          inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        },
      });
      const result: Record<string, unknown> = {
        text: 'partial', steps: [{ toolCalls: [] }], finishReason: 'stop',
        usage: { inputTokens: 10_000, outputTokens: 500 },
        totalUsage: { inputTokens: 10_000, outputTokens: 500 },
        providerMetadata: {}, warnings: [],
      };
      // The throwing getter, exactly as the SDK declares it.
      Object.defineProperty(result, 'output', {
        get() { throw new NoOutputGeneratedError(); },
      });
      return result;
    }) as never);

    const catalog = mockCatalog({
      resolve: vi.fn().mockResolvedValue(
        makeResolvedModel({
          cost: { input: 3, output: 15 },
          capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true } as never,
        } as never),
      ),
    } as never);

    return new AIProvider(mockConfig, catalog, noopLogger).generate({
      model: 'sonnet', system: 's', prompt: 'p',
      output: { type: 'output-object', schema: {} } as never,
    });
  };

  it('does not let a raw AI_NoOutputGeneratedError escape generate()', async () => {
    // Unmapped, the caller receives an SDK-internal class instead of a core error type,
    // and every `catch (UluOpsError)` handler misses it.
    const result = await runWithThrowingAssembly();
    expect(result).toBeDefined();
    expect(result.finishReason).toBe('error');
  });

  it('still reports the usage that was already billed before the throw', async () => {
    // The half that a bare try/catch would also get wrong: mapping the error but losing
    // the tokens just converts a fabricated zero into a rejection. stepTotals still holds
    // the real numbers, so the degraded result must carry them.
    const result = await runWithThrowingAssembly();

    expect(result.usage.input_tokens).toBe(10_000);
    expect(result.usage.output_tokens).toBe(500);
    expect(result.costUsd).toBeCloseTo((10_000 * 3 + 500 * 15) / 1e6, 10);
    expect(result.costUsd).not.toBe(0);
  });
});

/**
 * Provider metadata is EXTERNAL data on every tier, not just the primary one.
 *
 * POSITIVE CONTROL: drop `optionalTokenCount` from any metadata tier and the matching test
 * below fails. Confirmed by mutation on the anthropic tier.
 *
 * The rule is stated in mapUsage's own doc — "Provider payloads are EXTERNAL data; `?? 0`
 * reads like a numeric guarantee and is not one" — and was enforced, and tested, only on
 * the SDK-standard path. The four metadata tiers, which ARE the legacy/unknown-provider
 * fallback route this release exists to correct, assigned raw. Measured before the fix:
 * `cacheReadInputTokens: -5000` against 10,000 reported input produced `input_tokens:
 * 15000` — a 50% inflation — and $0.0435 against a true $0.030, FINITE the whole way, so
 * both sumCostUsd's and sumTokenMetrics' finiteness guards passed it straight through.
 */
describe('AIProvider — metadata tiers guard external numbers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  const runWithMetadata = async (providerMetadata: unknown, provider = 'anthropic') => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      // No inputTokenDetails: forces the legacy/metadata route these tiers serve.
      usage: { inputTokens: 10_000, outputTokens: 100 },
      totalUsage: { inputTokens: 10_000, outputTokens: 100 },
      steps: [], finishReason: 'stop', warnings: [],
      providerMetadata,
    } as never);

    const catalog = mockCatalog({
      resolve: vi.fn().mockResolvedValue(
        makeResolvedModel({ provider, cost: { input: 3, output: 15 } } as never),
      ),
    } as never);
    const config = provider === 'anthropic' ? mockConfig : {
      ...mockConfig,
      ai: { ...mockConfig.ai, providers: { ...mockConfig.ai.providers, [provider]: { apiKey: 'k' } } },
    } as ResolvedConfig;

    return new AIProvider(config, catalog, noopLogger).generate({ model: 'm', system: 's', prompt: 'p' });
  };

  it('clamps a NEGATIVE cache figure instead of inflating input_tokens', async () => {
    const result = await runWithMetadata({
      anthropic: { cacheReadInputTokens: -5_000, cacheCreationInputTokens: 0 },
    });

    // The measured defect: subtracting -5000 ADDED 5000, yielding 15000 from 10000.
    expect(result.usage.input_tokens).toBe(10_000);
    expect(result.usage.input_tokens).not.toBe(15_000);
    expect(result.usage.cache_read_input_tokens).toBe(0);
    // And the dollar figure that rode on it.
    expect(result.costUsd).toBeCloseTo((10_000 * 3 + 100 * 15) / 1e6, 10);
    expect(result.costUsd).not.toBeCloseTo(0.0435, 4);
  });

  it('neutralises a NaN cache figure so the run stays priced', async () => {
    // NaN was the worse case: it produced a NaN cost, which JSON-serializes to null and
    // is then indistinguishable from an unpriced model — blanking a whole pipeline.
    const result = await runWithMetadata({
      anthropic: { cacheReadInputTokens: NaN, cacheCreationInputTokens: NaN },
    });

    expect(Number.isFinite(result.usage.input_tokens)).toBe(true);
    expect(Number.isFinite(result.costUsd!)).toBe(true);
    expect(Number.isNaN(result.costUsd!)).toBe(false);
  });

  it('guards the Google tier the same way', async () => {
    const result = await runWithMetadata({
      google: { usageMetadata: { cachedContentTokenCount: -1_000, thoughtsTokenCount: NaN } },
    }, 'google');

    // EXACT values, not `isFinite` and `>= 0`. Those weaker assertions passed with the
    // guard REMOVED — an unguarded -1,000 gets subtracted (10,000 − −1,000 = 11,000), and
    // 11,000 is both finite and positive, so the test could only ever confirm. The
    // discriminating question is the number itself.
    expect(result.usage.input_tokens).toBe(10_000);
    expect(result.usage.input_tokens).not.toBe(11_000);
    expect(result.usage.cached_input_tokens).toBe(0);
    // 0, not undefined: optionalTokenCount preserves "not reported" as undefined but
    // clamps a reported-yet-unusable value (NaN) to 0. A garbage figure IS a report, and
    // this matches the contract already applied on the SDK-standard path.
    expect(result.usage.thinking_tokens).toBe(0);
    expect(Number.isFinite(result.costUsd!)).toBe(true);
  });

  it('still passes a WELL-FORMED metadata figure through — the negative control', async () => {
    // Proves the guards clamp bad values rather than discarding every value.
    const result = await runWithMetadata({
      anthropic: { cacheReadInputTokens: 4_000, cacheCreationInputTokens: 0 },
    });

    expect(result.usage.cache_read_input_tokens).toBe(4_000);
    expect(result.usage.input_tokens).toBe(6_000); // 10,000 total − 4,000 cache-served
  });
});

/**
 * The budget tracker must not treat a null-usage step as a zero-size context window.
 *
 * POSITIVE CONTROL: remove the presence guard at the `budgetTracker.update` call and the
 * first test fails, reporting `usedTotal: 0` after a real 50,000-token step.
 *
 * This call sits three lines above the StepTotals accumulator that received exactly this
 * fix, fed `?? 0` from the same `usage` object — the one the SDK materializes with every
 * member undefined when a provider reports nothing. `update()` assigns
 * `currentContextTokens` unconditionally, so one null-usage step reset the tracked window
 * to 0: `get_token_budget` then told the model it had the full budget remaining mid-run.
 */
describe('AIProvider — a null-usage step does not reset the tracked context window', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  const nullUsageStep = {
    inputTokens: undefined, outputTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  };

  const driveSteps = async (steps: unknown[], tracker: TokenBudgetTracker) => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockImplementationOnce((async (o: unknown) => {
      const g = o as { onStepFinish?: (s: unknown) => void };
      for (const s of steps) g.onStepFinish?.(s);
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, totalUsage: { inputTokens: 1, outputTokens: 1 },
        steps: [], finishReason: 'stop', warnings: [], providerMetadata: {} };
    }) as never);

    await new AIProvider(mockConfig, mockCatalog(), noopLogger).generate({
      model: 'sonnet', system: 's', prompt: 'p', contextBudget: 100_000, budgetTracker: tracker,
    });
  };

  it('preserves the window measured by the previous real step', async () => {
    const tracker = new TokenBudgetTracker(100_000);
    await driveSteps([
      { finishReason: 'tool-calls', text: '', toolCalls: [], usage: { ...nullUsageStep, inputTokens: 50_000, outputTokens: 100 } },
      { finishReason: 'tool-calls', text: '', toolCalls: [], usage: nullUsageStep },
    ], tracker);

    // The null-usage step carries no information about the window, so the last real
    // measurement must stand.
    expect(tracker.getStatus().usedTotal).toBe(50_000);
    expect(tracker.getStatus().usedTotal).not.toBe(0);
    expect(tracker.getStatus().remaining).toBe(50_000);
  });

  it('still tracks a step that reports a genuine ZERO', async () => {
    // Absent and zero must stay distinguishable in BOTH directions — a provider that
    // really reports 0 has reported something, and the tracker should take it.
    const tracker = new TokenBudgetTracker(100_000);
    await driveSteps([
      { finishReason: 'tool-calls', text: '', toolCalls: [], usage: { ...nullUsageStep, inputTokens: 50_000, outputTokens: 100 } },
      { finishReason: 'tool-calls', text: '', toolCalls: [], usage: { ...nullUsageStep, inputTokens: 0, outputTokens: 0 } },
    ], tracker);

    expect(tracker.getStatus().usedTotal).toBe(0);
  });
});

/**
 * The wrap-up brake reads the window, and a non-measurement is not a window of zero.
 *
 * POSITIVE CONTROL: restore `const contextSize = lastStep.usage.inputTokens ?? 0` and the
 * first two tests fail. Confirmed by mutation.
 *
 * This was the FOURTH consecutive gate abort and the third reader of this same object to
 * need the same correction. Measured before the fix: after latching at 85,000/100,000, one
 * null-usage step drove contextSize to 0, released the latch, WITHDREW the
 * `budget.forced-wrap-up` marker (so deriveCompleteness reported 'complete' for a run
 * whose coverage really was cut), disengaged the brake so the cost ceiling lapsed above
 * 80%, and logged "Context budget recovered (0/100000)" — a recovery that never happened.
 */
describe('AIProvider — a null-usage step does not release the wrap-up brake', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  const armedBrake = async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'done', usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      steps: [], finishReason: 'stop', warnings: [], providerMetadata: {},
    } as never);

    const tracker = new TokenBudgetTracker(100_000);
    await new AIProvider(mockConfig, mockCatalog(), noopLogger).generate({
      model: 'sonnet', system: 't', prompt: 't', contextBudget: 100_000, budgetTracker: tracker,
    });
    const call = vi.mocked(generateText).mock.calls[0]?.[0] as any;
    // Latch it: 85% of budget.
    call.prepareStep({ steps: [{ usage: { inputTokens: 85_000 } }] });
    return { tracker, call };
  };

  it('holds the latch when a step reports no numbers', async () => {
    const { tracker, call } = await armedBrake();
    expect(tracker.forcedWrapUp).toBe(true);

    const next = call.prepareStep({ steps: [{ usage: { inputTokens: undefined } }] });

    // The brake stays engaged and the marker is not withdrawn.
    expect(next.toolChoice).toBe('none');
    expect(tracker.forcedWrapUp).toBe(true);
  });

  it('does not report a recovery that never happened', async () => {
    const { tracker, call } = await armedBrake();
    call.prepareStep({ steps: [{ usage: {} }] });
    // markForcedWrapUp(false) here would silently turn a coverage-reduced run into
    // completeness 'complete' — the invariant types/degradation.ts rests on.
    expect(tracker.forcedWrapUp).toBe(true);
  });

  it('STILL releases on a genuine measured recovery — the negative control', async () => {
    // Without this, "holds the latch" would pass for a brake that could never release,
    // which would force premature wrap-up for the rest of every run.
    const { tracker, call } = await armedBrake();
    const next = call.prepareStep({ steps: [{ usage: { inputTokens: 65_000 } }] });

    expect(next.toolChoice).toBeUndefined();
    expect(tracker.forcedWrapUp).toBe(false);
  });
});

/**
 * The PRIMARY reasoning source gets the same guard as its four fallbacks.
 *
 * POSITIVE CONTROL: restore `if (unifiedReasoning)` truthiness and the second test fails
 * with 777 — a number nobody measured, on a run that explicitly reported zero.
 */
describe('AIProvider — unified reasoning is clamped and zero-preserving', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockReset();
  });

  const run = async (outputTokenDetails: unknown, providerMetadata: unknown = {}) => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 1_000, outputTokens: 500, outputTokenDetails },
      totalUsage: { inputTokens: 1_000, outputTokens: 500, outputTokenDetails },
      steps: [], finishReason: 'stop', warnings: [], providerMetadata,
    } as never);
    return new AIProvider(mockConfig, mockCatalog(), noopLogger)
      .generate({ model: 'sonnet', system: 's', prompt: 'p' });
  };

  it('clamps a negative reasoning count instead of putting it on the result', async () => {
    // 68ec686 opened the wire path for this field, so an unclamped negative now reaches
    // the tracker and SUBTRACTS from a roll-up.
    const result = await run({ textTokens: 500, reasoningTokens: -5_000 });
    expect(result.usage.reasoning_tokens).toBe(0);
    expect(result.usage.reasoning_tokens).not.toBe(-5_000);
  });

  it('keeps a MEASURED zero rather than letting legacy metadata override it', async () => {
    // `if (unifiedReasoning)` is falsy for 0, so the field stayed undefined and the `??=`
    // legacy tier won — contradicting the documented invariant that `??=` "can never
    // override the unified value".
    const result = await run(
      { textTokens: 500, reasoningTokens: 0 },
      { openai: { reasoningTokens: 777 } },
    );
    expect(result.usage.reasoning_tokens).toBe(0);
    expect(result.usage.reasoning_tokens).not.toBe(777);
  });

  it('still reads a genuine reasoning count — the negative control', async () => {
    const result = await run({ textTokens: 100, reasoningTokens: 400 });
    expect(result.usage.reasoning_tokens).toBe(400);
  });
});
