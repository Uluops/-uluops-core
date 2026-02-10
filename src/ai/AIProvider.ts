import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { UsageMetrics } from '../types/ai.js';
import { formatErrorMessage } from '../utils/formatError.js';
import type { ResolvedConfig, ResolvedAIConfig } from '../types/config.js';
import type { ModelCatalog, ResolvedModel } from './ModelCatalog.js';
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
import type { Logger } from '@uluops/sdk-core';

const execAsync = promisify(exec);

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

  /** Provider-specific options (thinking, effort, etc.) passed through to generateText */
  providerOptions?: ProviderOptions;
}

/**
 * Multi-provider AI SDK wrapper with registry-backed model resolution.
 *
 * Wraps Vercel AI SDK v6 to provide:
 * - Registry-backed model alias resolution (sonnet → anthropic:claude-sonnet-4-5-20250929)
 * - Multi-provider support (Anthropic bundled, others via peer dependencies)
 * - Capability pre-flight checks (tools, vision, streaming, extendedThinking)
 * - Unified generation with automatic tool loops
 * - Automatic prompt caching for Anthropic system messages
 * - Extended thinking auto-enabled for capable models
 * - Provider-defined tool support (bash)
 * - Error mapping to UluOps error types
 * - Usage metrics in UluOps format
 */
export class AIProvider {
  /** Initialized AI SDK provider factories, keyed by provider name */
  private providers = new Map<string, (modelId: string) => LanguageModel>();

  /** Anthropic provider instance for accessing provider-defined tools */
  private anthropicInstance?: AnthropicProvider;

  constructor(
    private config: ResolvedConfig,
    private catalog: ModelCatalog,
    private logger: Logger,
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
   * 4. Build provider options (cache control, thinking, etc.)
   * 5. Call generateText with maxSteps for automatic tool loop
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

    // Build provider-specific options (thinking, caching, etc.)
    const providerOptions = this.buildProviderOptions(resolved, options.providerOptions);

    // Build system message with cache control for Anthropic
    const system = this.buildSystemMessage(resolved.provider, options.system);

    // Log pre-generation context
    this.logger.info(`Model: ${resolved.provider}:${resolved.modelId} (from "${modelInput}")`);
    this.logger.debug(`System prompt: ${options.system.length} chars`);
    this.logger.debug(`User prompt: ${options.prompt.length} chars`);
    if (options.tools) {
      this.logger.debug(`Tools: ${Object.keys(options.tools).join(', ')}`);
    }
    this.logger.debug(`Config: maxTokens=${options.maxTokens ?? 8192}, maxSteps=${options.maxSteps ?? 50}, temp=${options.temperature ?? 0}`);

    try {
      let stepCount = 0;

      const result = await generateText({
        model: languageModel,
        system,
        prompt: options.prompt,
        tools: options.tools,
        maxOutputTokens: options.maxTokens ?? 8192,
        stopWhen: stepCountIs(options.maxSteps ?? 50),
        temperature: options.temperature ?? 0,
        abortSignal: options.timeoutMs
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
        ...(providerOptions ? { providerOptions } : {}),
        onStepFinish: (step) => {
          stepCount++;
          const toolNames = step.toolCalls?.map(tc => tc.toolName) ?? [];
          const usage = step.usage;
          this.logger.info(
            `Step ${stepCount}: ${step.finishReason}` +
            (toolNames.length > 0 ? ` | tools: [${toolNames.join(', ')}]` : '') +
            ` | usage: ${usage.inputTokens ?? 0}in/${usage.outputTokens ?? 0}out`,
          );
        },
      });

      // Count tool calls across all steps
      const toolCallCount = result.steps.reduce(
        (sum, step) => sum + (step.toolCalls?.length ?? 0),
        0,
      );

      const usage = this.mapUsage(result.usage, result.providerMetadata);

      this.logger.info(
        `Complete: ${result.steps.length} steps, ${toolCallCount} tool calls, finish=${result.finishReason}`,
      );
      this.logger.info(
        `Usage: ${usage.input_tokens}in / ${usage.output_tokens}out` +
        (usage.cache_creation_input_tokens ? ` / cache_write=${usage.cache_creation_input_tokens}` : '') +
        (usage.cache_read_input_tokens ? ` / cache_read=${usage.cache_read_input_tokens}` : ''),
      );

      return {
        text: result.text,
        usage,
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

  /**
   * Create Anthropic bash tool for execution in a target directory.
   *
   * Uses Anthropic's provider-defined bash_20250124 tool, which Claude has
   * built-in knowledge of. Returns undefined if Anthropic provider is not available.
   */
  createBashTool(targetDir: string, timeoutMs = 30_000): ToolSet | undefined {
    if (!this.anthropicInstance) return undefined;

    return {
      bash: this.anthropicInstance.tools.bash_20250124({
        execute: async ({ command }) => {
          try {
            const { stdout, stderr } = await execAsync(command, {
              cwd: targetDir,
              timeout: timeoutMs,
              maxBuffer: 1024 * 1024, // 1MB
            });
            return stdout || stderr || '(no output)';
          } catch (error) {
            const err = error as { killed?: boolean; signal?: string; stderr?: string };
            if (err.killed || err.signal) {
              return `Command timed out after ${timeoutMs}ms`;
            }
            return `Command failed: ${err.stderr || String(error)}`;
          }
        },
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Options
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build system message with provider-specific cache control.
   *
   * For Anthropic: wraps system text in a SystemModelMessage with
   * ephemeral cache control. The API ignores cache hints if the
   * prompt is below the minimum cacheable length (1024 tokens for Sonnet).
   *
   * For other providers: passes through as plain string.
   */
  private buildSystemMessage(
    provider: string,
    systemText: string,
  ): string | { role: 'system'; content: string; providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } {
    if (provider !== 'anthropic') {
      return systemText;
    }

    return {
      role: 'system' as const,
      content: systemText,
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' as const },
        },
      },
    };
  }

  /**
   * Build top-level providerOptions for generateText().
   *
   * For Anthropic:
   * - Auto-enables extended thinking when model has extendedThinking capability
   * - Merges user-supplied provider options
   *
   * For other providers: passes through user options unchanged.
   */
  private buildProviderOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions | undefined {
    if (resolved.provider !== 'anthropic') {
      return userOptions;
    }

    const userAnthropicOpts = (userOptions?.anthropic ?? {}) as Record<string, unknown>;

    // Auto-enable extended thinking if model supports it and user hasn't specified
    if (resolved.capabilities.extendedThinking && !('thinking' in userAnthropicOpts)) {
      const budgetTokens = this.config.defaultThinkingBudget;
      return {
        ...userOptions,
        anthropic: {
          ...userAnthropicOpts,
          thinking: { type: 'enabled' as const, budgetTokens },
        },
      };
    }

    // Return user options if any Anthropic-specific options exist
    if (Object.keys(userAnthropicOpts).length > 0) {
      return userOptions;
    }

    // No special options needed
    return userOptions;
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
        this.anthropicInstance = anthropic;
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
    this.logger.error(`AI SDK error: ${formatErrorMessage(error)}`);

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
      formatErrorMessage(error),
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
