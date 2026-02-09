import { generateText, stepCountIs, type ToolSet } from 'ai';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import type { UsageMetrics, ModelAlias } from '../types/ai.js';
import type { ResolvedConfig } from '../types/config.js';
import {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  TimeoutError,
} from '@uluops/sdk-core/errors';

/**
 * Result from AI provider generation
 */
export interface AIGenerateResult {
  /** Final text content after tool loop completion */
  text: string;

  /** Total usage across all steps */
  usage: UsageMetrics;

  /** Number of tool calls made */
  toolCallCount: number;

  /** Resolved model ID that was used */
  model: string;

  /** Number of steps (LLM calls) in the tool loop */
  steps: number;

  /** Finish reason */
  finishReason: string;
}

/**
 * Options for generation
 */
export interface AIGenerateOptions {
  /** Model alias or full model ID */
  model: ModelAlias | string;

  /** System prompt */
  system: string;

  /** Initial user message */
  prompt: string;

  /** Available tools (AI SDK ToolSet format) */
  tools?: ToolSet;

  /** Maximum response tokens per step */
  maxTokens?: number;

  /** Maximum tool loop iterations */
  maxSteps?: number;

  /** Timeout in milliseconds */
  timeoutMs?: number;

  /** Temperature (0-1) */
  temperature?: number;
}

/**
 * AI SDK-based provider for LLM interactions.
 *
 * Wraps Vercel AI SDK v6 to provide:
 * - Model alias resolution (sonnet -> claude-sonnet-4-5-20250929)
 * - Unified generation with automatic tool loops
 * - Error mapping to UluOps error types
 * - Usage metrics in UluOps format
 */
export class AIProvider {
  private static readonly MODEL_MAP: Record<ModelAlias, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-5-20250929',
    opus: 'claude-opus-4-6',
  };

  private provider: AnthropicProvider;

  constructor(private config: ResolvedConfig) {
    this.provider = createAnthropic({
      apiKey: this.config.apiKey,
    });
  }

  /**
   * Generate text with automatic tool loop handling.
   * Uses AI SDK's `generateText` with `maxSteps`.
   */
  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const resolvedModel = this.resolveModel(options.model);

    try {
      const result = await generateText({
        model: this.provider(resolvedModel),
        system: options.system,
        prompt: options.prompt,
        tools: options.tools,
        maxOutputTokens: options.maxTokens ?? 8192,
        stopWhen: stepCountIs(options.maxSteps ?? 50),
        temperature: options.temperature ?? 0,
        abortSignal: options.timeoutMs
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
      });

      // Count tool calls across all steps
      const toolCallCount = result.steps.reduce(
        (sum, step) => sum + (step.toolCalls?.length ?? 0),
        0,
      );

      return {
        text: result.text,
        usage: this.mapUsage(result.usage, result.providerMetadata),
        toolCallCount,
        model: resolvedModel,
        steps: result.steps.length,
        finishReason: result.finishReason,
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * Resolve model alias to full model ID
   */
  resolveModel(alias: ModelAlias | string): string {
    return AIProvider.MODEL_MAP[alias as ModelAlias] ?? alias;
  }

  /**
   * Convert AI SDK usage to UluOps format
   */
  private mapUsage(
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      inputTokenDetails?: {
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      };
    },
    providerMetadata?: Record<string, unknown>,
  ): UsageMetrics {
    const base: UsageMetrics = {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
    };

    // Extract cache metrics from inputTokenDetails (AI SDK v6 format)
    if (usage.inputTokenDetails) {
      base.cache_read_input_tokens = usage.inputTokenDetails.cacheReadTokens ?? undefined;
      base.cache_creation_input_tokens = usage.inputTokenDetails.cacheWriteTokens ?? undefined;
    }

    // Fallback: Extract from Anthropic provider metadata
    const meta = providerMetadata as {
      anthropic?: {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    } | undefined;

    if (meta?.anthropic) {
      base.cache_creation_input_tokens ??= meta.anthropic.cacheCreationInputTokens;
      base.cache_read_input_tokens ??= meta.anthropic.cacheReadInputTokens;
    }

    return base;
  }

  /**
   * Map AI SDK errors to sdk-core error types
   */
  private mapError(error: unknown): Error {
    if (isAPICallError(error)) {
      const status = error.statusCode ?? 0;

      if (status === 429) {
        return new RateLimitError(`Rate limit exceeded: ${error.message}`);
      }
      if (status === 401) {
        return new UnauthorizedError(`Authentication failed: ${error.message}`);
      }
      if (status === 403) {
        return new ForbiddenError(`Forbidden: ${error.message}`);
      }
      if (status >= 500) {
        return new ServiceUnavailableError(`Server error: ${error.message}`);
      }
      return new SdkApiError(status, error.message);
    }

    if (isRetryError(error)) {
      return new SdkApiError(0, `Retries exhausted: ${error.message}`);
    }

    // Timeout (AbortError)
    if (error instanceof Error && error.name === 'AbortError') {
      return new TimeoutError(0);
    }

    return new SdkApiError(
      0,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Type guard for AI SDK's APICallError
 */
function isAPICallError(error: unknown): error is Error & { statusCode?: number } {
  return error instanceof Error && 'statusCode' in error;
}

/**
 * Type guard for AI SDK's RetryError
 */
function isRetryError(error: unknown): error is Error & { lastError?: Error } {
  return error instanceof Error && error.name === 'RetryError';
}
