import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `mergeAbortSignals` claims every request carries a timeout. That claim is only as strong
 * as the number of places `generateText` is invoked.
 *
 * The comment there originally read "there is no reachable path that installs none" — an
 * unconditional reachability claim with nothing discharging it. A ship-gate review flagged
 * it as true of the paths someone thought to check while asserting more, and it was right:
 * the defect it replaced (a truthiness test dropping `timeoutMs: 0`) was invisible for
 * exactly that reason — everyone believed the bound was installed.
 *
 * The claim is now scoped to "one call site in this package", and this test is what
 * discharges it. A second call site fails here until someone routes it through
 * `mergeAbortSignals` or narrows the claim again.
 */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('the timeout claim is discharged by call-site count, not by assertion', () => {
  it('generateText is invoked from exactly one site in src/', () => {
    const sites: string[] = [];
    for (const file of tsFiles(join(process.cwd(), 'src'))) {
      // Strip comments before matching. This package DISCUSSES generateText in prose in
      // several places, and a check that counted those would be measuring the
      // documentation rather than the code — the first draft of this test did exactly
      // that, reporting 2 sites when the second was a `/** ... generateText() ... */`
      // JSDoc line. Block comments are removed whole rather than line-by-line, because a
      // per-line strip cannot see that a line is INSIDE one.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))  // keep line numbering
        .replace(/\/\/[^\n]*/g, '');
      code.split('\n').forEach((line, i) => {
        if (/\bgenerateText\s*\(/.test(line)) sites.push(`${file}:${i + 1}`);
      });
    }

    // The control that makes this meaningful: the search must find the real one.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain('AIProvider.ts');
  });
});
