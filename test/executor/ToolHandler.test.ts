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
    it('lists files in directory with metadata', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'src' }));
      expect(result.is_error).toBeUndefined();
      // New format includes metadata: "index.ts (22 B, 2 lines)"
      expect(result.content).toContain('index.ts');
      expect(result.content).toContain('utils.ts');
      // Verify metadata is present
      expect(result.content).toMatch(/\d+ B, \d+ lines/);
    });

    it('lists files with glob pattern', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'src', pattern: '*.ts' }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('index.ts');
    });

    it('respects max_results', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'src', pattern: '*.ts', max_results: 1 }));
      expect(result.is_error).toBeUndefined();
      const lines = result.content.split('\n').filter(l => !l.startsWith('\n'));
      // Should have 1 file + potentially "... and N more files"
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    it('returns error for nonexistent directory', async () => {
      const result = await handler.fulfill(makeToolUse('list_files', { path: 'nonexistent' }));
      // Nonexistent paths fail closed (realpath check) — correct security behavior
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('outside the target directory');
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
    it('blocks symlink within base directory pointing outside', async () => {
      // isPathSafe uses fs.realpath() to follow symlinks and detect escape
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'sensitive data');

      try {
        await fs.symlink(outsideDir, path.join(tmpDir, 'escape-link'));

        const result = await handler.fulfill(makeToolUse('read_file', { path: 'escape-link/secret.txt' }));

        expect(result.is_error).toBe(true);
        expect(result.content).toContain('outside the target directory');
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('symlink-based path traversal via .. is blocked', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'src/../../etc/passwd' }));
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('outside the target directory');
    });

    it('allows symlink that stays within base directory', async () => {
      await fs.symlink(path.join(tmpDir, 'src'), path.join(tmpDir, 'link-to-src'));

      const result = await handler.fulfill(makeToolUse('read_file', { path: 'link-to-src/index.ts' }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe('export const foo = 42;\n');
    });

    it('blocks sibling directory with base path prefix (CWE-22 prefix collision)', async () => {
      // Create a sibling directory whose name starts with the base dir name
      // e.g., if base is /tmp/toolhandler-abc, create /tmp/toolhandler-abc-evil
      const evilDir = tmpDir + '-evil';
      await fs.mkdir(evilDir, { recursive: true });
      await fs.writeFile(path.join(evilDir, 'stolen.txt'), 'sensitive data');

      try {
        // Construct a path that resolves to the evil sibling
        const relativePath = path.relative(tmpDir, path.join(evilDir, 'stolen.txt'));
        const result = await handler.fulfill(makeToolUse('read_file', { path: relativePath }));
        expect(result.is_error).toBe(true);
        expect(result.content).toContain('outside the target directory');
      } finally {
        await fs.rm(evilDir, { recursive: true, force: true });
      }
    });

    it('fails closed when realpath target does not exist', async () => {
      // Create a symlink pointing to a non-existent path within the logical base
      // The logical check passes but realpath will throw — must fail closed
      const danglingLink = path.join(tmpDir, 'dangling');
      await fs.symlink(path.join(tmpDir, 'nonexistent-target'), danglingLink);

      const result = await handler.fulfill(makeToolUse('read_file', { path: 'dangling' }));
      // Should fail — either the path safety check rejects it (fail-closed)
      // or the subsequent stat/read fails because the target doesn't exist
      expect(result.is_error).toBe(true);
    });
  });

  describe('read_file with line ranges', () => {
    beforeEach(async () => {
      // Create a multi-line file
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: content here`);
      await fs.writeFile(path.join(tmpDir, 'multi.ts'), lines.join('\n') + '\n');
    });

    it('reads specific line range', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'multi.ts', start_line: 5, end_line: 10 }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('[Lines 5-10 of 21]');
      expect(result.content).toContain('5\tline 5: content here');
      expect(result.content).toContain('10\tline 10: content here');
      expect(result.content).not.toContain('4\t');
      expect(result.content).not.toContain('11\t');
    });

    it('reads from start_line to end of file when no end_line', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'multi.ts', start_line: 18 }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('[Lines 18-21 of 21]');
      expect(result.content).toContain('18\tline 18: content here');
    });

    it('reads from beginning when only end_line specified', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'multi.ts', end_line: 3 }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('[Lines 1-3 of 21]');
      expect(result.content).toContain('1\tline 1: content here');
    });

    it('clamps out-of-bounds line numbers', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'multi.ts', start_line: 0, end_line: 999 }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('[Lines 1-21 of 21]');
    });

    it('returns full file without line range params', async () => {
      const result = await handler.fulfill(makeToolUse('read_file', { path: 'multi.ts' }));
      expect(result.is_error).toBeUndefined();
      // Should NOT have the [Lines X-Y] header
      expect(result.content).not.toContain('[Lines');
      expect(result.content).toContain('line 1: content here');
    });
  });

  describe('search_content modes', () => {
    it('files mode returns only file paths', async () => {
      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: 'export', path: '.', mode: 'files' }),
      );
      expect(result.is_error).toBeUndefined();
      const files = result.content.split('\n').filter(Boolean);
      expect(files).toContain('src/index.ts');
      expect(files).toContain('src/utils.ts');
      // Should be plain text, not JSON
      expect(result.content).not.toContain('{');
    });

    it('count mode returns per-file counts', async () => {
      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: 'export', path: '.', mode: 'count' }),
      );
      expect(result.is_error).toBeUndefined();
      const counts = JSON.parse(result.content) as Array<{ file: string; count: number }>;
      expect(counts.length).toBeGreaterThanOrEqual(2);
      expect(counts[0]).toHaveProperty('file');
      expect(counts[0]).toHaveProperty('count');
    });

    it('matches mode with context_lines includes surrounding lines', async () => {
      // Create a file with enough lines
      const lines = ['// header', 'export const a = 1;', '// footer', 'export const b = 2;', '// end'];
      await fs.writeFile(path.join(tmpDir, 'ctx.ts'), lines.join('\n') + '\n');

      const result = await handler.fulfill(
        makeToolUse('search_content', { pattern: 'export const a', path: '.', file_pattern: 'ctx.ts', context_lines: 1 }),
      );
      const matches = JSON.parse(result.content) as Array<{ file: string; line: number; content: string }>;
      expect(matches.length).toBe(1);
      // Context should include surrounding lines with line numbers
      expect(matches[0]!.content).toContain('header');
      expect(matches[0]!.content).toContain('footer');
    });
  });

  describe('get_file_info', () => {
    it('returns file metadata', async () => {
      const result = await handler.fulfill(makeToolUse('get_file_info', { path: 'src/index.ts' }));
      expect(result.is_error).toBeUndefined();
      const info = JSON.parse(result.content) as Record<string, unknown>;
      expect(info.path).toBe('src/index.ts');
      expect(info.size).toBeGreaterThan(0);
      expect(info.sizeFormatted).toBeDefined();
      expect(info.language).toBe('TypeScript');
      expect(info.lines).toBeGreaterThan(0);
      expect(info.modified).toBeDefined();
    });

    it('returns error for non-existent file', async () => {
      const result = await handler.fulfill(makeToolUse('get_file_info', { path: 'nonexistent.ts' }));
      expect(result.is_error).toBe(true);
    });
  });

  describe('get_directory_tree', () => {
    it('returns hierarchical tree', async () => {
      const result = await handler.fulfill(makeToolUse('get_directory_tree', { path: '.' }));
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('src/');
      expect(result.content).toContain('index.ts');
    });

    it('includes sizes by default', async () => {
      const result = await handler.fulfill(makeToolUse('get_directory_tree', { path: '.' }));
      expect(result.content).toMatch(/\d+ lines/);
      expect(result.content).toMatch(/\d+ B/);
    });

    it('excludes sizes when include_sizes is false', async () => {
      const result = await handler.fulfill(makeToolUse('get_directory_tree', { path: '.', include_sizes: false }));
      expect(result.content).not.toMatch(/\d+ B/);
    });

    it('respects max_depth', async () => {
      // Create nested structure
      await fs.mkdir(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'a', 'b', 'c', 'deep.ts'), 'export const x = 1;\n');

      const result = await handler.fulfill(makeToolUse('get_directory_tree', { path: '.', max_depth: 1 }));
      // Should see 'a/' but not expand deep into b/c
      expect(result.content).toContain('a/');
    });
  });

  describe('get_symbols', () => {
    it('extracts exported TypeScript symbols', async () => {
      const tsContent = [
        'export interface Config {',
        '  name: string;',
        '}',
        '',
        'export class Handler {',
        '  handle() {}',
        '}',
        '',
        'export function doStuff(x: number): string {',
        '  return String(x);',
        '}',
        '',
        'export const VERSION = "1.0.0";',
        '',
        'export type Result = { ok: boolean };',
        '',
        'function privateHelper() {}',
      ].join('\n');
      await fs.writeFile(path.join(tmpDir, 'symbols.ts'), tsContent);

      const result = await handler.fulfill(makeToolUse('get_symbols', { path: 'symbols.ts' }));
      expect(result.is_error).toBeUndefined();
      const symbols = JSON.parse(result.content) as Array<{ type: string; name: string; line: number; exported: boolean }>;

      // Should find 5 exported symbols (not the private one)
      expect(symbols).toHaveLength(5);
      expect(symbols.map(s => s.name)).toContain('Config');
      expect(symbols.map(s => s.name)).toContain('Handler');
      expect(symbols.map(s => s.name)).toContain('doStuff');
      expect(symbols.map(s => s.name)).toContain('VERSION');
      expect(symbols.map(s => s.name)).toContain('Result');
      expect(symbols.every(s => s.exported)).toBe(true);
    });

    it('includes private symbols when include_private is true', async () => {
      const tsContent = [
        'export function pub() {}',
        'function priv() {}',
      ].join('\n');
      await fs.writeFile(path.join(tmpDir, 'mixed.ts'), tsContent);

      const result = await handler.fulfill(makeToolUse('get_symbols', { path: 'mixed.ts', include_private: true }));
      const symbols = JSON.parse(result.content) as Array<{ name: string; exported: boolean }>;
      expect(symbols).toHaveLength(2);
      expect(symbols.find(s => s.name === 'priv')?.exported).toBe(false);
    });

    it('extracts Python symbols', async () => {
      const pyContent = [
        'def public_func(x, y):',
        '    return x + y',
        '',
        'class MyClass:',
        '    pass',
        '',
        'def _private_func():',
        '    pass',
      ].join('\n');
      await fs.writeFile(path.join(tmpDir, 'module.py'), pyContent);

      const result = await handler.fulfill(makeToolUse('get_symbols', { path: 'module.py' }));
      const symbols = JSON.parse(result.content) as Array<{ type: string; name: string; exported: boolean }>;
      // Private is filtered out by default
      expect(symbols.map(s => s.name)).toContain('public_func');
      expect(symbols.map(s => s.name)).toContain('MyClass');
      expect(symbols.map(s => s.name)).not.toContain('_private_func');
    });
  });

  describe('unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      // Use an existing path so the path safety check passes and we reach the tool dispatch
      const result = await handler.fulfill(makeToolUse('delete_file', { path: 'src/index.ts' }));
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
