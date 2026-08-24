import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StepsExecutor, substituteStepTemplates } from '../../src/executor/StepsExecutor.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const createdTargets: string[] = [];

function makeTarget(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'steps-exec-'));
  createdTargets.push(dir);
  return dir;
}

afterEach(() => {
  while (createdTargets.length > 0) {
    const dir = createdTargets.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  it('coerces a non-string param (number) via String()', () => {
    const out = substituteStepTemplates('echo {{ params.n }}', { ...input, params: { n: 42 } });
    expect(out).toEqual({ command: "echo '42'" });
  });

  it('does not treat a `false` param as absent (undefined-check must not swallow false)', () => {
    const out = substituteStepTemplates('echo {{ params.v }}', { ...input, params: { v: false } });
    expect(out).toEqual({ command: "echo 'false'" });
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

  it('waits retry_delay between attempts', async () => {
    const target = makeTarget();
    const started = Date.now();
    const results = await executor.execute(
      [{ name: 'flaky-delayed', command: 'test -f marker || { touch marker; exit 1; }', retries: 2, retry_delay: 50 }],
      { target },
    );
    const elapsed = Date.now() - started;
    expect(results[0]!.status).toBe('passed');
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('clamps an oversized retry_delay to MAX_RETRY_DELAY (CWE-400 guard)', async () => {
    // Capture the delay rather than wait it out. The clamp is 60s, so a real
    // wait costs a minute per suite run and three across the CI node matrix.
    // Spying proves the clamp fired at the same production code path, instantly,
    // and needs no injectable-timer refactor of StepsExecutor.
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        // Collapse ONLY the clamped retry backoff. execFile arms its own timeout
        // via setTimeout; shortening that would kill the child process instead.
        return realSetTimeout(fn, ms === 60_000 ? 0 : ms);
      }) as unknown as typeof globalThis.setTimeout);

    try {
      const results = await executor.execute(
        [{ name: 'runaway-delay', command: 'exit 1', retries: 1, retry_delay: 999_999_999 }],
        { target: makeTarget() },
      );
      expect(results[0]!.status).toBe('failed');
      expect(delays).toContain(60_000);            // MAX_RETRY_DELAY
      expect(delays).not.toContain(999_999_999);   // the unclamped request
    } finally {
      spy.mockRestore();
    }
  }, 20_000);

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

/**
 * Authored definition values are EXTERNAL INPUT — YAML that RegistryClient type-erases
 * with `as Record<string, unknown>` and no runtime schema. `.nan` and `.inf` are directly
 * authorable in YAML.
 *
 * POSITIVE CONTROL: revert `clampModelBound(step.timeout, …)` to `step.timeout ?? …`, or
 * `externalInt(step.retries, …)` to `Math.min(MAX_STEP_RETRIES, Math.max(0, step.retries ?? 0))`,
 * and the matching test fails.
 *
 * `timeout` was the odd one out: its two siblings on the NEXT TWO LINES were already
 * clamped and it was not. Measured: `execFile` with `timeout: 0` RESOLVED after a full 2 s
 * sleep — no timeout at all. A steps stage runs host shell commands, so this is the
 * operator's only liveness control over it.
 *
 * `retries: .nan` was sharper still: `maxAttempts` became NaN, `attempt <= NaN` was false,
 * the loop body NEVER EXECUTED, the command never ran — and `return lastResult!` pushed
 * `undefined` through a non-null assertion into `stepResults[]`, where PipelineExecutor
 * then read `.status` off it.
 */
describe('StepsExecutor — authored bounds cannot disable the guards', () => {
  const executor = new StepsExecutor(noopLogger);
  const run = (step: Record<string, unknown>) =>
    executor.execute([step] as never, { target: makeTarget() });

  it('a step that sets timeout: 0 is still bounded by the operator default', async () => {
    const started = Date.now();
    const results = await run({ name: 'slow', command: 'sleep 4', timeout: 0 });

    // Must not have run to completion unbounded.
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(results).toHaveLength(1);
  }, 20_000);

  it.each([['.nan-equivalent', NaN], ['infinite', Infinity], ['negative', -3]])(
    'a %s retries value still runs the command exactly once', async (_label, bad) => {
      // The defect: the loop never executed, so the command never ran AND the function
      // returned undefined. A result must always come back, and it must be a real one.
      const results = await run({ name: 'echo', command: 'echo ok', retries: bad });

      expect(results).toHaveLength(1);
      // Assert the command ACTUALLY RAN, not merely that a result object came back.
      // Checking only for a defined status passed with the guard removed, because the
      // `?? fail(...)` fallback also produces a well-formed result — the assertion could
      // not tell "ran and succeeded" from "never ran and was papered over".
      expect(results[0]!.status).toBe('passed');
      expect(results[0]!.output).toBe('ok');
      expect(results[0]!.exitCode).toBe(0);
    }, 20_000);

  it('a well-formed retries value is still honoured — the negative control', async () => {
    // Without this, "clamps bad retries" would pass for an implementation that ignored
    // retries entirely, silently removing the retry feature.
    const results = await run({ name: 'fail', command: 'exit 7', retries: 2 });
    expect(results[0]!.status).toBe('failed');
  }, 20_000);
});
