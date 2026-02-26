/**
 * Token usage metrics (used across providers)
 */
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** OpenAI reasoning model internal reasoning tokens (o1, o3, o4-mini) */
  reasoning_tokens?: number;
  /** Google Gemini thinking tokens (Gemini 2.5+ with thinkingConfig enabled) */
  thinking_tokens?: number;
}
