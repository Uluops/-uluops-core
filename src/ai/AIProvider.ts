import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { UsageMetrics } from '../types/ai.js';
import type { ResolvedConfig, ResolvedAIConfig } from '../types/config.js';
import type { ModelCatalog } from './ModelCatalog.js';
import {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  TimeoutError,
  ConfigurationError,
} from '../errors/index.js';
import type { ModelCapabilities } from '@uluops/registry-sdk';

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

  /** Resolved provider:modelId that was used */
  model: string;

  /** Provider name (e.g., 'anthropic', 'openai') */
  provider: string;

  /** Number of steps (LLM calls) in the tool loop */
  steps: number;

  /** Finish reason */
  finishReason: string;
}

/**
 * Options for generation
 */
export interface AIGenerateOptions {
  /** Model alias (e.g., 'sonnet'), tier (e.g., 'premium'), or full provider:modelId */
  model: string;

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

  /** Required capabilities (validated before execution) */
  requiredCapabilities?: Array<keyof ModelCapabilities>;
}

/**
 * Multi-provider AI SDK wrapper with registry-backed model resolution.
 *
 * Wraps Vercel AI SDK v6 to provide:
 * - Registry-backed model alias resolution (sonnet → anthropic:claude-sonnet-4-5-20250929)
 * - Multi-provider support (Anthropic bundled, others via peer dependencies)
 * - Capability pre-flight checks (tools, vision, streaming, extendedThinking)
 * - Unified generation with automatic tool loops
 * - Error mapping to UluOps error types
 * - Usage metrics in UluOps format
 */
export class AIProvider {
  /** Initialized AI SDK provider factories, keyed by provider name */
  private providers = new Map<string, (modelId: string) => LanguageModel>();

  constructor(
    private config: ResolvedConfig,
    private catalog: ModelCatalog,
  ) {
    this.initializeProviders(config.ai);
  }

  /**
   * Generate text with automatic tool loop handling.
   *
   * Resolution flow:
   * 1. Resolve model alias → provider:modelId via ModelCatalog
   * 2. Validate required capabilities (if specified)
   * 3. Get AI SDK LanguageModel from provider factory
   * 4. Call generateText with maxSteps for automatic tool loop
   */
  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    // Apply model override if configured
    const modelInput = this.config.ai.modelOverride ?? options.model;

    // Resolve alias → provider:modelId with capability check
    const resolved = await this.catalog.resolve(modelInput, {
      requiredCapabilities: options.requiredCapabilities,
    });

    // Ensure provider is loaded (for dynamic providers)
    await this.ensureProvider(resolved.provider);

    // Get provider factory
    const factory = this.getProviderFactory(resolved.provider);
    const languageModel = factory(resolved.providerModelId);

    try {
      const result = await generateText({
        model: languageModel,
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
        model: `${resolved.provider}:${resolved.modelId}`,
        provider: resolved.provider,
        steps: result.steps.length,
        finishReason: result.finishReason,
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize AI SDK provider factories from config.
   * @ai-sdk/anthropic is bundled and always available.
   */
  private initializeProviders(aiConfig: ResolvedAIConfig): void {
    for (const [providerName, creds] of Object.entries(aiConfig.providers)) {
      if (providerName === 'anthropic') {
        const anthropic = createAnthropic({ apiKey: creds.apiKey });
        this.providers.set('anthropic', (modelId) => anthropic(modelId));
      }
      // Non-anthropic providers are loaded lazily in ensureProvider()
    }
  }

  /**
   * Ensure a provider is loaded. Dynamically imports non-bundled providers.
   */
  async ensureProvider(providerName: string): Promise<void> {
    if (this.providers.has(providerName)) return;

    const creds = this.config.ai.providers[providerName];
    if (!creds) {
      throw new ConfigurationError(
        `AI provider "${providerName}" is not configured. ` +
        `Add it to config.ai.providers: { ${providerName}: { apiKey: '...' } }`,
      );
    }

    try {
      // Dynamic import of @ai-sdk/<provider>
      const mod = await import(`@ai-sdk/${providerName}`) as Record<string, unknown>;

      // Try standard naming: createOpenAI, createGoogle, etc.
      const factoryName = `create${providerName.charAt(0).toUpperCase() + providerName.slice(1)}`;
      const createProvider = (mod[factoryName] ?? mod['default']) as
        ((opts: { apiKey: string }) => (modelId: string) => LanguageModel) | undefined;

      if (!createProvider || typeof createProvider !== 'function') {
        throw new ConfigurationError(
          `@ai-sdk/${providerName} does not export ${factoryName} or default. ` +
          `Check the package documentation.`,
        );
      }

      const provider = createProvider({ apiKey: creds.apiKey });
      this.providers.set(providerName, (modelId) => provider(modelId));
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;

      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === 'ERR_MODULE_NOT_FOUND' || errCode === 'MODULE_NOT_FOUND') {
        throw new ConfigurationError(
          `Provider "${providerName}" requires @ai-sdk/${providerName}. ` +
          `Install: npm install @ai-sdk/${providerName}`,
        );
      }
      throw error;
    }
  }

  /**
   * Get provider factory, throwing if not configured.
   */
  private getProviderFactory(providerName: string): (modelId: string) => LanguageModel {
    const factory = this.providers.get(providerName);
    if (!factory) {
      throw new ConfigurationError(
        `AI provider "${providerName}" is not configured. ` +
        `Add it to config.ai.providers: { ${providerName}: { apiKey: '...' } }`,
      );
    }
    return factory;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Usage + Error Mapping
  // ─────────────────────────────────────────────────────────────────────────

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
