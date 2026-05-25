import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import type { ToolUseBlock, ToolResult } from '../types/index.js';
import type { Logger } from '@uluops/sdk-core';
import { formatErrorMessage } from '../utils/formatError.js';
import { extractSymbols } from './symbols.js';

/** No-op logger for when none is provided */
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Max file size to read (1 MB). Matches Claude Code's file read limit; keeps tool results within token budget. */
const MAX_FILE_SIZE = 1_048_576;

/** Max file size for line counting (100 KB). Lower than MAX_FILE_SIZE because line splitting is memory-intensive. */
const MAX_LINE_COUNT_SIZE = 102_400;

/** Timeout for glob operations (30s). Prevents hangs on large or network-mounted filesystems. */
const GLOB_TIMEOUT_MS = 30_000;

/** Default max results for list_files. Balances completeness vs token cost in a single tool response. */
const DEFAULT_LIST_MAX_RESULTS = 200;

/** Max directory entries per level in get_directory_tree. Prevents enormous trees from flooding the context window. */
const MAX_DIR_ENTRIES = 50;

/**
 * Handles filesystem tool calls, fulfilling them against the local target directory.
 * All paths are sandboxed to the base path to prevent directory traversal.
 *
 * LOAD-BEARING (2026-04-16): despite its utility-style placement under executor/,
 * this class is the effective security boundary for all agent filesystem access.
 * File reads, directory listings, content searches, and path traversal prevention
 * all converge here. Changes to sandboxing logic affect every agent type.
 */
export class ToolHandler {
  private basePath: string;
  private realBasePath: string | undefined;
  private logger: Logger;

  constructor(basePath: string, logger?: Logger) {
    this.basePath = path.resolve(basePath);
    this.logger = logger ?? noopLogger;
  }

  /**
   * Get the real (symlink-resolved) base path, lazily computed.
   * Required on macOS where /tmp → /private/tmp, causing realpath
   * comparisons to fail against the logical basePath.
   */
  private async getRealBasePath(): Promise<string> {
    if (this.realBasePath === undefined) {
      try {
        this.realBasePath = await fs.realpath(this.basePath);
      } catch {
        this.realBasePath = this.basePath;
      }
    }
    return this.realBasePath;
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
    // Log tool name and path only — full input may contain sensitive search patterns
    // or file paths that reveal secrets in the target project (CWE-532)
    this.logger.debug(`Tool: ${toolUse.name}(path=${String(toolUse.input['path'] || '.')})`);

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

      const input = toolUse.input;

      switch (toolUse.name) {
        case 'read_file':
          return await this.readFile(toolUse.id, fullPath, {
            startLine: toNumber(input['start_line']),
            endLine: toNumber(input['end_line']),
          });

        case 'list_files':
          return await this.listFiles(toolUse.id, fullPath, {
            pattern: toString(input['pattern']),
            maxResults: toNumber(input['max_results']) ?? DEFAULT_LIST_MAX_RESULTS,
          });

        case 'search_content': {
          const modeRaw = toString(input['mode']);
          const mode = modeRaw === 'files' || modeRaw === 'count' ? modeRaw : 'matches';
          return await this.searchContent(toolUse.id, {
            pattern: toString(input['pattern']) ?? '',
            filePattern: toString(input['file_pattern']),
            maxResults: toNumber(input['max_results']) ?? 50,
            mode,
            contextLines: Math.min(toNumber(input['context_lines']) ?? 0, 5),
          });
        }

        case 'get_file_info':
          return await this.getFileInfo(toolUse.id, fullPath, relativePath);

        case 'get_directory_tree':
          return await this.getDirectoryTree(toolUse.id, fullPath, {
            maxDepth: Math.min(toNumber(input['max_depth']) ?? 3, 10),
            includeSizes: input['include_sizes'] !== false,
          });

        case 'get_symbols':
          return await this.getSymbols(toolUse.id, fullPath, {
            includePrivate: input['include_private'] === true,
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
   * Reject glob patterns that could escape the sandbox (CWE-22).
   * Blocks ../ traversal, absolute paths, and backslash escapes.
   */
  private isGlobPatternSafe(pattern: string): boolean {
    if (pattern.startsWith('/') || pattern.startsWith('\\')) return false;
    if (pattern.includes('..')) return false;
    return true;
  }

  /**
   * Check if resolved path is within base path (security).
   * Uses fs.realpath() to follow symlinks and detect escape attempts.
   */
  private async isPathSafe(fullPath: string): Promise<boolean> {
    // First check: logical path must be within base (catches ../.. traversal).
    // Append path.sep to prevent prefix collisions (e.g., /tmp/target-evil matching /tmp/target).
    const logicalPath = path.resolve(fullPath);
    if (logicalPath !== this.basePath && !logicalPath.startsWith(this.basePath + path.sep)) return false;

    // Second check: resolve symlinks to detect escape via symlink.
    // Compare against realpath-resolved base to handle platforms where
    // tmpdir is a symlink (e.g., macOS /tmp → /private/tmp).
    try {
      const realPath = await fs.realpath(fullPath);
      const realBase = await this.getRealBasePath();
      return realPath === realBase || realPath.startsWith(realBase + path.sep);
    } catch {
      // Path doesn't exist — fail closed to prevent TOCTOU symlink races
      return false;
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
      if (stat.size > MAX_FILE_SIZE) {
        return {
          tool_use_id: id,
          content: `File too large for line-range read (${(stat.size / 1024).toFixed(0)}KB > ${(MAX_FILE_SIZE / 1024).toFixed(0)}KB limit): ${relativePath}`,
          is_error: true,
        };
      }
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
    const globPattern = opts.pattern ?? '*';
    if (!this.isGlobPatternSafe(globPattern)) {
      return { tool_use_id: id, content: 'Error: glob pattern must not contain ".." or absolute paths', is_error: true };
    }

    const files = await glob(globPattern, {
      cwd: dirPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      follow: false,
      signal: AbortSignal.timeout(GLOB_TIMEOUT_MS),
    });

    const totalFiles = files.length;
    const capped = files.slice(0, opts.maxResults);
    const lines: string[] = [];

    // Process in batches to limit concurrent I/O (each file needs stat + read for line counting)
    const BATCH_SIZE = 20;
    const entries: string[] = [];
    for (let b = 0; b < capped.length; b += BATCH_SIZE) {
      const batch = capped.slice(b, b + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (file) => {
        const filePath = path.join(dirPath, file);
        try {
          if (!(await this.isPathSafe(filePath))) return file;
          const stat = await fs.stat(filePath);
          const sizeStr = formatFileSize(stat.size);
          const lineCount = await countLines(filePath, stat.size);
          return lineCount
            ? `${file} (${sizeStr}, ${lineCount} lines)`
            : `${file} (${sizeStr})`;
        } catch {
          return file;
        }
      }));
      entries.push(...batchResults);
    }
    lines.push(...entries);

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
    const fileGlob = opts.filePattern ?? '**/*';
    if (!this.isGlobPatternSafe(fileGlob)) {
      return { tool_use_id: id, content: 'Error: file pattern must not contain ".." or absolute paths', is_error: true };
    }

    const files = await glob(fileGlob, {
      cwd: this.basePath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      follow: false,
      signal: AbortSignal.timeout(GLOB_TIMEOUT_MS),
    });

    // Cap pattern length to mitigate ReDoS from LLM-generated pathological regexes (CWE-1333)
    if (opts.pattern.length > 200) {
      return { tool_use_id: id, content: `Error: regex pattern too long (${opts.pattern.length} chars, max 200)`, is_error: true };
    }

    // Reject patterns with nested quantifiers or alternation explosions that cause
    // catastrophic backtracking (CWE-1333).
    // Nested quantifiers: (x+)+, (x*)+, (x+)*, (x{n,})+, ([...]+)+
    // Alternation explosion: (a|aa)+, (a|a?)+  — overlapping alternation under quantifier
    if (/(\([^)]*[+*][^)]*\))[+*]|\(\?:[^)]*[+*][^)]*\)[+*]/.test(opts.pattern)) {
      return { tool_use_id: id, content: 'Error: regex pattern contains nested quantifiers which may cause catastrophic backtracking', is_error: true };
    }
    // Detect overlapping alternation under quantifier: (alt1|alt2)+ where alternatives overlap.
    // Conservative heuristic: any group with alternation followed by a quantifier.
    if (/\([^)]*\|[^)]*\)[+*{]/.test(opts.pattern)) {
      return { tool_use_id: id, content: 'Error: regex pattern contains alternation under quantifier which may cause catastrophic backtracking', is_error: true };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(opts.pattern, 'gi');
    } catch {
      return { tool_use_id: id, content: `Error: invalid regex pattern: ${opts.pattern}`, is_error: true };
    }

    switch (opts.mode) {
      case 'files': {
        const matching = await this.searchFileMode(files, regex, opts.maxResults);
        this.logger.debug(`search_content(files): ${matching.length} files match "${opts.pattern}"`);
        return { tool_use_id: id, content: matching.join('\n') };
      }
      case 'count': {
        const counts = await this.searchCountMode(files, regex, opts.maxResults);
        this.logger.debug(`search_content(count): ${counts.length} files match "${opts.pattern}"`);
        return { tool_use_id: id, content: JSON.stringify(counts, null, 2) };
      }
      default: {
        const results = await this.searchMatchesMode(files, regex, opts.maxResults, opts.contextLines);
        this.logger.debug(`search_content: ${results.length} matches for "${opts.pattern}"`);
        return { tool_use_id: id, content: JSON.stringify(results, null, 2) };
      }
    }
  }

  private async searchFileMode(files: string[], regex: RegExp, maxResults: number): Promise<string[]> {
    const matching: string[] = [];
    for (const file of files) {
      if (matching.length >= maxResults) break;
      try {
        const filePath = path.join(this.basePath, file);
        if (!(await this.isPathSafe(filePath))) continue;
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        if (regex.test(content)) matching.push(file);
        regex.lastIndex = 0;
      } catch (error) {
        this.logger.debug(`Skipped unreadable file: ${file} (${error instanceof Error ? error.message : 'unknown'})`);
      }
    }
    return matching;
  }

  private async searchCountMode(
    files: string[],
    regex: RegExp,
    maxResults: number,
  ): Promise<Array<{ file: string; count: number }>> {
    const counts: Array<{ file: string; count: number }> = [];
    for (const file of files) {
      if (counts.length >= maxResults) break;
      try {
        const filePath = path.join(this.basePath, file);
        if (!(await this.isPathSafe(filePath))) continue;
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        regex.lastIndex = 0; // Reset stateful 'g' flag
        const matches = content.match(regex);
        if (matches && matches.length > 0) {
          counts.push({ file, count: matches.length });
        }
      } catch (error) {
        this.logger.debug(`Skipped unreadable file: ${file} (${error instanceof Error ? error.message : 'unknown'})`);
      }
    }
    return counts;
  }

  private async searchMatchesMode(
    files: string[],
    regex: RegExp,
    maxResults: number,
    contextLines: number,
  ): Promise<Array<{ file: string; line: number; content: string }>> {
    const results: Array<{ file: string; line: number; content: string }> = [];

    for (const file of files) {
      if (results.length >= maxResults) break;
      try {
        const filePath = path.join(this.basePath, file);
        if (!(await this.isPathSafe(filePath))) continue;
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
            if (contextLines > 0) {
              const ctxStart = Math.max(0, i - contextLines);
              const ctxEnd = Math.min(lines.length - 1, i + contextLines);
              const ctxLines = lines.slice(ctxStart, ctxEnd + 1).map(
                (l, idx) => `${ctxStart + idx + 1}\t${l}`,
              );
              matchContent = ctxLines.join('\n');
            }
            results.push({ file, line: i + 1, content: matchContent });
            if (results.length >= maxResults) break;
          }
          regex.lastIndex = 0;
        }
      } catch (error) {
        this.logger.debug(`Skipped unreadable file: ${file} (${error instanceof Error ? error.message : 'unknown'})`);
      }
    }

    return results;
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

    const lineCount = await countLines(filePath, stat.size);
    if (lineCount !== undefined) info.lines = lineCount;

    this.logger.debug(`get_file_info: ${relativePath} (${info.sizeFormatted})`);
    return { tool_use_id: id, content: JSON.stringify(info, null, 2) };
  }

  private async getDirectoryTree(
    id: string,
    dirPath: string,
    opts: { maxDepth: number; includeSizes: boolean },
  ): Promise<ToolResult> {
    const { lines } = await this.buildTree(dirPath, '', 0, opts.maxDepth, opts.includeSizes);
    const relativePath = path.relative(this.basePath, dirPath) || '.';
    this.logger.debug(`get_directory_tree: ${relativePath} (${lines.length} entries)`);
    return { tool_use_id: id, content: lines.join('\n') };
  }

  /**
   * Recursively build directory tree, returning lines and accumulated stats.
   * Stats bubble up so parent directories can display file count + total size
   * without a redundant recursive glob + stat pass.
   *
   * I/O profile: performs fs.stat() + fs.readFile() per file when includeSizes=true
   * (for line counting). With maxDepth=3 and MAX_DIR_ENTRIES=50 per level, worst case
   * is ~150 stat+read operations per tree call. Bounded by MAX_DIR_ENTRIES cap per
   * directory and maxDepth limit. Acceptable for single-call-per-agent usage.
   */
  private async buildTree(
    dirPath: string,
    indent: string,
    depth: number,
    maxDepth: number,
    includeSizes: boolean,
  ): Promise<{ lines: string[]; fileCount: number; totalSize: number }> {
    const lines: string[] = [];
    let fileCount = 0;
    let totalSize = 0;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return { lines, fileCount, totalSize };
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
        // Sandbox check: prevent symlinked directories from escaping the base path
        if (!(await this.isPathSafe(fullDirPath))) continue;

        // Recurse first to get accumulated stats
        const sub = await this.buildTree(fullDirPath, indent + '  ', depth + 1, maxDepth, includeSizes);

        // Build directory header from accumulated stats (no redundant glob)
        let suffix = `${sub.fileCount} files`;
        if (includeSizes) suffix += `, ${formatFileSize(sub.totalSize)}`;
        lines.push(`${indent}${dirName}/ (${suffix})`);
        lines.push(...sub.lines);

        // Bubble up stats
        fileCount += sub.fileCount;
        totalSize += sub.totalSize;
      } else {
        lines.push(`${indent}${dirName}/`);
      }
    }

    // Files (capped)
    const shownFiles = files.slice(0, MAX_DIR_ENTRIES);
    for (const file of shownFiles) {
      const { line, size } = await this.formatFileEntry(dirPath, String(file.name), indent, includeSizes);
      lines.push(line);
      fileCount++;
      totalSize += size;
    }

    // Count files beyond the display cap (still accumulate stats)
    if (files.length > MAX_DIR_ENTRIES) {
      lines.push(`${indent}... and ${files.length - MAX_DIR_ENTRIES} more files`);
      const overflow = files.slice(MAX_DIR_ENTRIES);
      fileCount += overflow.length;
      if (includeSizes) {
        const sizes = await Promise.all(overflow.map(async (file) => {
          try {
            const stat = await fs.stat(path.join(dirPath, String(file.name)));
            return stat.size;
          } catch {
            return 0;
          }
        }));
        totalSize += sizes.reduce((a, b) => a + b, 0);
      }
    }

    return { lines, fileCount, totalSize };
  }

  private async formatFileEntry(
    dirPath: string,
    fileName: string,
    indent: string,
    includeSizes: boolean,
  ): Promise<{ line: string; size: number }> {
    if (!includeSizes) return { line: `${indent}${fileName}`, size: 0 };

    try {
      const filePath = path.join(dirPath, fileName);
      const stat = await fs.stat(filePath);
      const sizeStr = formatFileSize(stat.size);
      const lc = await countLines(filePath, stat.size);
      return lc
        ? { line: `${indent}${fileName} (${lc} lines, ${sizeStr})`, size: stat.size }
        : { line: `${indent}${fileName} (${sizeStr})`, size: stat.size };
    } catch {
      return { line: `${indent}${fileName}`, size: 0 };
    }
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

/** Narrow unknown to number (runtime typeof check instead of `as` cast). */
function toNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Narrow unknown to string (runtime typeof check instead of `as` cast). */
function toString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Map a file extension (e.g., '.ts') to a human-readable language name (e.g., 'TypeScript'). */
export function extToLanguage(ext: string): string {
  return LANG_MAP[ext.toLowerCase()] ?? 'Unknown';
}

/** Count lines in a file if under MAX_LINE_COUNT_SIZE, otherwise return undefined. */
async function countLines(filePath: string, size: number): Promise<number | undefined> {
  if (size > MAX_LINE_COUNT_SIZE) return undefined;
  const content = await fs.readFile(filePath, 'utf-8');
  return content.split('\n').length;
}

// Symbol extraction moved to ./symbols.ts
