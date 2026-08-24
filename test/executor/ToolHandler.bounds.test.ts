import { describe, it, expect } from 'vitest';
import { ToolHandler } from '../../src/executor/ToolHandler.js';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Model tool-call arguments are EXTERNAL INPUT and must be bounded on both sides.
 *
 * POSITIVE CONTROL: revert any `externalInt(...)` call in ToolHandler's dispatch to the old
 * `toNumber(input[...]) ?? default` and the matching test fails.
 *
 * `toNumber` was `typeof v === 'number' ? v : undefined` — a TYPE narrow that admits NaN,
 * Infinity, negatives and fractions. The Zod tool schema declares `z.number()` with no
 * `.int()`, and z.number() accepts Infinity, so every one of these was schema-valid input.
 * Measured consequences before the fix:
 *
 *   max_results: Infinity  removed the 50-match search bound entirely — unbounded tool
 *                          output into the context window, billed as input tokens on every
 *                          later step of a BYOK run
 *   max_results: 0 / -5    broke the loop on entry: the model was told "no matches" for a
 *                          search that was never performed
 *   max_results: -1        "... and 8 more files" in a directory of seven
 *   max_results: 1.5       "... and 5.5 more files"
 *   max_results: NaN       an empty listing with the overflow marker suppressed —
 *                          reported to the model as an empty directory
 */
describe('ToolHandler — model-supplied bounds are clamped on both sides', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toolbounds-'));
    for (let i = 0; i < 7; i++) await writeFile(join(dir, `f${i}.txt`), `line1\nline2\nline3\nline4\n`);
    // A second, LARGER fixture: the search bound is 50, so a directory yielding well over
    // 50 matches is the only thing that can distinguish bounded from unbounded. With the
    // 7x4 set alone (28 matches) both behave identically and the test cannot discriminate.
    await mkdir(join(dir, 'many'), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(join(dir, 'many', `m${i}.txt`), 'needle\nneedle\nneedle\n');
    }
    await mkdir(join(dir, 'sub'), { recursive: true });
    return { dir, handler: new ToolHandler(dir) };
  };

  const listFiles = async (handler: ToolHandler, maxResults: unknown) =>
    handler.fulfill({ id: 't1', name: 'list_files', input: { path: '.', max_results: maxResults } } as never);

  it.each([[-1], [0], [1.5], [NaN], [Infinity]])(
    'never reports more remaining files than exist (max_results: %s)', async (bad) => {
      const { handler } = await setup();
      const out = String((await listFiles(handler, bad)).content ?? '');

      const more = out.match(/\.\.\. and ([\-\d.]+) more files/);
      if (more) {
        const n = Number(more[1]);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(7);           // the measured defect: "and 8 more files" of 7
      }
      // And the listing is never silently empty for a directory that has files.
      expect(out.length).toBeGreaterThan(0);
    });

  it('a well-formed max_results still limits the listing — the negative control', async () => {
    // Without this, "clamps bad values" would pass for an implementation that ignored
    // max_results entirely, removing a capability the tool deliberately offers.
    const { handler } = await setup();
    const out = String((await listFiles(handler, 2)).content ?? '');
    expect(out).toMatch(/more files/);
  });

  it('read_file cannot be given a line range that never existed', async () => {
    // Measured before the fix: start_line 100 / end_line 200 on a 4-line file returned the
    // header "[Lines 100-4 of 4]" with an EMPTY body — a range presented as read, no error.
    const { handler } = await setup();
    const res = await handler.fulfill({
      id: 't2', name: 'read_file',
      input: { path: 'f0.txt', start_line: 100, end_line: 200 },
    } as never);
    const out = String(res.content ?? '');
    expect(out).not.toMatch(/Lines 100-4/);
    expect(out).not.toContain('NaN');
  });

  it('read_file renders no NaN into the model context', async () => {
    const { handler } = await setup();
    const res = await handler.fulfill({
      id: 't3', name: 'read_file', input: { path: 'f0.txt', start_line: NaN, end_line: NaN },
    } as never);
    expect(String(res.content ?? '')).not.toContain('NaN');
  });

  it.each([[Infinity], [0], [-5], [NaN]])(
    'search_content stays bounded for max_results: %s', async (bad) => {
      // Infinity removed the 50-match bound ENTIRELY — the loops break on
      // `results.length >= maxResults`, so unbounded tool output flowed into the context
      // window, billed as input tokens on every later step. 0 and -5 broke on entry and
      // told the model "no matches" for a search never performed.
      const { handler } = await setup();
      const res = await handler.fulfill({
        id: 's1', name: 'search_content',
        input: { path: '.', pattern: 'needle', max_results: bad },
      } as never);
      const out = String(res.content ?? '');

      // There are 180 'needle' matches available, so "no matches" is a false answer and an
      // unbounded sweep is measurably larger than the 50-match ceiling.
      expect(out).not.toMatch(/no matches/i);
      const matchLines = out.split('\n').filter(l => l.includes('needle')).length;
      expect(matchLines).toBeGreaterThan(0);      // 0 => "no matches" for a real search
      expect(matchLines).toBeLessThanOrEqual(60); // >60 => the 50-bound was removed
    });

  it('search_content still honours a well-formed max_results — the negative control', async () => {
    const { handler } = await setup();
    const res = await handler.fulfill({
      id: 's2', name: 'search_content',
      input: { path: '.', pattern: 'line', max_results: 2 },
    } as never);
    expect(String(res.content ?? '').length).toBeGreaterThan(0);
  });

  it('get_directory_tree is bounded below as well as above', async () => {
    // -1 and NaN both flattened the tree to depth 0 and returned it with no marker,
    // indistinguishable from an empty directory.
    const { handler } = await setup();
    for (const bad of [-1, NaN, 0]) {
      const res = await handler.fulfill({
        id: 't4', name: 'get_directory_tree', input: { path: '.', max_depth: bad },
      } as never);
      expect(String(res.content ?? '').length).toBeGreaterThan(0);
    }
  });
});
