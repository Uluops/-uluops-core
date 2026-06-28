/**
 * Token usage metrics (used across providers)
 */
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /**
   * Cached-input tokens: the cheap, cache-served portion of GROSS input that
   * OpenAI (cachedPromptTokens) and Google (cachedContentTokenCount) report.
   * Disentangled from cache_read_input_tokens (which now holds only genuine
   * Anthropic-style cache reads) so the canonical total_effective can subtract
   * it: (input − cached_input) + output + cache_creation. 0/undefined for
   * Anthropic/OpenCode. See cross-harness-token-normalization-spec §3.2.
   */
  cached_input_tokens?: number;
  /** OpenAI reasoning model internal reasoning tokens (o1, o3, o4-mini). Subset of gross output_tokens. */
  reasoning_tokens?: number;
  /** Google Gemini thinking tokens (Gemini 2.5+ with thinkingConfig enabled). Subset of gross output_tokens. */
  thinking_tokens?: number;
}
