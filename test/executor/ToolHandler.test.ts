import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolHandler } from '../../src/executor/ToolHandler.js';
import type { ToolUseBlock } from '../../src/types/tools.js';

describe('ToolHandler', () => {
  let tmpDir: string;
  let handler: ToolHandler;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolhandler-'));
    handler = new ToolHandler(tmpDir);

    // Create test files
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export const foo = 42;\n');
    await fs.writeFile(path.join(tmpDir, 'src', 'utils.ts'), 'export function bar() { return "hello"; }\n');
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test Project\n\nSome content.\n');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTools', () => {
    it('returns three tool definitions', () => {
      const tools = handler.getTools();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name)).toEqual(['read_file', 'list_files', 'search_content']);
    });

    it('each tool has required fields', () => {
      for (const tool of handler.getTools()) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.input_schema).toBeDefined();
        expect(tool.input_schema.type).toBe('object');
      }
    });
  });

  describe('read_file', () => {
    it('reads file content', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'src/index.ts' }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe('export const foo = 42;\n');
    });

    it('returns error for non-existent file', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'nonexistent.ts' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Error');
    });

    it('blocks path traversal', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: '../../../etc/passwd' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('outside the target directory');
    });

    it('blocks absolute path outside base', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: '/etc/passwd' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('outside the target directory');
    });

    it('truncates files larger than 1 MB', async () => {
      const largeContent = 'x'.repeat(1_048_576 + 100);
      await fs.writeFile(path.join(tmpDir, 'large.bin'), largeContent);

      const result = await handler.fulfill(makeToolUse('read_file', { path: 'large.bin' }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('[Truncated:');
      // Content should be capped at ~1MB + truncation message, not the full file
      expect(result.content.length).toBeLessThan(largeContent.length);
    });
  });

  describe('list_files', () => {
    it('lists files in directory', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'src' }));
      expect(result.is_error).toBeUndefined();
      const files = result.content.split('\n');
      expect(files).toContain('index.ts');
      expect(files).toContain('utils.ts');
    });

    it('lists files with glob pattern', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'src', pattern: '*.ts' }));
      expect(result.is_error).toBeUndefined();
      const files = result.content.split('\n');
      expect(files).toContain('index.ts');
    });

    it('returns empty for nonexistent directory', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'nonexistent' }));
      // glob returns empty array when cwd doesn't exist
      expect(result.content).toBe('');
    });
  });

  describe('search_content', () => {
    it('finds matching content', async () => {
      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: 'export', path: '.' }),
      );
      expect(result.is_error).toBeUndefined();
      const matches = JSON.parse(result.content) as Array<{ file: string; line: number; content: string }>;
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('respects file pattern', async () => {
      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: 'export', path: '.', file_pattern: 'src/**/*.ts' }),
      );
      const matches = JSON.parse(result.content) as Array<{ file: string; line: number; content: string }>;
      expect(matches.every(m => m.file.startsWith('src/'))).toBe(true);
    });

    it('respects max_results', async () => {
      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: '.', path: '.', max_results: 1 }),
      );
      const matches = JSON.parse(result.content) as Array<unknown>;
      expect(matches.length).toBeLessThanOrEqual(1);
    });

    it('returns empty array for no matches', async () => {
      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: 'ZZZZNONEXISTENT', path: '.' }),
      );
      const matches = JSON.parse(result.content) as Array<unknown>;
      expect(matches).toEqual([]);
    });
  });

  describe('symlink handling', () => {
    it('symlink within base directory pointing outside is not blocked (known limitation)', async () => {
      // isPathSafe uses path.resolve() which does NOT follow symlinks.
      // A symlink inside the base dir pointing outside passes the prefix check.
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'sensitive data');

      try {
        await fs.symlink(outsideDir, path.join(tmpDir, 'escape-link'));

        // The path resolves to <tmpDir>/escape-link/secret.txt which passes startsWith(tmpDir)
        const result = await handler.fulfill(makeToolUse('read_file', { path: 'escape-link/secret.txt' }));

        // Known limitation: this reads the file through the symlink
        expect(result.is_error).toBeUndefined();
        expect(result.content).toBe('sensitive data');
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('symlink-based path traversal via .. is still blocked', async () => {
      // Even with symlinks, explicit ../.. traversal is caught by path.resolve
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'src/../../etc/passwd' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('outside the target directory');
    });
  });

  describe('unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const result = await handler.fulfill(makeToolUse('delete_file', { path: 'test.ts' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Unknown tool');
    });
  });
});

function makeToolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
  return {
    id: `tool_${Math.random().toString(36).slice(2, 8)}`,
    name,
    input,
  };
}
