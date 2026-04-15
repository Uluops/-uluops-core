/**
 * Demonstrates structured error handling with the SDK error hierarchy.
 *
 * Prerequisites:
 *   export ULUOPS_API_KEY=ulr_your_key
 *   export ANTHROPIC_API_KEY=your_key
 *
 * Usage:
 *   npx tsx examples/error-handling.ts
 */
import {
  UluOpsClient,
  ConfigurationError,
  ModelNotFoundError,
  ExecutionError,
  WorkflowError,
  ParseError,
  RateLimitError,
  UnauthorizedError,
} from '@uluops/core';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
});

try {
  const result = await client.runAgent('code-validator', './src');
  console.log(`Success: ${result.decision} (${result.score})`);
} catch (error) {
  if (error instanceof ConfigurationError) {
    // Missing API key, invalid provider config, definition not found
    console.error('Configuration error:', error.message);
  } else if (error instanceof ModelNotFoundError) {
    // Model alias not in registry catalog
    console.error('Unknown model:', error.message);
  } else if (error instanceof ExecutionError) {
    // Agent execution failed — may have partial results
    console.error('Execution failed:', error.message);
    if (error.partialResult) {
      console.error('Partial result available:', error.partialResult);
    }
  } else if (error instanceof ParseError) {
    // LLM output couldn't be parsed as structured JSON
    console.error('Parse error:', error.message);
    console.error('Output preview:', error.contentPreview);
  } else if (error instanceof RateLimitError) {
    // 429 from UluOps API — back off and retry
    console.error('Rate limited, retry later');
  } else if (error instanceof UnauthorizedError) {
    // 401 — bad or expired API key
    console.error('Invalid API key');
  } else {
    throw error;
  }
}
