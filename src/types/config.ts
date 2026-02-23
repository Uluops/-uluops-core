/**
 * AI provider credentials
 */
export interface AIProviderCredentials {
  /** Provider API key. Falls back to standard env var (e.g., ANTHROPIC_API_KEY) */
  apiKey?: string;
}

/**
 * AI configuration — provider credentials and model resolution.
 *
 * Provider names match models.dev / AI SDK conventions
 * (e.g., 'anthropic', 'openai', 'google').
 */
export interface AIConfig {
  /**
   * Provider credentials keyed by provider name.
   * Only configured providers can be used for execution.
   * `@ai-sdk/anthropic` is bundled; other providers are peer dependencies.
   *
   * @example
   * ```typescript
   * providers: {
   *   anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
   *   openai: { apiKey: process.env.OPENAI_API_KEY },
   * }
   * ```
   */
  providers: Record<string, AIProviderCredentials>;

  /**
   * Default provider when model alias doesn't include a provider prefix.
   * @default 'anthropic'
   */
  defaultProvider?: string;

  /**
   * Model override for all executions (alias, tier, or provider:modelId).
   * When set, overrides model selection from definition files.
   */
  modelOverride?: string;
}

/**
 * Resolved AI configuration with defaults applied
 */
export interface ResolvedAIConfig {
  providers: Record<string, { apiKey: string }>;
  defaultProvider: string;
  modelOverride?: string;
}

/**
 * SDK Configuration
 */
export interface UluOpsConfig {
  /**
   * UluOps platform API key for registry and validation services.
   * Falls back to ULUOPS_API_KEY or ULU_API_KEY env var.
   * This key authenticates against UluOps services only, NOT AI providers.
   */
  apiKey?: string;

  /**
   * AI provider configuration.
   * Separates AI provider credentials from UluOps platform auth.
   *
   * If omitted, defaults to Anthropic with ANTHROPIC_API_KEY env var.
   */
  ai?: AIConfig;

  /**
   * Base URL for uluops-registry-api
   * @default "https://api.uluops.ai/api/v1/registry"
   */
  registryUrl?: string;

  /**
   * Base URL for uluops-validation-api
   * @default "https://api.uluops.ai/api/v1/ops"
   */
  validationUrl?: string;

  /**
   * Base URL for dashboard links
   * @default "https://app.uluops.ai"
   */
  dashboardUrl?: string;

  /**
   * Local definitions directory for development
   * When set, SDK looks here first before remote registry
   * Supports: *.agent.yaml, *.command.yaml, *.workflow.yaml, *.pipeline.yaml
   */
  localDefinitions?: string;

  /**
   * Enable result submission to validation service
   * @default true
   */
  trackingEnabled?: boolean;

  /**
   * Enable hash verification for definitions
   * @default true
   */
  hashVerificationEnabled?: boolean;

  /** Request timeout in ms (default: 300000) */
  timeout?: number;

  /** Default project name for validation service */
  defaultProject?: string;

  /**
   * Default extended thinking budget in tokens.
   * Used when a model supports extendedThinking and no per-call budget is specified.
   * @default 10000
   */
  defaultThinkingBudget?: number;

  /**
   * Enable detailed execution logging (model resolution, prompt sizes,
   * per-step tool calls, usage). Falls back to ULUOPS_DEBUG env var.
   * @default false
   */
  debug?: boolean;

  /**
   * Context window budget in tokens for agent execution.
   * When usage exceeds 80%, the agent is forced to produce output instead of calling more tools.
   * Also enables Anthropic context management (auto-clearing old tool uses at 50%).
   * @default 200000
   */
  contextBudget?: number;
}

/**
 * Validated configuration with defaults applied
 */
export interface ResolvedConfig {
  apiKey: string;
  ai: ResolvedAIConfig;
  registryUrl: string;
  validationUrl: string;
  dashboardUrl: string;
  localDefinitions?: string;
  trackingEnabled: boolean;
  hashVerificationEnabled: boolean;
  timeout: number;
  defaultProject?: string;
  defaultThinkingBudget: number;
  debug: boolean;
  contextBudget: number;
}
