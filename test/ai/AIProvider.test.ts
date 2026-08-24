import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIProvider } from '../../src/ai/AIProvider.js';
import { TokenBudgetTracker } from '../../src/ai/TokenBudgetTracker.js';
import type { ModelCatalog, ResolvedModel } from '../../src/ai/ModelCatalog.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';
import { APICallError, RetryError, NoOutputGeneratedError } from 'ai';
import {
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  TimeoutError,
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
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognized shape'));

      // Chronic once present — warn fires once per provider per process, but
      // the per-run drift flag keeps flowing.
      const again = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
      expect(again.usageShapeDrift).toEqual(['anthropic']);
      expect(warn.mock.calls.filter(c => String(c[0]).includes('unrecognized shape'))).toHaveLength(1);
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

      // Falls back to subtracting the provider-reported cached portion: 200 − 50 = 150.
      expect(result.usage.input_tokens).toBe(150);
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
    // A PRICED model with zero usage must yield a REAL 0, never undefined —
    // undefined is reserved for "this model carries no pricing at all", and
    // sumCostUsd depends on that polarity to distinguish free from unknown.
    expect(result.costUsd).toBe(0);
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
