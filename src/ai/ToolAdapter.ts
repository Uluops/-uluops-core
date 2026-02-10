import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolHandler } from '../executor/ToolHandler.js';

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
  ) {}

  /**
   * Get AI SDK v6 compatible tools from ToolHandler.
   * Converts JSON Schema tool definitions to Zod-based AI SDK tools.
   *
   * @returns ToolSet with read_file, list_files, search_content + any additional provider tools
   */
  getTools(): ToolSet {
    return {
      ...this.additionalTools,
      read_file: tool({
        description: 'Read the contents of a file. Returns the full file content.',
        inputSchema: z.object({
          path: z.string().describe('File path relative to target directory'),
        }),
        execute: async ({ path }: { path: string }) => {
          const result = await this.toolHandler.fulfill({
            id: crypto.randomUUID(),
            name: 'read_file',
            input: { path },
          });
          if (result.is_error) {
            throw new Error(result.content);
          }
          return result.content;
        },
      }),

      list_files: tool({
        description: 'List files in a directory. Supports glob patterns.',
        inputSchema: z.object({
          path: z.string().describe('Directory path relative to target'),
          pattern: z.string().optional().describe('Glob pattern (e.g., "**/*.ts")'),
        }),
        execute: async ({ path, pattern }: { path: string; pattern?: string }) => {
          const result = await this.toolHandler.fulfill({
            id: crypto.randomUUID(),
            name: 'list_files',
            input: { path, ...(pattern !== undefined ? { pattern } : {}) },
          });
          if (result.is_error) {
            throw new Error(result.content);
          }
          return result.content;
        },
      }),

      search_content: tool({
        description: 'Search for a pattern across files. Returns matching lines.',
        inputSchema: z.object({
          pattern: z.string().describe('Search pattern (supports regex)'),
          file_pattern: z.string().optional().describe('Glob pattern for files'),
          max_results: z.number().optional().describe('Max matches (default: 50)'),
        }),
        execute: async ({ pattern, file_pattern, max_results }: { pattern: string; file_pattern?: string; max_results?: number }) => {
          const result = await this.toolHandler.fulfill({
            id: crypto.randomUUID(),
            name: 'search_content',
            input: {
              pattern,
              ...(file_pattern !== undefined ? { file_pattern } : {}),
              ...(max_results !== undefined ? { max_results } : {}),
            },
          });
          if (result.is_error) {
            throw new Error(result.content);
          }
          return result.content;
        },
      }),
    };
  }
}
