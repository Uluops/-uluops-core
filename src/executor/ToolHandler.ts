import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import type { Tool, ToolUseBlock, ToolResult } from '../types/index.js';
import type { Logger } from '@uluops/sdk-core';
import { formatErrorMessage } from '../utils/formatError.js';

/** No-op logger for when none is provided */
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Max file size to read (1 MB). Matches Claude Code's file read limit; keeps tool results within token budget. */
const MAX_FILE_SIZE = 1_048_576;

/** Max file size for line counting (100 KB). Lower than MAX_FILE_SIZE because line splitting is memory-intensive. */
const MAX_LINE_COUNT_SIZE = 102_400;

/** Default max results for list_files. Balances completeness vs token cost in a single tool response. */
const DEFAULT_LIST_MAX_RESULTS = 200;

/** Max directory entries per level in get_directory_tree. Prevents enormous trees from flooding the context window. */
const MAX_DIR_ENTRIES = 50;

/**
 * Handles filesystem tool calls, fulfilling them against the local target directory.
 * All paths are sandboxed to the base path to prevent directory traversal.
 */
export class ToolHandler {
  private basePath: string;
  private logger: Logger;

  constructor(basePath: string, logger?: Logger) {
    this.basePath = path.resolve(basePath);
    this.logger = logger ?? noopLogger;
  }

  /**
   * Get tool definitions for LLM API.
   */
  getTools(): Tool[] {
    return [
      {
        name: 'read_file',
        description:
          'Read the contents of a file. Use start_line/end_line for large files to avoid reading the entire file.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to target directory',
            },
            start_line: {
              type: 'integer',
              description: 'First line to read (1-based). Default: 1',
            },
            end_line: {
              type: 'integer',
              description: 'Last line to read (1-based). Default: end of file',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_files',
        description:
          'List files in a directory with size/line metadata. Supports glob patterns. Results are capped at max_results.',
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
            max_results: {
              type: 'integer',
              description: `Maximum files to return. Default: ${DEFAULT_LIST_MAX_RESULTS}`,
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_content',
        description:
          'Search for a pattern across files. Supports regex. Use mode to control output verbosity.',
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
            mode: {
              type: 'string',
              description:
                'Output mode: "matches" (default, matching lines), "files" (file paths only), "count" (per-file match counts)',
            },
            context_lines: {
              type: 'integer',
              description: 'Lines of context before/after each match (0-5). Default: 0',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'get_file_info',
        description:
          'Get file metadata (size, line count, language) without reading content. Use before read_file to decide what to read.',
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
        name: 'get_directory_tree',
        description:
          'Get a hierarchical view of a directory with file counts and sizes. More structured than list_files.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to target',
            },
            max_depth: {
              type: 'integer',
              description: 'Maximum depth to traverse. Default: 3',
            },
            include_sizes: {
              type: 'boolean',
              description: 'Include file sizes. Default: true',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'get_symbols',
        description:
          'Extract exported symbols (functions, classes, interfaces, types, constants) from a source file with line numbers.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to target directory',
            },
            include_private: {
              type: 'boolean',
              description: 'Include non-exported symbols. Default: false',
            },
          },
          required: ['path'],
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
          return await this.readFile(toolUse.id, fullPath, {
            startLine: toolUse.input['start_line'] as number | undefined,
            endLine: toolUse.input['end_line'] as number | undefined,
          });

        case 'list_files':
          return await this.listFiles(toolUse.id, fullPath, {
            pattern: toolUse.input['pattern'] as string | undefined,
            maxResults: (toolUse.input['max_results'] as number | undefined) ?? DEFAULT_LIST_MAX_RESULTS,
          });

        case 'search_content':
          return await this.searchContent(toolUse.id, {
            pattern: toolUse.input['pattern'] as string,
            filePattern: toolUse.input['file_pattern'] as string | undefined,
            maxResults: (toolUse.input['max_results'] as number | undefined) ?? 50,
            mode: (toolUse.input['mode'] as 'matches' | 'files' | 'count' | undefined) ?? 'matches',
            contextLines: Math.min((toolUse.input['context_lines'] as number | undefined) ?? 0, 5),
          });

        case 'get_file_info':
          return await this.getFileInfo(toolUse.id, fullPath, relativePath);

        case 'get_directory_tree':
          return await this.getDirectoryTree(toolUse.id, fullPath, {
            maxDepth: (toolUse.input['max_depth'] as number | undefined) ?? 3,
            includeSizes: (toolUse.input['include_sizes'] as boolean | undefined) ?? true,
          });

        case 'get_symbols':
          return await this.getSymbols(toolUse.id, fullPath, {
            includePrivate: (toolUse.input['include_private'] as boolean | undefined) ?? false,
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

  private async readFile(
    id: string,
    filePath: string,
    opts: { startLine?: number; endLine?: number },
  ): Promise<ToolResult> {
    const stat = await fs.stat(filePath);
    const relativePath = path.relative(this.basePath, filePath);

    // Line-range mode: read specific lines
    if (opts.startLine !== undefined || opts.endLine !== undefined) {
      const content = await fs.readFile(filePath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;
      const start = Math.max(1, opts.startLine ?? 1);
      const end = Math.min(totalLines, opts.endLine ?? totalLines);

      const slice = allLines.slice(start - 1, end);
      const numbered = slice.map((line, i) => `${start + i}\t${line}`).join('\n');
      const header = `[Lines ${start}-${end} of ${totalLines}] ${relativePath}\n`;

      this.logger.debug(`read_file: ${relativePath} lines ${start}-${end} of ${totalLines}`);
      return { tool_use_id: id, content: header + numbered };
    }

    // Full-file mode (original behavior)
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
    this.logger.debug(`read_file: ${relativePath} (${stat.size} bytes${truncated ? ', truncated' : ''})`);
    return { tool_use_id: id, content };
  }

  private async listFiles(
    id: string,
    dirPath: string,
    opts: { pattern?: string; maxResults: number },
  ): Promise<ToolResult> {
    const files = await glob(opts.pattern ?? '*', {
      cwd: dirPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });

    const totalFiles = files.length;
    const capped = files.slice(0, opts.maxResults);
    const lines: string[] = [];

    for (const file of capped) {
      const filePath = path.join(dirPath, file);
      try {
        const stat = await fs.stat(filePath);
        const sizeStr = formatFileSize(stat.size);
        if (stat.size <= MAX_LINE_COUNT_SIZE) {
          const content = await fs.readFile(filePath, 'utf-8');
          const lineCount = content.split('\n').length;
          lines.push(`${file} (${sizeStr}, ${lineCount} lines)`);
        } else {
          lines.push(`${file} (${sizeStr})`);
        }
      } catch {
        lines.push(file);
      }
    }

    if (totalFiles > opts.maxResults) {
      lines.push(`\n... and ${totalFiles - opts.maxResults} more files`);
    }

    this.logger.debug(`list_files: ${totalFiles} files in ${path.relative(this.basePath, dirPath) || '.'} (showing ${capped.length})`);
    return { tool_use_id: id, content: lines.join('\n') };
  }

  private async searchContent(
    id: string,
    opts: {
      pattern: string;
      filePattern?: string;
      maxResults: number;
      mode: 'matches' | 'files' | 'count';
      contextLines: number;
    },
  ): Promise<ToolResult> {
    const files = await glob(opts.filePattern ?? '**/*', {
      cwd: this.basePath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });

    const regex = new RegExp(opts.pattern, 'gi');

    if (opts.mode === 'files') {
      const matchingFiles: string[] = [];
      for (const file of files) {
        if (matchingFiles.length >= opts.maxResults) break;
        try {
          const filePath = path.join(this.basePath, file);
          const stat = await fs.stat(filePath);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = await fs.readFile(filePath, 'utf-8');
          if (regex.test(content)) {
            matchingFiles.push(file);
          }
          regex.lastIndex = 0;
        } catch {
          // skip unreadable
        }
      }
      this.logger.debug(`search_content(files): ${matchingFiles.length} files match "${opts.pattern}"`);
      return { tool_use_id: id, content: matchingFiles.join('\n') };
    }

    if (opts.mode === 'count') {
      const counts: Array<{ file: string; count: number }> = [];
      for (const file of files) {
        if (counts.length >= opts.maxResults) break;
        try {
          const filePath = path.join(this.basePath, file);
          const stat = await fs.stat(filePath);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = await fs.readFile(filePath, 'utf-8');
          const matches = content.match(new RegExp(opts.pattern, 'gi'));
          if (matches && matches.length > 0) {
            counts.push({ file, count: matches.length });
          }
        } catch {
          // skip unreadable
        }
      }
      this.logger.debug(`search_content(count): ${counts.length} files match "${opts.pattern}"`);
      return { tool_use_id: id, content: JSON.stringify(counts, null, 2) };
    }

    // Default: "matches" mode
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
            let matchContent = lineContent.trim();
            if (opts.contextLines > 0) {
              const ctxStart = Math.max(0, i - opts.contextLines);
              const ctxEnd = Math.min(lines.length - 1, i + opts.contextLines);
              const ctxLines = lines.slice(ctxStart, ctxEnd + 1).map(
                (l, idx) => `${ctxStart + idx + 1}\t${l}`,
              );
              matchContent = ctxLines.join('\n');
            }
            results.push({ file, line: i + 1, content: matchContent });
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

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Reconnaissance Tools
  // ─────────────────────────────────────────────────────────────────────────

  private async getFileInfo(id: string, filePath: string, relativePath: string): Promise<ToolResult> {
    const stat = await fs.stat(filePath);
    const ext = path.extname(filePath);
    const language = extToLanguage(ext);

    const info: Record<string, unknown> = {
      path: relativePath,
      size: stat.size,
      sizeFormatted: formatFileSize(stat.size),
      language,
      modified: stat.mtime.toISOString(),
    };

    if (stat.size <= MAX_LINE_COUNT_SIZE) {
      const content = await fs.readFile(filePath, 'utf-8');
      info.lines = content.split('\n').length;
    }

    this.logger.debug(`get_file_info: ${relativePath} (${info.sizeFormatted})`);
    return { tool_use_id: id, content: JSON.stringify(info, null, 2) };
  }

  private async getDirectoryTree(
    id: string,
    dirPath: string,
    opts: { maxDepth: number; includeSizes: boolean },
  ): Promise<ToolResult> {
    const lines = await this.buildTree(dirPath, '', 0, opts.maxDepth, opts.includeSizes);
    const relativePath = path.relative(this.basePath, dirPath) || '.';
    this.logger.debug(`get_directory_tree: ${relativePath} (${lines.length} entries)`);
    return { tool_use_id: id, content: lines.join('\n') };
  }

  private async buildTree(
    dirPath: string,
    indent: string,
    depth: number,
    maxDepth: number,
    includeSizes: boolean,
  ): Promise<string[]> {
    const lines: string[] = [];

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return lines;
    }

    // Filter out hidden/ignored directories
    const filtered = entries.filter(
      (e) => !String(e.name).startsWith('.') && String(e.name) !== 'node_modules' && String(e.name) !== 'dist' && String(e.name) !== 'build',
    );

    // Separate dirs and files, sort alphabetically
    const dirs = filtered.filter((e) => e.isDirectory()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const files = filtered.filter((e) => e.isFile()).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // Directories first
    for (const dir of dirs) {
      const dirName = String(dir.name);
      const fullDirPath = path.join(dirPath, dirName);

      if (depth < maxDepth) {
        // Count files in subdir for summary
        const subFiles = await glob('**/*', {
          cwd: fullDirPath,
          nodir: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        });

        let dirSuffix = `${subFiles.length} files`;
        if (includeSizes) {
          let totalSize = 0;
          for (const sf of subFiles) {
            try {
              const s = await fs.stat(path.join(fullDirPath, sf));
              totalSize += s.size;
            } catch {
              // skip
            }
          }
          dirSuffix += `, ${formatFileSize(totalSize)}`;
        }

        lines.push(`${indent}${dirName}/ (${dirSuffix})`);
        const subLines = await this.buildTree(fullDirPath, indent + '  ', depth + 1, maxDepth, includeSizes);
        lines.push(...subLines);
      } else {
        lines.push(`${indent}${dirName}/`);
      }
    }

    // Files (capped)
    const shownFiles = files.slice(0, MAX_DIR_ENTRIES);
    for (const file of shownFiles) {
      const fileName = String(file.name);
      const fullFilePath = path.join(dirPath, fileName);
      if (includeSizes) {
        try {
          const stat = await fs.stat(fullFilePath);
          const sizeStr = formatFileSize(stat.size);
          if (stat.size <= MAX_LINE_COUNT_SIZE) {
            const content = await fs.readFile(fullFilePath, 'utf-8');
            const lineCount = content.split('\n').length;
            lines.push(`${indent}${fileName} (${lineCount} lines, ${sizeStr})`);
          } else {
            lines.push(`${indent}${fileName} (${sizeStr})`);
          }
        } catch {
          lines.push(`${indent}${fileName}`);
        }
      } else {
        lines.push(`${indent}${fileName}`);
      }
    }

    if (files.length > MAX_DIR_ENTRIES) {
      lines.push(`${indent}... and ${files.length - MAX_DIR_ENTRIES} more files`);
    }

    return lines;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: Symbol Extraction
  // ─────────────────────────────────────────────────────────────────────────

  private async getSymbols(
    id: string,
    filePath: string,
    opts: { includePrivate: boolean },
  ): Promise<ToolResult> {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return { tool_use_id: id, content: 'Error: File too large for symbol extraction', is_error: true };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();
    const symbols = extractSymbols(lines, ext, opts.includePrivate);

    const relativePath = path.relative(this.basePath, filePath);
    this.logger.debug(`get_symbols: ${relativePath} (${symbols.length} symbols)`);
    return { tool_use_id: id, content: JSON.stringify(symbols, null, 2) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript/React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript/React',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.md': 'Markdown',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
};

function extToLanguage(ext: string): string {
  return LANG_MAP[ext.toLowerCase()] ?? 'Unknown';
}

interface SymbolInfo {
  type: string;
  name: string;
  line: number;
  exported: boolean;
  signature?: string;
}

function extractSymbols(lines: string[], ext: string, includePrivate: boolean): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const isTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPython = ext === '.py';

  if (isTS) {
    extractTSSymbols(lines, symbols);
  } else if (isPython) {
    extractPythonSymbols(lines, symbols);
  }

  if (!includePrivate) {
    return symbols.filter((s) => s.exported);
  }
  return symbols;
}

function extractTSSymbols(lines: string[], symbols: SymbolInfo[]): void {
  const patterns: Array<{ regex: RegExp; type: string; sigGroup?: number }> = [
    { regex: /^export\s+(async\s+)?function\s+(\w+)/, type: 'function' },
    { regex: /^export\s+class\s+(\w+)/, type: 'class' },
    { regex: /^export\s+interface\s+(\w+)/, type: 'interface' },
    { regex: /^export\s+type\s+(\w+)/, type: 'type' },
    { regex: /^export\s+(?:const|let|var)\s+(\w+)/, type: 'const' },
    { regex: /^export\s+enum\s+(\w+)/, type: 'enum' },
    { regex: /^export\s+default\s+(?:class|function)\s*(\w*)/, type: 'default' },
    // Non-exported
    { regex: /^(?:async\s+)?function\s+(\w+)/, type: 'function' },
    { regex: /^class\s+(\w+)/, type: 'class' },
    { regex: /^interface\s+(\w+)/, type: 'interface' },
    { regex: /^type\s+(\w+)/, type: 'type' },
    { regex: /^(?:const|let|var)\s+(\w+)/, type: 'const' },
    { regex: /^enum\s+(\w+)/, type: 'enum' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const p of patterns) {
      const match = p.regex.exec(line);
      if (match) {
        const exported = line.startsWith('export');
        // For function patterns with async, name is in group 2 for exported, else group 1
        let name: string;
        if (p.type === 'function' && exported) {
          name = match[2] ?? match[1] ?? '';
        } else {
          name = match[1] ?? '';
        }
        if (!name) continue;

        // Build signature for functions
        let signature: string | undefined;
        if (p.type === 'function') {
          // Capture up to closing paren and return type
          const sigMatch = /function\s+\w+\s*(\([^)]*\)(?:\s*:\s*\S+)?)/.exec(line);
          if (sigMatch) {
            signature = `${name}${sigMatch[1]}`;
          }
        }

        symbols.push({
          type: p.type,
          name,
          line: i + 1,
          exported,
          ...(signature ? { signature } : {}),
        });
        break; // Only match first pattern per line
      }
    }
  }
}

function extractPythonSymbols(lines: string[], symbols: SymbolInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Top-level functions (no indentation)
    const funcMatch = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(line);
    if (funcMatch) {
      const name = funcMatch[2]!;
      symbols.push({
        type: 'function',
        name,
        line: i + 1,
        exported: !name.startsWith('_'),
        signature: `${name}(${funcMatch[3]})`,
      });
      continue;
    }

    // Top-level classes (no indentation)
    const classMatch = /^class\s+(\w+)/.exec(line);
    if (classMatch) {
      symbols.push({
        type: 'class',
        name: classMatch[1]!,
        line: i + 1,
        exported: !classMatch[1]!.startsWith('_'),
      });
    }
  }
}
