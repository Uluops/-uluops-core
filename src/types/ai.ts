/**
 * Token usage metrics (used across providers)
 */
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Model alias used throughout the SDK
 */
export type ModelAlias = 'haiku' | 'sonnet' | 'opus';

/**
 * Options passed to AIProvider.generate()
 */
export interface GenerateOptions {
  /** Model alias to use */
  model: ModelAlias;

  /** System prompt */
  system: string;

  /** User message */
  prompt: string;

  /** Maximum steps for tool loop */
  maxSteps?: number;

  /** Maximum tokens per response */
  maxTokens?: number;

  /** Abort signal for timeout */
  abortSignal?: AbortSignal;
}

/**
 * Result from AIProvider.generate()
 */
export interface GenerateResult {
  /** Final text response */
  text: string;

  /** Token usage metrics */
  usage: UsageMetrics;

  /** Number of steps (tool loop iterations) */
  steps: number;

  /** Finish reason */
  finishReason: string;
}
