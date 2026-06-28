import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIProvider } from '../../src/ai/AIProvider.js';
import { TokenBudgetTracker } from '../../src/ai/TokenBudgetTracker.js';
import type { ModelCatalog, ResolvedModel } from '../../src/ai/ModelCatalog.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';
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

// Mock the AI SDK
vi.mock('ai', () => ({
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
  validationUrl: 'https://validation.example.com',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,

  timeout: 300_000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
};

function makeResolvedModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    providerModelId: 'claude-sonnet-4-5-20250929',
    tier: 'premium',
    capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false },
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
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          inputTokenDetails: {
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

      expect(result.usage.input_tokens).toBe(200);
      expect(result.usage.output_tokens).toBe(100);
      expect(result.usage.cache_read_input_tokens).toBe(50);
      expect(result.usage.cache_creation_input_tokens).toBe(25);
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

      const error = new Error('Rate limited');
      Object.assign(error, { statusCode: 429 });
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

      const error = new Error('Invalid API key');
      Object.assign(error, { statusCode: 401 });
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(UnauthorizedError);
    });

    it('maps 403 to ForbiddenError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = new Error('Forbidden');
      Object.assign(error, { statusCode: 403 });
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

      const error = new Error('Internal server error');
      Object.assign(error, { statusCode: 500 });
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig, mockCatalog(), noopLogger);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow(ServiceUnavailableError);
    });

    it('maps AbortError to TimeoutError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = new Error('Aborted');
      error.name = 'AbortError';
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

      const error = new Error('Retries exhausted');
      error.name = 'RetryError';
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
