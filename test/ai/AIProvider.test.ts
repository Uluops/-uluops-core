import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIProvider } from '../../src/ai/AIProvider.js';
import type { ModelCatalog, ResolvedModel } from '../../src/ai/ModelCatalog.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
  tool: vi.fn((t: unknown) => t),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-model' }));
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
  hashVerificationEnabled: true,
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

    it('maps API errors to sdk-core error types', async () => {
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
      })).rejects.toThrow('Rate limit exceeded');
    });

    it('maps auth errors to UnauthorizedError', async () => {
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
      })).rejects.toThrow('Authentication failed');
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
      })).rejects.toThrow('Forbidden');
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
      })).rejects.toThrow('Server error');
    });

    it('maps timeout to TimeoutError', async () => {
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
      })).rejects.toThrow('timed out');
    });

    it('maps RetryError', async () => {
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
      })).rejects.toThrow('Retries exhausted');
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
      await expect(provider.ensureProvider('openai')).rejects.toThrow(
        'AI provider "openai" is not configured',
      );
    });
  });
});
