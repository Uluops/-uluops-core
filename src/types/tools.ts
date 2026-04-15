/**
 * Tool use request from LLM
 */
export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result to send back to LLM
 */
export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
