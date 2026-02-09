import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolAdapter } from '../../src/ai/ToolAdapter.js';
import { ToolHandler } from '../../src/executor/ToolHandler.js';

describe('ToolAdapter', () => {
  let tmpDir: string;
  let toolHandler: ToolHandler;
  let adapter: ToolAdapter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tooladapter-'));
    await fs.writeFile(path.join(tmpDir, 'test.ts'), 'export const x = 1;\n');
    toolHandler = new ToolHandler(tmpDir);
    adapter = new ToolAdapter(toolHandler);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTools', () => {
    it('returns three tools', () => {
      const tools = adapter.getTools();
      expect(Object.keys(tools)).toEqual(['read_file', 'list_files', 'search_content']);
    });

    it('each tool has description and inputSchema', () => {
      const tools = adapter.getTools();
      for (const [, toolDef] of Object.entries(tools)) {
        expect(toolDef).toBeDefined();
        expect((toolDef as { description: string }).description).toBeTruthy();
      }
    });
  });

  describe('tool execution', () => {
    it('read_file executes through ToolHandler', async () => {
      const tools = adapter.getTools();
      const readFile = tools['read_file']!;
      // The execute function exists on tools with execute
      const exec = (readFile as { execute: (args: { path: string }) => Promise<string> }).execute;
      const result = await exec({ path: 'test.ts' });
      expect(result).toBe('export const x = 1;\n');
    });

    it('read_file throws on path traversal', async () => {
      const tools = adapter.getTools();
      const readFile = tools['read_file']!;
      const exec = (readFile as { execute: (args: { path: string }) => Promise<string> }).execute;
      await expect(exec({ path: '../../../etc/passwd' })).rejects.toThrow('outside the target directory');
    });

    it('list_files executes through ToolHandler', async () => {
      const tools = adapter.getTools();
      const listFiles = tools['list_files']!;
      const exec = (listFiles as { execute: (args: { path: string; pattern?: string }) => Promise<string> }).execute;
      const result = await exec({ path: '.' });
      expect(result).toContain('test.ts');
    });

    it('search_content executes through ToolHandler', async () => {
      const tools = adapter.getTools();
      const searchContent = tools['search_content']!;
      const exec = (searchContent as { execute: (args: { pattern: string; file_pattern?: string; max_results?: number }) => Promise<string> }).execute;
      const result = await exec({ pattern: 'export' });
      const parsed = JSON.parse(result) as Array<{ file: string; line: number; content: string }>;
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]!.content).toContain('export');
    });
  });
});
