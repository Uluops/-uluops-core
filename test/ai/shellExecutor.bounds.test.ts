import { describe, it, expect } from 'vitest';
import { executeShellAsOpenAIResult } from '../../src/ai/shellExecutor.js';

/**
 * Model tool arguments are EXTERNAL INPUT and must be bounded on BOTH sides.
 *
 * POSITIVE CONTROL: restore `Math.min(action.timeoutMs ?? defaultTimeoutMs, defaultTimeoutMs)`
 * and the first test fails — the 3-second command runs to completion under a 500 ms
 * ceiling and reports a clean exit. Confirmed by execution before the fix:
 *
 *   control (model omits): elapsed 2004 ms, killed  — ceiling 2000 ms held
 *   model sends 0        : elapsed 5011 ms, NOT killed, outcome {type:'exit',exitCode:0}
 *
 * `Math.min(0 ?? d, d)` is `0`, and Node's child_process treats a timeout of 0 as NO
 * TIMEOUT. So the file's own comment — "the model can only LOWER the timeout ... never
 * raise it" — was false at the smallest legal value, and the bash tool this guards grants
 * full host OS access. A ceiling with no floor is not a clamp.
 */
describe('shellExecutor — model-supplied bounds are clamped on both sides', () => {
  const CEILING = 500;
  const run = (action: Record<string, unknown>) =>
    executeShellAsOpenAIResult(
      { commands: ['sleep 3; echo finished'], ...action } as never,
      '/tmp', CEILING,
    );

  it('a model-supplied timeoutMs of 0 cannot disable the operator ceiling', async () => {
    const t0 = Date.now();
    const res = await run({ timeoutMs: 0 });
    const elapsed = Date.now() - t0;

    expect(res.output[0]!.outcome).toEqual({ type: 'timeout' });
    expect(elapsed).toBeLessThan(2_000);
    // The specific lie this prevents: an unbounded run reporting a clean exit.
    expect(res.output[0]!.outcome).not.toMatchObject({ type: 'exit', exitCode: 0 });
  }, 20_000);

  it.each([[-1], [Number.NaN]])(
    'a nonsensical timeoutMs (%s) is BOUNDED, not an error', async (bad) => {
      // These previously reached execFile and threw ERR_OUT_OF_RANGE, which the catch
      // reported as exitCode 1 — a configuration fault presented as a command failure.
      //
      // Renamed 2026-08-24. This said "falls back to the operator default", and the two
      // parameters take DIFFERENT branches — `-1` clamps to the 1 ms floor, `NaN` falls
      // back to the operator default — while the assertion (`{ type: 'timeout' }`) is
      // satisfied by both. The test could not discover the difference it was named for,
      // which is the instrument-that-cannot-fail pattern this suite exists to prevent,
      // sitting inside the suite. The name now states what is actually asserted: bounded.
      // The branch split itself is pinned as measured fact in test/utils/externalValue.test.ts.
      const res = await run({ timeoutMs: bad });
      expect(res.output[0]!.outcome).toEqual({ type: 'timeout' });
    }, 20_000);

  it('a model CAN still lower the bound — the negative control', async () => {
    // Without this, "clamps to the ceiling" would pass for a clamp that ignored the model
    // entirely, removing a capability the operator deliberately granted.
    const t0 = Date.now();
    const res = await executeShellAsOpenAIResult(
      { commands: ['sleep 3'], timeoutMs: 200 } as never, '/tmp', 10_000,
    );
    expect(res.output[0]!.outcome).toEqual({ type: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 20_000);

  it('marks truncated output instead of discarding it silently', async () => {
    // The Anthropic twin has appended a truncation marker since it was written; this
    // adapter substringed silently, so the model could not tell "no output" from "output
    // discarded". Verified before the fix: maxOutputLength 0 yielded stdout '' with exit 0.
    const res = await executeShellAsOpenAIResult(
      { commands: ['echo abcdefghijklmnop'], maxOutputLength: 4 } as never, '/tmp', 5_000,
    );
    expect(res.output[0]!.stdout).toContain('truncated');
    expect(res.output[0]!.stdout).not.toBe('');
  }, 20_000);
});

/**
 * A process that was SIGKILLed is not a process that timed out.
 *
 * POSITIVE CONTROL: revert the classification to `if (err.killed || err.signal)` and the
 * first test fails — a SIGKILL is reported to the model as a timeout.
 *
 * Node's own error shapes, measured:
 *   real timeout   { killed: true,  signal: 'SIGTERM' }
 *   external kill  { killed: false, signal: 'SIGKILL' }   <- swept up by `|| err.signal`
 *   maxBuffer      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }  (a STRING code)
 *
 * The old guard turned the second into "Command timed out after Nms" — a duration nobody
 * measured, for an event that did not occur, handed to a model that will rationally respond
 * by asking for a longer timeout, which cannot help. Node distinguishes these; the code was
 * discarding the distinction.
 */
describe('shellExecutor — termination modes are not conflated', () => {
  it('reports an externally-killed process as a signal, not a timeout', async () => {
    const res = await executeShellAsOpenAIResult(
      { commands: ["sh -c 'kill -9 $$'"] } as never, '/tmp', 10_000,
    );
    // The measured defect: outcome {type:'timeout'} for a process nothing timed out.
    expect(res.output[0]!.outcome).not.toEqual({ type: 'timeout' });
    // This assertion was PLATFORM-COUPLED until 2026-08-25 and nobody could see it locally.
    // It reads the explanation that `err.stderr || '<explanation>'` produced — which fires
    // only when the shell is silent. macOS is silent on `kill -9`; Linux writes `Killed\n`,
    // so on Linux the explanation was discarded and stderr read just "Killed". Green on one
    // developer machine, red on all three CI Node versions, and the first thing CI ever
    // caught on this branch. The fix made the explanation additive rather than a fallback
    // (see `explain` in shellExecutor.ts), so this now holds on both.
    expect(String(res.output[0]!.stderr)).toMatch(/signal/i);
  }, 20_000);

  it('still reports a REAL timeout as a timeout — the negative control', async () => {
    // Without this, "not a timeout" would pass for a classifier that never reports
    // timeouts at all, hiding the condition the ceiling exists to enforce.
    const res = await executeShellAsOpenAIResult(
      { commands: ['sleep 5'] } as never, '/tmp', 300,
    );
    expect(res.output[0]!.outcome).toEqual({ type: 'timeout' });
  }, 20_000);

  it('does not fabricate an exit code when output exceeds the buffer', async () => {
    // maxBuffer overflow yields a STRING error code, so `typeof err.code === 'number'`
    // was false and the code invented `exitCode: 1` for a command whose real exit status
    // was never observed — while discarding all its output with no marker.
    const res = await executeShellAsOpenAIResult(
      { commands: ["head -c 2000000 /dev/zero | tr '\\0' 'a'"] } as never, '/tmp', 15_000,
    );
    const first = res.output[0]!;
    if (first.outcome.type === 'exit' && first.outcome.exitCode === 1) {
      // If it reports a failure, it must SAY the status was unobserved rather than
      // presenting 1 as the command's own exit code.
      expect(String(first.stderr)).toMatch(/buffer|not observed|exceeded/i);
    }
  }, 30_000);

  it('reports a normal non-zero exit unchanged', async () => {
    const res = await executeShellAsOpenAIResult(
      { commands: ['exit 3'] } as never, '/tmp', 5_000,
    );
    expect(res.output[0]!.outcome).toEqual({ type: 'exit', exitCode: 3 });
  }, 20_000);
});
