import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Spy on `glob` while preserving real behaviour, so we can assert on the
// `ignore` option passed by list_files vs. search_content — regression guard
// for tracker 9c91f817 (the ignore array used to be two independent literals).
const globSpy = vi.fn();
vi.mock('glob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('glob')>();
  return {
    ...actual,
    glob: (...args: Parameters<typeof actual.glob>) => {
      globSpy(...args);
      return actual.glob(...args);
    },
  };
});

const { ToolHandler } = await import('../../src/executor/ToolHandler.js');
type ToolUseBlock = import('../../src/types/tools.js').ToolUseBlock;

function makeToolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { id: 't1', name, input };
}

describe('ToolHandler glob ignore pattern sharing', () => {
  let tmpDir: string;
  let handler: InstanceType<typeof ToolHandler>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolhandler-glob-'));
    handler = new ToolHandler(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export const a = 1;\n');
    globSpy.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('list_files and search_content pass the identical ignore array reference to glob()', async () => {
    await handler.fulfill(makeToolUse('list_files', { path: '.' }));
    await handler.fulfill(makeToolUse('search_content', { pattern: 'a', path: '.' }));

    expect(globSpy).toHaveBeenCalledTimes(2);
    const listIgnore = globSpy.mock.calls[0]![1].ignore;
    const searchIgnore = globSpy.mock.calls[1]![1].ignore;
    expect(listIgnore).toBeDefined();
    expect(searchIgnore).toBe(listIgnore); // same reference — single source of truth
  });
});
