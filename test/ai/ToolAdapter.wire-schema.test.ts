import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { asSchema } from 'ai';
import { ToolAdapter } from '../../src/ai/ToolAdapter.js';
import { ToolHandler } from '../../src/executor/ToolHandler.js';

/**
 * The JSON Schema the AI SDK sends providers for ToolAdapter's tools carries no numeric
 * bounds, and integer parameters stay `type: integer` — exactly as on 0.51.x (zod 3).
 *
 * zod 4's `.int()` renders `minimum`/`maximum` of +/-(2^53 - 1); `toolInteger()` in
 * ToolAdapter.ts keeps them off the wire (see its comment for why). Converted through
 * `asSchema`, the same path the SDK uses to build the request.
 */
const BOUND_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];

function boundsIn(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  const n = node as Record<string, unknown>;
  return [
    ...BOUND_KEYS.filter((k) => k in n),
    ...Object.values(n).flatMap(boundsIn),
  ];
}

describe('ToolAdapter wire schema', () => {
  let tmpDir: string;
  let tools: ReturnType<ToolAdapter['getTools']>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tooladapter-wire-'));
    tools = new ToolAdapter(new ToolHandler(tmpDir)).getTools();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const wire = (name: string) =>
    asSchema((tools[name] as { inputSchema: unknown }).inputSchema as never).jsonSchema as {
      properties: Record<string, Record<string, unknown>>;
    };

  it('no tool sends numeric bounds', async () => {
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect({ name, bounds: boundsIn(wire(name)) }).toEqual({ name, bounds: [] });
  });

  it.each([
    ['read_file', 'start_line'],
    ['read_file', 'end_line'],
    ['list_files', 'max_results'],
    ['search_content', 'context_lines'],
    ['get_directory_tree', 'max_depth'],
  ])('%s.%s is sent as a plain integer', (name, prop) => {
    expect(wire(name).properties[prop]?.type).toBe('integer');
  });

  it('integer parameters still validate as integers, as on zod 3', () => {
    const schema = (tools.read_file as { inputSchema: z.ZodType }).inputSchema;
    expect(schema.safeParse({ path: 'a', start_line: 3 }).success).toBe(true);
    expect(schema.safeParse({ path: 'a', start_line: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ path: 'a', start_line: '3' }).success).toBe(false);
    expect(schema.safeParse({ path: 'a' }).success).toBe(true);
  });

  it('control: the detector sees the bounds zod 4 .int() emits', () => {
    const bare = asSchema(z.object({ n: z.number().int() }) as never).jsonSchema;
    expect(boundsIn(bare)).toEqual(['minimum', 'maximum']);
  });
});
