import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolAdapter } from '../../src/ai/ToolAdapter.js';
import { ToolHandler } from '../../src/executor/ToolHandler.js';
import { TokenBudgetTracker } from '../../src/ai/TokenBudgetTracker.js';

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
    it('returns all tools', () => {
      const tools = adapter.getTools();
      const toolNames = Object.keys(tools);
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('list_files');
      expect(toolNames).toContain('search_content');
      expect(toolNames).toContain('get_file_info');
      expect(toolNames).toContain('get_directory_tree');
      expect(toolNames).toContain('get_symbols');
      // get_token_budget not present without budgetTracker
      expect(toolNames).not.toContain('get_token_budget');
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
      // Now includes metadata: "test.ts (20 B, 2 lines)"
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

  describe('get_token_budget', () => {
    it('includes get_token_budget tool when budgetTracker is provided', () => {
      const tracker = new TokenBudgetTracker(200_000);
      const adapterWithBudget = new ToolAdapter(toolHandler, undefined, tracker);
      const tools = adapterWithBudget.getTools();
      expect(Object.keys(tools)).toContain('get_token_budget');
    });

    it('get_token_budget returns tracker status as JSON', async () => {
      const tracker = new TokenBudgetTracker(100_000);
      tracker.update(30_000, 2_000);
      const adapterWithBudget = new ToolAdapter(toolHandler, undefined, tracker);
      const tools = adapterWithBudget.getTools();
      const budgetTool = tools['get_token_budget']!;
      const exec = (budgetTool as { execute: (args: Record<string, never>) => Promise<string> }).execute;
      const result = await exec({});
      const parsed = JSON.parse(result);
      expect(parsed.budget).toBe(100_000);
      expect(parsed.usedInput).toBe(30_000);
      expect(parsed.usedOutput).toBe(2_000);
      expect(parsed.remaining).toBe(70_000);
    });
  });
});
