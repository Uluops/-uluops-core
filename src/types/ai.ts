/**
 * Token usage metrics (used across providers)
 */
export interface UsageMetrics {
  /**
   * CACHE-EXCLUSIVE input tokens — input the model actually processed fresh,
   * excluding both cache reads and cache writes. `mapUsage` normalizes to this
   * contract for every provider; do NOT subtract a cached figure again downstream.
   *
   * This is NOT the provider's headline input count. AI SDK v6 reports
   * `usage.inputTokens` as `inputTokens.total`, which INCLUDES cache reads and
   * writes for every provider — reading that value as if it were uncached input
   * (the v5 shape) double-counts cache_creation and prices cache_read at the full
   * input rate. Measured live 2026-08-22 on claude-haiku-4-5: a cache-read step of
   * 12 genuine effective tokens was reported as 9,916.
   */
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /**
   * Cached-input tokens: the cheap, cache-served portion of GROSS input that a
   * provider folds into its headline input count.
   *
   * RECORDED COMPONENT ONLY as of the v6 normalization — it no longer participates
   * in total_effective or cost arithmetic, because `input_tokens` is already
   * cache-exclusive. It survives as the fallback source for that normalization when
   * a provider reports no `inputTokenDetails`, and as a reported metric.
   * Historically it was subtracted: (input − cached_input) + output + cache_creation
   * (cross-harness-token-normalization-spec §3.2). AI SDK v6 dissolved the provider
   * shape difference that motivated that disentangle — Anthropic cache reads and
   * OpenAI/Google cached input now both arrive as `inputTokenDetails.cacheReadTokens`.
   */
  cached_input_tokens?: number;
  /** OpenAI reasoning model internal reasoning tokens (o1, o3, o4-mini). Subset of gross output_tokens. */
  reasoning_tokens?: number;
  /** Google Gemini thinking tokens (Gemini 2.5+ with thinkingConfig enabled). Subset of gross output_tokens. */
  thinking_tokens?: number;
}
