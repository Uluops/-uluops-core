import { describe, it, expect, vi } from 'vitest';
import { AIProvider } from '../../src/ai/AIProvider.js';
import type { ResolvedConfig } from '../../src/types/config.js';

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
  registryUrl: 'https://registry.example.com',
  validationUrl: 'https://validation.example.com',
  defaultModel: 'sonnet',
  maxTokens: 8192,
  timeoutMs: 300_000,
  trackResults: true,
};

describe('AIProvider', () => {
  describe('resolveModel', () => {
    const provider = new AIProvider(mockConfig);

    it('resolves haiku alias', () => {
      expect(provider.resolveModel('haiku')).toBe('claude-haiku-4-5-20251001');
    });

    it('resolves sonnet alias', () => {
      expect(provider.resolveModel('sonnet')).toBe('claude-sonnet-4-5-20250929');
    });

    it('resolves opus alias', () => {
      expect(provider.resolveModel('opus')).toBe('claude-opus-4-6');
    });

    it('passes through full model IDs', () => {
      expect(provider.resolveModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    });

    it('passes through unknown model IDs', () => {
      expect(provider.resolveModel('my-custom-model')).toBe('my-custom-model');
    });
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

      const provider = new AIProvider(mockConfig);
      const result = await provider.generate({
        model: 'sonnet',
        system: 'You are a code reviewer.',
        prompt: 'Review this code.',
      });

      expect(result.text).toBe('Analysis complete');
      expect(result.usage.input_tokens).toBe(100);
      expect(result.usage.output_tokens).toBe(50);
      expect(result.toolCallCount).toBe(2);
      expect(result.model).toBe('claude-sonnet-4-5-20250929');
      expect(result.steps).toBe(2);
      expect(result.finishReason).toBe('stop');
    });

    it('maps usage with cache metrics', async () => {
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

      const provider = new AIProvider(mockConfig);
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

    it('maps API errors to sdk-core error types', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = new Error('Rate limited');
      Object.assign(error, { statusCode: 429 });
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig);
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

      const provider = new AIProvider(mockConfig);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow('Authentication failed');
    });

    it('maps timeout to TimeoutError', async () => {
      const { generateText } = await import('ai');
      const mockGenerateText = vi.mocked(generateText);

      const error = new Error('Aborted');
      error.name = 'AbortError';
      mockGenerateText.mockRejectedValueOnce(error);

      const provider = new AIProvider(mockConfig);
      await expect(provider.generate({
        model: 'sonnet',
        system: 'test',
        prompt: 'test',
      })).rejects.toThrow('timed out');
    });
  });
});
