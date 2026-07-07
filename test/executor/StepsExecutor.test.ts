import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StepsExecutor, substituteStepTemplates } from '../../src/executor/StepsExecutor.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeTarget(): string {
  return mkdtempSync(path.join(tmpdir(), 'steps-exec-'));
}

describe('substituteStepTemplates', () => {
  const input = { target: '/tmp/my target' };

  it('substitutes params.target from input.target with shell quoting', () => {
    const out = substituteStepTemplates('[ -e {{ params.target }} ] && echo DETECTED', input);
    expect(out).toEqual({ command: "[ -e '/tmp/my target' ] && echo DETECTED" });
  });

  it('substitutes named params', () => {
    const out = substituteStepTemplates('echo {{ params.mode }}', { ...input, params: { mode: 'deep' } });
    expect(out).toEqual({ command: "echo 'deep'" });
  });

  it('uses the fallback when the param is absent', () => {
    const out = substituteStepTemplates("npm run build --prefix {{ params.dir || '.' }}", input);
    expect(out).toEqual({ command: "npm run build --prefix '.'" });
  });

  it('prefers the param over the fallback', () => {
    const out = substituteStepTemplates("echo {{ params.mode || 'default' }}", { ...input, params: { mode: 'x' } });
    expect(out).toEqual({ command: "echo 'x'" });
  });

  it('shell-quotes values containing quote metacharacters', () => {
    const out = substituteStepTemplates('echo {{ params.v }}', { ...input, params: { v: "a'; rm -rf /" } });
    expect(out).toEqual({ command: "echo 'a'\\''; rm -rf /'" });
  });

  it('reports unresolved params instead of substituting empty', () => {
    const out = substituteStepTemplates('echo {{ params.missing }}', input);
    expect(out).toHaveProperty('unresolved');
  });

  it('reports unsupported leftover template syntax', () => {
    const out = substituteStepTemplates('echo {{ stages.preflight.score }}', input);
    expect(out).toHaveProperty('unresolved');
  });
});

describe('StepsExecutor', () => {
  const executor = new StepsExecutor(noopLogger);

  it('runs a passing detection step and captures output', async () => {
    const target = makeTarget();
    writeFileSync(path.join(target, 'tsconfig.json'), '{}');
    const results = await executor.execute(
      [{ name: 'Detect TypeScript', command: 'test -f tsconfig.json && echo "DETECTED" || echo "NOT_DETECTED"' }],
      { target },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.output).toBe('DETECTED');
    expect(results[0]!.exitCode).toBe(0);
  });

  it('fails a step on non-zero exit and records stderr', async () => {
    const results = await executor.execute(
      [{ name: 'Fail', command: 'echo boom >&2; exit 3' }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.exitCode).toBe(3);
    expect(results[0]!.error).toContain('boom');
  });

  it('skips subsequent steps after a hard failure, except always_run', async () => {
    const results = await executor.execute(
      [
        { name: 'first', command: 'exit 1' },
        { name: 'second', command: 'echo never' },
        { name: 'cleanup', command: 'echo cleaned', always_run: true },
      ],
      { target: makeTarget() },
    );
    expect(results.map(r => r.status)).toEqual(['failed', 'skipped', 'passed']);
    expect(results[2]!.output).toBe('cleaned');
  });

  it('continues past a failure marked continue_on_error', async () => {
    const results = await executor.execute(
      [
        { name: 'soft-fail', command: 'exit 1', continue_on_error: true },
        { name: 'next', command: 'echo ran' },
      ],
      { target: makeTarget() },
    );
    expect(results.map(r => r.status)).toEqual(['failed', 'passed']);
  });

  it('enforces expect_match against captured output', async () => {
    const results = await executor.execute(
      [{ name: 'match', command: 'echo NOT_DETECTED', expect_match: '^DETECTED$' }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('did not match');
  });

  it('fails the single step on an invalid expect_match regex instead of throwing', async () => {
    const results = await executor.execute(
      [
        { name: 'bad-regex', command: 'echo out', expect_match: '(' },
        { name: 'cleanup', command: 'echo ok', always_run: true },
      ],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('invalid expect_match regex');
    // Later always_run step still executes — the stage contract survives.
    expect(results[1]!.status).toBe('passed');
  });

  it('fails a step whose output exceeds the 1MB maxBuffer guard', async () => {
    const results = await executor.execute(
      [{ name: 'flood', command: 'head -c 2097152 /dev/zero | tr "\\0" "x"' }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
  });

  it('enforces expect_empty', async () => {
    const results = await executor.execute(
      [{ name: 'empty', command: 'echo dirty', expect_empty: true }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
  });

  it('scrubs secret-class env vars from the step environment', async () => {
    process.env['TEST_SCRUB_API_KEY'] = 'sk-secret';
    process.env['TEST_SCRUB_PLAIN'] = 'visible';
    try {
      const results = await executor.execute(
        [{ name: 'leak-probe', command: 'echo "key=[$TEST_SCRUB_API_KEY] plain=[$TEST_SCRUB_PLAIN]"' }],
        { target: makeTarget() },
      );
      expect(results[0]!.output).toBe('key=[] plain=[visible]');
    } finally {
      delete process.env['TEST_SCRUB_API_KEY'];
      delete process.env['TEST_SCRUB_PLAIN'];
    }
  });

  it('rejects step.env keys that override loader vectors or PATH', async () => {
    const results = await executor.execute(
      [
        { name: 'hijack', command: 'echo x', env: { LD_PRELOAD: '/tmp/evil.so' } },
        { name: 'path-hijack', command: 'echo x', env: { PATH: '/tmp/evil' }, always_run: true },
      ],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('not permitted');
    expect(results[1]!.status).toBe('failed');
    expect(results[1]!.error).toContain('not permitted');
  });

  it('caps retries so an unbounded retry count cannot hang the step', async () => {
    const target = makeTarget();
    // Each attempt appends a line; with retries far above the cap, attempts = 1 + MAX (11).
    const results = await executor.execute(
      [{ name: 'runaway', command: 'echo attempt >> attempts.log; exit 1', retries: 1_000_000 }],
      { target },
    );
    expect(results[0]!.status).toBe('failed');
    const { execSync } = await import('node:child_process');
    const attempts = execSync('wc -l < attempts.log', { cwd: target }).toString().trim();
    expect(Number(attempts)).toBe(11);
  });

  it('retries a flaky step until it passes', async () => {
    const target = makeTarget();
    // Passes only once the marker file exists; first attempt creates it.
    const results = await executor.execute(
      [{ name: 'flaky', command: 'test -f marker || { touch marker; exit 1; }', retries: 2 }],
      { target },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('substitutes {{ params.target }} in commands', async () => {
    const target = makeTarget();
    const results = await executor.execute(
      [{ name: 'check', command: '[ -d {{ params.target }} ] && echo DETECTED' }],
      { target },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.output).toBe('DETECTED');
  });

  it('fails a step with an unresolved template instead of running it', async () => {
    const results = await executor.execute(
      [{ name: 'unresolved', command: 'echo {{ params.nope }}' }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('Unresolved template');
  });

  it('runs in working_dir when contained within the target', async () => {
    const target = makeTarget();
    mkdirSync(path.join(target, 'sub'));
    writeFileSync(path.join(target, 'sub', 'here.txt'), 'x');
    const results = await executor.execute(
      [{ name: 'cwd', command: 'test -f here.txt && echo FOUND', working_dir: 'sub' }],
      { target },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.output).toBe('FOUND');
  });

  it('fails a step whose working_dir escapes the target root', async () => {
    const results = await executor.execute(
      [{ name: 'escape', command: 'echo pwned', working_dir: '../..' }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('escapes the target root');
  });

  it('applies per-step env', async () => {
    const results = await executor.execute(
      [{ name: 'env', command: 'echo "$STEP_MODE"', env: { STEP_MODE: 'deep-dive' } }],
      { target: makeTarget() },
    );
    expect(results[0]!.output).toBe('deep-dive');
  });

  it('times out a hung step', async () => {
    const results = await executor.execute(
      [{ name: 'hang', command: 'sleep 5', timeout: 200 }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('timed out');
  }, 10_000);

  it('truncates oversized output at 8KB', async () => {
    const results = await executor.execute(
      [{ name: 'big', command: 'head -c 20000 /dev/zero | tr "\\0" "x"' }],
      { target: makeTarget() },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.output.length).toBeLessThan(9000);
    expect(results[0]!.output).toContain('[truncated]');
  });
});
