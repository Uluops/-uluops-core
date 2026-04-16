import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolHandler } from '../executor/ToolHandler.js';
import type { TokenBudgetTracker } from './TokenBudgetTracker.js';
import { ExecutionError } from '../errors/index.js';

/**
 * Converts UluOps ToolHandler to AI SDK v6 tool format.
 *
 * AI SDK v6 uses Zod schemas via `inputSchema` for input validation.
 * This adapter bridges ToolHandler's JSON Schema tools to AI SDK's Zod-based tool definitions.
 */
export class ToolAdapter {
  constructor(
    private toolHandler: ToolHandler,
    private additionalTools?: ToolSet,
    private budgetTracker?: TokenBudgetTracker,
  ) {}

  /**
   * Execute a tool call via ToolHandler and return content or throw on error.
   */
  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const result = await this.toolHandler.fulfill({
      id: crypto.randomUUID(),
      name,
      input,
    });
    if (result.is_error) throw new ExecutionError(`Tool "${name}" failed: ${result.content}`);
    return result.content;
  }

  /**
   * Get AI SDK v6 compatible tools from ToolHandler.
   * Converts JSON Schema tool definitions to Zod-based AI SDK tools.
   */
  getTools(): ToolSet {
    const tools: ToolSet = {
      ...this.additionalTools,

      read_file: tool({
        description:
          'Read the contents of a file. Use start_line/end_line for large files to avoid reading the entire file.',
        inputSchema: z.object({
          path: z.string().describe('File path relative to target directory'),
          start_line: z.number().int().optional().describe('First line to read (1-based). Default: 1'),
          end_line: z.number().int().optional().describe('Last line to read (1-based). Default: end of file'),
        }),
        execute: async ({ path, start_line, end_line }) =>
          this.executeTool('read_file', {
            path,
            ...(start_line !== undefined ? { start_line } : {}),
            ...(end_line !== undefined ? { end_line } : {}),
          }),
      }),

      list_files: tool({
        description:
          'List files in a directory with size/line metadata. Supports glob patterns. Results are capped at max_results.',
        inputSchema: z.object({
          path: z.string().describe('Directory path relative to target'),
          pattern: z.string().optional().describe('Glob pattern (e.g., "**/*.ts")'),
          max_results: z.number().int().optional().describe('Maximum files to return. Default: 200'),
        }),
        execute: async ({ path, pattern, max_results }) =>
          this.executeTool('list_files', {
            path,
            ...(pattern !== undefined ? { pattern } : {}),
            ...(max_results !== undefined ? { max_results } : {}),
          }),
      }),

      search_content: tool({
        description:
          'Search for a pattern across files. Supports regex. Use mode to control output verbosity.',
        inputSchema: z.object({
          pattern: z.string().describe('Search pattern (supports regex)'),
          file_pattern: z.string().optional().describe('Glob pattern for files'),
          max_results: z.number().optional().describe('Max matches (default: 50)'),
          mode: z
            .enum(['matches', 'files', 'count'])
            .optional()
            .describe('"matches" (default), "files" (paths only), "count" (per-file counts)'),
          context_lines: z
            .number()
            .int()
            .optional()
            .describe('Lines of context before/after each match (0-5). Default: 0'),
        }),
        execute: async ({ pattern, file_pattern, max_results, mode, context_lines }) =>
          this.executeTool('search_content', {
            pattern,
            ...(file_pattern !== undefined ? { file_pattern } : {}),
            ...(max_results !== undefined ? { max_results } : {}),
            ...(mode !== undefined ? { mode } : {}),
            ...(context_lines !== undefined ? { context_lines } : {}),
          }),
      }),

      get_file_info: tool({
        description:
          'Get file metadata (size, line count, language) without reading content. Use before read_file to decide what to read.',
        inputSchema: z.object({
          path: z.string().describe('File path relative to target directory'),
        }),
        execute: async ({ path }) => this.executeTool('get_file_info', { path }),
      }),

      get_directory_tree: tool({
        description:
          'Get a hierarchical view of a directory with file counts and sizes. More structured than list_files.',
        inputSchema: z.object({
          path: z.string().describe('Directory path relative to target'),
          max_depth: z.number().int().optional().describe('Maximum depth to traverse. Default: 3'),
          include_sizes: z.boolean().optional().describe('Include file sizes. Default: true'),
        }),
        execute: async ({ path, max_depth, include_sizes }) =>
          this.executeTool('get_directory_tree', {
            path,
            ...(max_depth !== undefined ? { max_depth } : {}),
            ...(include_sizes !== undefined ? { include_sizes } : {}),
          }),
      }),

      get_symbols: tool({
        description:
          'Extract exported symbols (functions, classes, interfaces, types, constants) from a source file with line numbers.',
        inputSchema: z.object({
          path: z.string().describe('File path relative to target directory'),
          include_private: z.boolean().optional().describe('Include non-exported symbols. Default: false'),
        }),
        execute: async ({ path, include_private }) =>
          this.executeTool('get_symbols', {
            path,
            ...(include_private !== undefined ? { include_private } : {}),
          }),
      }),
    };

    // Synthetic tool: get_token_budget (needs runtime state, not ToolHandler)
    if (this.budgetTracker) {
      const tracker = this.budgetTracker;
      tools['get_token_budget'] = tool({
        description:
          'Get current token budget status showing how much context window has been used. Use to decide whether to read more files or wrap up.',
        inputSchema: z.object({}),
        execute: async () => {
          const status = tracker.getStatus();
          return JSON.stringify(status, null, 2);
        },
      });
    }

    return tools;
  }
}
