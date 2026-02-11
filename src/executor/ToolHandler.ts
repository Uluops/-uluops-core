import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import type { Tool, ToolUseBlock, ToolResult } from '../types/index.js';
import type { Logger } from '@uluops/sdk-core';
import { formatErrorMessage } from '../utils/formatError.js';

/**
 * Handles filesystem tool calls, fulfilling them against the local target directory.
 * All paths are sandboxed to the base path to prevent directory traversal.
 */
/** No-op logger for when none is provided */
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Max file size to read (1 MB). Files larger than this are truncated. */
const MAX_FILE_SIZE = 1_048_576;

export class ToolHandler {
  private basePath: string;
  private logger: Logger;

  constructor(basePath: string, logger?: Logger) {
    this.basePath = path.resolve(basePath);
    this.logger = logger ?? noopLogger;
  }

  /**
   * Get tool definitions for LLM API.
   * Returns read_file, list_files, and search_content tools.
   */
  getTools(): Tool[] {
    return [
      {
        name: 'read_file',
        description: 'Read the contents of a file. Returns the full file content.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to target directory',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_files',
        description: 'List files in a directory. Supports glob patterns.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to target',
            },
            pattern: {
              type: 'string',
              description: 'Glob pattern (e.g., "**/*.ts"). Defaults to "*"',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_content',
        description: 'Search for a pattern across files. Returns matching lines with context.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Search pattern (supports regex)',
            },
            file_pattern: {
              type: 'string',
              description: 'Glob pattern for files to search (e.g., "**/*.ts")',
            },
            max_results: {
              type: 'integer',
              description: 'Maximum matches to return. Default: 50',
            },
          },
          required: ['pattern'],
        },
      },
    ];
  }

  /**
   * Fulfill a tool call from the LLM.
   * Dispatches to read_file, list_files, or search_content handlers.
   * All paths are sandboxed to the base path.
   *
   * @param toolUse - Tool use block from the LLM response
   * @returns Tool result with content or error
   */
  async fulfill(toolUse: ToolUseBlock): Promise<ToolResult> {
    this.logger.debug(`Tool: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 200)})`);

    try {
      const relativePath = String(toolUse.input['path'] || '.');
      const fullPath = path.resolve(this.basePath, relativePath);

      if (!(await this.isPathSafe(fullPath))) {
        return {
          tool_use_id: toolUse.id,
          content: `Error: Path "${relativePath}" is outside the target directory`,
          is_error: true,
        };
      }

      switch (toolUse.name) {
        case 'read_file':
          return await this.readFile(toolUse.id, fullPath);

        case 'list_files':
          return await this.listFiles(toolUse.id, fullPath, toolUse.input['pattern'] as string | undefined);

        case 'search_content':
          return await this.searchContent(toolUse.id, {
            pattern: toolUse.input['pattern'] as string,
            filePattern: toolUse.input['file_pattern'] as string | undefined,
            maxResults: (toolUse.input['max_results'] as number | undefined) ?? 50,
          });

        default:
          return {
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true,
          };
      }
    } catch (error) {
      return {
        tool_use_id: toolUse.id,
        content: `Error: ${formatErrorMessage(error)}`,
        is_error: true,
      };
    }
  }

  /**
   * Check if resolved path is within base path (security).
   * Uses fs.realpath() to follow symlinks and detect escape attempts.
   */
  private async isPathSafe(fullPath: string): Promise<boolean> {
    // First check: logical path must be within base (catches ../.. traversal)
    const logicalPath = path.resolve(fullPath);
    if (!logicalPath.startsWith(this.basePath)) return false;

    // Second check: resolve symlinks to detect escape via symlink
    try {
      const realPath = await fs.realpath(fullPath);
      return realPath.startsWith(this.basePath);
    } catch {
      // Path doesn't exist — logical check above is sufficient
      return true;
    }
  }

  private async readFile(id: string, filePath: string): Promise<ToolResult> {
    const stat = await fs.stat(filePath);
    const truncated = stat.size > MAX_FILE_SIZE;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_SIZE));
    const fh = await fs.open(filePath, 'r');
    try {
      await fh.read(buffer, 0, buffer.length, 0);
    } finally {
      await fh.close();
    }
    let content = buffer.toString('utf-8');
    if (truncated) {
      content += `\n\n[Truncated: file is ${stat.size} bytes, showing first ${MAX_FILE_SIZE} bytes]`;
    }
    this.logger.debug(`read_file: ${path.relative(this.basePath, filePath)} (${stat.size} bytes${truncated ? ', truncated' : ''})`);
    return { tool_use_id: id, content };
  }

  private async listFiles(id: string, dirPath: string, pattern?: string): Promise<ToolResult> {
    const files = await glob(pattern ?? '*', {
      cwd: dirPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });
    this.logger.debug(`list_files: ${files.length} files in ${path.relative(this.basePath, dirPath) || '.'}`);
    return { tool_use_id: id, content: files.join('\n') };
  }

  private async searchContent(
    id: string,
    opts: { pattern: string; filePattern?: string; maxResults: number },
  ): Promise<ToolResult> {
    const files = await glob(opts.filePattern ?? '**/*', {
      cwd: this.basePath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });

    const regex = new RegExp(opts.pattern, 'gi');
    const results: Array<{ file: string; line: number; content: string }> = [];

    for (const file of files) {
      if (results.length >= opts.maxResults) break;

      try {
        const filePath = path.join(this.basePath, file);
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          this.logger.debug(`Skipped oversized file: ${file} (${stat.size} bytes)`);
          continue;
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const lineContent = lines[i];
          if (lineContent !== undefined && regex.test(lineContent)) {
            results.push({ file, line: i + 1, content: lineContent.trim() });
            if (results.length >= opts.maxResults) break;
          }
          regex.lastIndex = 0;
        }
      } catch (error) {
        this.logger.debug(`Skipped unreadable file: ${file} (${error instanceof Error ? error.message : 'unknown'})`);
      }
    }

    this.logger.debug(`search_content: ${results.length} matches for "${opts.pattern}"`);
    return {
      tool_use_id: id,
      content: JSON.stringify(results, null, 2),
    };
  }
}
