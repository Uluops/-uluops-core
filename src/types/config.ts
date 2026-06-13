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
   * `@ai-sdk/anthropic`, `@ai-sdk/openai`, and `@ai-sdk/google` are bundled.
   * Other providers require installing `@ai-sdk/<provider>` as a peer dependency.
   *
   * @example
   * ```typescript
   * providers: {
   *   anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
   *   openai: { apiKey: process.env.OPENAI_API_KEY },
   *   google: { apiKey: process.env.GOOGLE_API_KEY },
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

  /**
   * Additional provider names to allow for dynamic import beyond the built-in set
   * (anthropic, openai, google, mistral, cohere, groq, xai, deepseek).
   * Each name must have a corresponding `@ai-sdk/<name>` package installed.
   */
  additionalProviders?: string[];
}

/**
 * Resolved AI configuration with defaults applied
 */
export interface ResolvedAIConfig {
  providers: Record<string, { apiKey: string }>;
  defaultProvider: string;
  modelOverride?: string;
  additionalProviders?: string[];
}

/**
 * SDK Configuration
 */
export interface UluOpsConfig {
  /**
   * UluOps platform API key for registry and submission services.
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
   * Base URL for uluops submission API
   * @default "https://api.uluops.ai/api/v1"
   */
  submissionUrl?: string;

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
   * Enable result submission to tracking service
   * @default true
   */
  trackingEnabled?: boolean;

  /** Request timeout in ms (default: 300000) */
  timeout?: number;

  /** Default project name for submission service */
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
   *
   * ASSUMPTION (2026-04-16): 200k tokens is sufficient for typical project scans.
   * Large repositories or verbose tool traces may force early wrap-up or partial
   * context retention, degrading analysis quality without hard failure. Context
   * management emits warnings when clearing old tool uses — monitor these to
   * detect when the budget is routinely exhausted.
   *
   * @default 200000
   */
  contextBudget?: number;

  /**
   * Maximum retries for transient LLM errors (429, 5xx). Passed to AI SDK's generateText().
   * The AI SDK retries with exponential backoff and respects Retry-After headers.
   * @default 2 (3 total attempts)
   */
  maxRetries?: number;

  /**
   * Operator-controlled tool allowlist. Definitions can request tools (e.g., `tools: ['bash']`
   * in agent YAML), but the tool is only granted if it also appears in this allowlist.
   *
   * This separates the trust boundary: definition authors declare what they need,
   * operators decide what they permit. Without this, the definition author
   * controls both the request and the gate.
   *
   * SECURITY BOUNDARY (2026-04-16): this is the real trust boundary for tool access.
   * Definition tool requests are advisory — they express what the agent needs, not
   * what it's allowed. Operators who assume requested tools are automatically safe
   * may inadvertently grant shell access. The safe default (bash blocked) exists
   * precisely because this assumption is easy to make.
   *
   * When undefined, all tools EXCEPT 'bash' are allowed (safe default).
   * Set explicitly to `['bash']` or `['bash', ...]` to permit shell access.
   *
   * @default undefined (bash blocked, all other tools allowed)
   */
  allowedTools?: string[];
}

/**
 * Validated configuration with defaults applied
 */
export interface ResolvedConfig {
  /** UluOps API key. Optional when using localDefinitions with trackingEnabled: false. */
  apiKey?: string;
  ai: ResolvedAIConfig;
  registryUrl: string;
  submissionUrl: string;
  dashboardUrl: string;
  localDefinitions?: string;
  trackingEnabled: boolean;
  timeout: number;
  defaultProject?: string;
  defaultThinkingBudget: number;
  debug: boolean;
  /**
   * Operator-configured context budget in tokens. Undefined means the operator
   * did not set one — in that case the engine uses the resolved model's real
   * context window (registry `limits.context`), falling back to
   * DEFAULT_CONTEXT_BUDGET only when the window is unknown. See
   * deriveContextBudget() in ai/contextBudget.ts.
   */
  contextBudget?: number;
  maxRetries?: number;
  allowedTools?: string[];
}
