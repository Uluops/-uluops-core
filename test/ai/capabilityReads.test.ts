/**
 * Field access, not names (thinking-capability-restore spec §10 level 2).
 *
 * Every read of the thinking CAPABILITY in src goes through `canThink` (src/ai/thinking.ts). Before
 * 0.51.0 five sites read `resolved.capabilities.extendedThinking` directly — four provider gates and
 * the temperature strip — and every one silently read `undefined` because the SDK stripped the wire
 * name. One read site means one place for the next rename to land.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../src/', import.meta.url).pathname;
const CAPABILITY_READ = /capabilities\s*\??\.\s*(?:extendedThinking|reasoning)\b|capabilities\s*(?:as\s+[^)]+\))?\s*\)?\s*\[\s*['"](?:extendedThinking|reasoning)['"]\s*\]|\bcaps\s*\.\s*(?:extendedThinking|reasoning)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('capability reads go through canThink', () => {
  it('control: the pattern catches the 0.50.0 gate shapes it guards against', () => {
    for (const line of [
      'if (resolved.capabilities.extendedThinking && !(\'thinking\' in anthropicOpts)) {',
      "|| ('reasoning' in resolved.capabilities && (resolved.capabilities as Record<string, unknown>)['reasoning'] === true)",
      'const can = model.capabilities?.reasoning;',
    ]) expect(CAPABILITY_READ.test(line), line).toBe(true);
  });

  it('no src file outside thinking.ts reads the capability directly', () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(20);
    const offenders = all
      .filter(f => !f.endsWith('/ai/thinking.ts'))
      .flatMap(f => readFileSync(f, 'utf8').split('\n')
        .map((line, i) => ({ f: f.slice(SRC.length), n: i + 1, line }))
        .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && CAPABILITY_READ.test(line)));
    expect(offenders).toEqual([]);
  });

  it('thinking.ts itself does read it (the pattern can see a real read site)', () => {
    expect(CAPABILITY_READ.test(readFileSync(join(SRC, 'ai/thinking.ts'), 'utf8'))).toBe(true);
  });
});
