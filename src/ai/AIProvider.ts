import { generateText, Output, NoObjectGeneratedError, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { UsageMetrics } from '../types/ai.js';
import { formatErrorMessage } from '../utils/formatError.js';
import type { ResolvedConfig, ResolvedAIConfig } from '../types/config.js';
import type { ModelCatalog, ResolvedModel } from './ModelCatalog.js';
import { TokenBudgetTracker } from './TokenBudgetTracker.js';
import { DEFAULT_MAX_STEPS, ANTHROPIC_BASH_TOOL_VERSION, ANTHROPIC_CONTEXT_MANAGEMENT_TYPE, DEFAULT_DYNAMIC_PROVIDERS } from '../constants.js';
import { executeShellAsString, executeShellAsOpenAIResult } from './ShellExecutor.js';
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

  /** Structured output object, if output schema was provided and model supports it.
   *  When present, this is already validated against the schema — no extraction needed. */
  structuredOutput?: unknown;
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

  /** Token budget for context window management. When set, forces wrap-up at 80% usage. */
  contextBudget?: number;

  /** Optional budget tracker for sharing state with tools (e.g., get_token_budget) */
  budgetTracker?: TokenBudgetTracker;

  /** Structured output schema. When provided and the model supports it,
   *  constrains the final response to match this schema exactly. */
  output?: Parameters<typeof Output.object>[0];
}

/**
 * Multi-provider AI SDK wrapper with registry-backed model resolution.
 *
 * Wraps Vercel AI SDK v6 to provide:
 * - Registry-backed model alias resolution (sonnet → anthropic:claude-sonnet-4-5-20250929)
 * - Multi-provider support (Anthropic + OpenAI + Google bundled, others via dynamic import)
 * - Capability pre-flight checks (tools, vision, streaming, extendedThinking)
 * - Unified generation with automatic tool loops
 * - Automatic prompt caching for Anthropic system messages
 * - Extended thinking auto-enabled for capable Anthropic models
 * - Reasoning effort auto-set for capable OpenAI models
 * - Provider-defined tool support (Anthropic bash, OpenAI shell)
 * - Error mapping to UluOps error types
 * - Usage metrics in UluOps format (including OpenAI reasoning + Google thinking tokens)
 */
export class AIProvider {
  /** Factory name overrides for providers that don't follow the `create<Name>` convention */
  private static readonly FACTORY_NAME_OVERRIDES: Record<string, string> = {
    google: 'createGoogleGenerativeAI',
  };

  /**
   * Allowlist of valid provider names for dynamic import.
   * Prevents path traversal via crafted provider strings (CWE-829).
   * Built from defaults + any additional providers from config.
   */
  private validProviders: Set<string>;

  /** Initialized AI SDK provider factories, keyed by provider name */
  private providers = new Map<string, (modelId: string) => LanguageModel>();

  /** Anthropic provider instance for accessing provider-defined tools */
  private anthropicInstance?: AnthropicProvider;

  /** OpenAI provider instance for accessing provider-defined tools */
  private openaiInstance?: OpenAIProvider;

  constructor(
    private config: ResolvedConfig,
    private catalog: ModelCatalog,
    private logger: Logger,
  ) {
    this.validProviders = new Set([
      ...DEFAULT_DYNAMIC_PROVIDERS,
      ...(config.ai.additionalProviders ?? []),
    ]);
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

    // Determine if structured output should be used
    const useStructuredOutput = !!options.output
      && resolved.capabilities.structuredOutput;

    if (options.output && !resolved.capabilities.structuredOutput) {
      this.logger.info(
        `Model ${resolved.modelId} does not support structured output — falling back to free-form extraction`,
      );
    }

    try {
      let stepCount = 0;
      const budgetTracker = options.budgetTracker;

      // Build prepareStep for budget-based wrap-up
      const prepareStep = options.contextBudget
        ? this.buildBudgetPrepareStep(options.contextBudget)
        : undefined;

      const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

      const result = await generateText({
        model: languageModel,
        system,
        prompt: options.prompt,
        tools: options.tools,
        maxOutputTokens: options.maxTokens ?? 8192,
        // +2 when structured output: +1 for the output generation step, +1 buffer
        stopWhen: stepCountIs(maxSteps + (useStructuredOutput ? 2 : 0)),
        temperature: options.temperature ?? 0,
        abortSignal: options.timeoutMs
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
        ...(providerOptions ? { providerOptions } : {}),
        ...(prepareStep ? { prepareStep } : {}),
        ...(useStructuredOutput ? { output: Output.object(options.output!) } : {}),
        onStepFinish: (step) => {
          stepCount++;
          const toolNames = step.toolCalls?.map(tc => tc.toolName) ?? [];
          const usage = step.usage;
          const textLen = step.text?.length ?? 0;
          this.logger.info(
            `Step ${stepCount}: ${step.finishReason}` +
            (toolNames.length > 0 ? ` | tools: [${toolNames.join(', ')}]` : '') +
            ` | usage: ${usage.inputTokens ?? 0}in/${usage.outputTokens ?? 0}out` +
            (textLen > 0 ? ` | text: ${textLen} chars` : ''),
          );

          // Update budget tracker for get_token_budget tool
          if (budgetTracker) {
            budgetTracker.update(usage.inputTokens ?? 0, usage.outputTokens ?? 0);
          }
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
        (usage.cache_read_input_tokens ? ` / cache_read=${usage.cache_read_input_tokens}` : '') +
        (usage.thinking_tokens ? ` / thinking=${usage.thinking_tokens}` : ''),
      );

      return {
        text: result.text,
        usage,
        toolCallCount,
        model: `${resolved.provider}:${resolved.modelId}`,
        provider: resolved.provider,
        steps: result.steps.length,
        finishReason: result.finishReason,
        structuredOutput: useStructuredOutput ? result.output : undefined,
      };
    } catch (error) {
      // If structured output fails, extract from the error's preserved text
      // instead of re-running the entire generation (which would double cost).
      if (useStructuredOutput && NoObjectGeneratedError.isInstance(error)) {
        this.logger.warn(
          `Structured output generation failed — falling back to text extraction: ${(error as Error).message}`,
        );
        return {
          text: (error as NoObjectGeneratedError).text ?? '',
          structuredOutput: undefined,
          usage: this.mapUsage(
            (error as NoObjectGeneratedError).usage ?? { inputTokens: 0, outputTokens: 0 },
          ),
          toolCallCount: 0,
          model: `${resolved.provider}:${resolved.modelId}`,
          provider: resolved.provider,
          steps: 0,
          finishReason: (error as NoObjectGeneratedError).finishReason ?? 'error',
        };
      }
      throw this.mapError(error, options.timeoutMs);
    }
  }

  /**
   * Resolve model alias and ensure provider is loaded.
   * @internal Used by AgentExecutor for early provider detection.
   */
  async resolveModel(
    input: string,
    opts?: { requiredCapabilities?: Array<keyof ModelCapabilities> },
  ): Promise<ResolvedModel> {
    const resolved = await this.catalog.resolve(input, opts);
    await this.ensureProvider(resolved.provider);
    return resolved;
  }

  /**
   * Create provider-defined shell tool for the resolved model's provider.
   *
   * - Anthropic: bash_20250124 (Claude's built-in bash knowledge) — returns string
   * - OpenAI: openai.tools.shell() with local execution — returns structured output
   *
   * Returns undefined if the model's provider has no shell tool support or
   * the provider instance is not available.
   */
  createProviderShellTool(
    provider: string,
    targetDir: string,
    timeoutMs = 30_000,
  ): ToolSet | undefined {
    if (provider === 'anthropic' && this.anthropicInstance) {
      // Access bash tool by version constant (date-stamped, updated in constants.ts)
      const bashTool = (this.anthropicInstance.tools as Record<string, Function>)[ANTHROPIC_BASH_TOOL_VERSION];
      if (!bashTool) {
        this.logger.warn(`Anthropic bash tool ${ANTHROPIC_BASH_TOOL_VERSION} not found on provider instance`);
        return undefined;
      }
      return {
        bash: bashTool({
          execute: async ({ command }: { command: string }) => executeShellAsString(command, targetDir, timeoutMs),
        }),
      };
    }

    if (provider === 'openai' && this.openaiInstance) {
      // Type assertion needed: OpenAI provider-defined tool uses a specific
      // FlexibleSchema<{action: ...}> that doesn't widen to ToolSet's generic
      // Tool<any, any> due to schema symbol variance. Safe at runtime.
      return {
        shell: this.openaiInstance.tools.shell({
          execute: async ({ action }) => executeShellAsOpenAIResult(action, targetDir, timeoutMs),
        }),
      } as unknown as ToolSet;
    }

    return undefined;
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
   * OpenAI caching is automatic for prompts ≥1024 tokens — no markup needed.
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
   * Dispatches to provider-specific builders.
   */
  /**
   * Provider-specific option builders. New providers add an entry here
   * instead of adding a new if-branch to buildProviderOptions.
   */
  private readonly providerOptionsBuilders: Record<
    string,
    (resolved: ResolvedModel, userOptions?: ProviderOptions) => ProviderOptions | undefined
  > = {
    anthropic: (r, o) => this.buildAnthropicOptions(r, o),
    openai: (r, o) => this.buildOpenAIOptions(r, o),
    google: (r, o) => this.buildGoogleOptions(r, o),
  };

  private buildProviderOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions | undefined {
    const builder = this.providerOptionsBuilders[resolved.provider];
    return builder ? builder(resolved, userOptions) : userOptions;
  }

  /**
   * Anthropic-specific provider options.
   * - Auto-enables extended thinking when model has extendedThinking capability
   * - Auto-injects context management (clear old tool uses at 100K tokens)
   */
  private buildAnthropicOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions {
    const userAnthropicOpts = (userOptions?.anthropic ?? {}) as Record<string, unknown>;
    let anthropicOpts = { ...userAnthropicOpts };

    // Auto-enable extended thinking if model supports it and user hasn't specified
    if (resolved.capabilities.extendedThinking && !('thinking' in anthropicOpts)) {
      const budgetTokens = this.config.defaultThinkingBudget;
      anthropicOpts = {
        ...anthropicOpts,
        thinking: { type: 'enabled' as const, budgetTokens },
      };
    }

    // Auto-inject context management to clear old tool uses when context grows large.
    // Trigger at 50% of the configured context budget to leave room for the final
    // response. Keep the 5 most recent tool uses so the model retains working context.
    if (!('contextManagement' in anthropicOpts)) {
      const contextTrigger = Math.round(this.config.contextBudget * 0.5);
      anthropicOpts = {
        ...anthropicOpts,
        contextManagement: {
          edits: [
            {
              type: ANTHROPIC_CONTEXT_MANAGEMENT_TYPE,
              trigger: { type: 'input_tokens', value: contextTrigger },
              keep: { type: 'tool_uses', value: 5 },
              clearToolInputs: true,
            },
          ],
        },
      };
    }

    return {
      ...(userOptions ?? {}),
      anthropic: anthropicOpts as Record<string, unknown>,
    } as ProviderOptions;
  }

  /**
   * OpenAI-specific provider options.
   * - Auto-sets reasoningEffort for reasoning-capable models (o1, o3, o4-mini)
   * - No context management equivalent — budget wrap-up via prepareStep is the only guard
   * - systemMessageMode auto-handled by @ai-sdk/openai (system → developer for reasoning)
   */
  private buildOpenAIOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions | undefined {
    const userOpenAIOpts = (userOptions?.openai ?? {}) as Record<string, unknown>;
    let openaiOpts = { ...userOpenAIOpts };

    // Auto-set reasoningEffort for reasoning models if user hasn't specified
    if (resolved.capabilities.extendedThinking && !('reasoningEffort' in openaiOpts)) {
      openaiOpts = {
        ...openaiOpts,
        reasoningEffort: 'medium',
      };
    }

    // No options to inject — return user options unchanged
    if (Object.keys(openaiOpts).length === 0) {
      return userOptions;
    }

    return {
      ...(userOptions ?? {}),
      openai: openaiOpts as Record<string, unknown>,
    } as ProviderOptions;
  }

  /**
   * Google-specific provider options.
   * - Auto-enables thinkingConfig with thinkingBudget for thinking-capable models (Gemini 2.5+)
   * - No context management equivalent — budget wrap-up via prepareStep is the only guard
   * - No system message wrapping — Gemini caching is implicit for 2.5+ models
   */
  private buildGoogleOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions | undefined {
    const userGoogleOpts = (userOptions?.google ?? {}) as Record<string, unknown>;
    let googleOpts = { ...userGoogleOpts };

    // Auto-enable thinking for models with extendedThinking capability (Gemini 2.5+)
    if (resolved.capabilities.extendedThinking && !('thinkingConfig' in googleOpts)) {
      googleOpts = {
        ...googleOpts,
        thinkingConfig: { thinkingBudget: this.config.defaultThinkingBudget },
      };
    }

    if (Object.keys(googleOpts).length === 0) {
      return userOptions;
    }

    return {
      ...(userOptions ?? {}),
      google: googleOpts as Record<string, unknown>,
    } as ProviderOptions;
  }

  /**
   * Build a prepareStep callback that forces wrap-up when budget is 80% consumed.
   *
   * Each step's `inputTokens` is the TOTAL input for that API call (the full
   * conversation including cached tokens). The last step's value represents the
   * current context window size. We check that against the budget.
   */
  private buildBudgetPrepareStep(budget: number) {
    let wrapUpInjected = false;
    return ({ steps }: { steps: Array<{ usage: { inputTokens?: number; outputTokens?: number } }> }) => {
      if (wrapUpInjected) {
        // Already forced wrap-up, keep forcing no tools
        return { toolChoice: 'none' as const };
      }

      if (steps.length === 0) return {};

      // Last step's inputTokens = current context window size
      const lastStep = steps[steps.length - 1]!;
      const contextSize = lastStep.usage.inputTokens ?? 0;

      if (contextSize >= budget * 0.80) {
        wrapUpInjected = true;
        this.logger.warn(
          `Context budget 80% used (${contextSize}/${budget}). Forcing output — no more tool calls.`,
        );
        return { toolChoice: 'none' as const };
      }

      return {};
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Shell Command Execution (delegated to ShellExecutor)
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize AI SDK provider factories from config.
   * @ai-sdk/anthropic, @ai-sdk/openai, and @ai-sdk/google are bundled and eagerly initialized.
   */
  private initializeProviders(aiConfig: ResolvedAIConfig): void {
    for (const [providerName, creds] of Object.entries(aiConfig.providers)) {
      if (providerName === 'anthropic') {
        const anthropic = createAnthropic({ apiKey: creds.apiKey });
        this.anthropicInstance = anthropic;
        this.providers.set('anthropic', (modelId) => anthropic(modelId));
      } else if (providerName === 'openai') {
        const openai = createOpenAI({ apiKey: creds.apiKey });
        this.openaiInstance = openai;
        this.providers.set('openai', (modelId) => openai(modelId));
      } else if (providerName === 'google') {
        const google = createGoogleGenerativeAI({ apiKey: creds.apiKey });
        this.providers.set('google', (modelId) => google(modelId));
      }
      // Other providers are loaded lazily in ensureProvider()
    }
  }

  /**
   * Ensure a provider is loaded. Dynamically imports non-bundled providers.
   */
  async ensureProvider(providerName: string): Promise<void> {
    if (this.providers.has(providerName)) return;

    const creds = this.config.ai.providers[providerName];
    if (!creds) {
      throw this.missingProviderError(providerName);
    }

    if (!this.validProviders.has(providerName)) {
      throw new ConfigurationError(
        `Unknown AI provider: "${providerName}". ` +
        `Valid providers: ${[...this.validProviders].join(', ')}`,
      );
    }

    try {
      // Dynamic import of @ai-sdk/<provider>
      const mod = await import(`@ai-sdk/${providerName}`) as Record<string, unknown>;

      // Check override map first, then try standard naming convention (createMistral, createCohere, etc.)
      const factoryName = AIProvider.FACTORY_NAME_OVERRIDES[providerName]
        ?? `create${providerName.charAt(0).toUpperCase() + providerName.slice(1)}`;
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
      throw this.missingProviderError(providerName);
    }
    return factory;
  }

  private missingProviderError(providerName: string): ConfigurationError {
    const envVar = `${providerName.toUpperCase()}_API_KEY`;
    return new ConfigurationError(
      `AI provider "${providerName}" is not configured. ` +
      `Set the ${envVar} environment variable or add it to config.ai.providers: { ${providerName}: { apiKey: '...' } }`,
    );
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

    // 1. AI SDK standard path (works for both providers)
    if (usage.inputTokenDetails) {
      base.cache_read_input_tokens = usage.inputTokenDetails.cacheReadTokens ?? undefined;
      base.cache_creation_input_tokens = usage.inputTokenDetails.cacheWriteTokens ?? undefined;
    }

    // 2-4. Extract provider-specific metadata
    this.extractAnthropicUsage(base, providerMetadata);
    this.extractOpenAIUsage(base, providerMetadata);
    this.extractGoogleUsage(base, providerMetadata);

    // 5. Generic provider metadata scan for non-bundled providers.
    // Best-effort extraction of cache tokens from unknown provider metadata.
    // Uses ??= to never override values set by provider-specific tiers above.
    if (providerMetadata && base.cache_read_input_tokens == null) {
      this.extractGenericUsage(base, providerMetadata);
    }

    return base;
  }

  private extractAnthropicUsage(base: UsageMetrics, providerMetadata?: Record<string, unknown>): void {
    const meta = (providerMetadata as { anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number } } | undefined)?.anthropic;
    if (!meta) return;
    base.cache_creation_input_tokens ??= meta.cacheCreationInputTokens;
    base.cache_read_input_tokens ??= meta.cacheReadInputTokens;
  }

  private extractOpenAIUsage(base: UsageMetrics, providerMetadata?: Record<string, unknown>): void {
    const meta = (providerMetadata as { openai?: { cachedPromptTokens?: number; reasoningTokens?: number } } | undefined)?.openai;
    if (!meta) return;
    base.cache_read_input_tokens ??= meta.cachedPromptTokens;
    if (meta.reasoningTokens) base.reasoning_tokens = meta.reasoningTokens;
  }

  private extractGoogleUsage(base: UsageMetrics, providerMetadata?: Record<string, unknown>): void {
    const gUsage = (providerMetadata as { google?: { usageMetadata?: { cachedContentTokenCount?: number; thoughtsTokenCount?: number } } } | undefined)?.google?.usageMetadata;
    if (!gUsage) return;
    base.cache_read_input_tokens ??= gUsage.cachedContentTokenCount;
    if (gUsage.thoughtsTokenCount) base.thinking_tokens = gUsage.thoughtsTokenCount;
  }

  private extractGenericUsage(base: UsageMetrics, providerMetadata: Record<string, unknown>): void {
    const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'google']);
    for (const [key, value] of Object.entries(providerMetadata)) {
      if (KNOWN_PROVIDERS.has(key) || typeof value !== 'object' || !value) continue;
      const meta = value as Record<string, unknown>;
      const cached = meta['cachedTokens'] ?? meta['cachedContentTokenCount'] ?? meta['cachedPromptTokens'];
      if (typeof cached === 'number' && cached > 0) {
        base.cache_read_input_tokens = cached;
        break;
      }
    }
  }

  /**
   * Map AI SDK errors to sdk-core error types.
   * AI SDK normalizes all provider errors to APICallError with statusCode.
   */
  private mapError(error: unknown, timeoutMs?: number): Error {
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
      return new TimeoutError(timeoutMs ?? this.config.timeout);
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
