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
    'a nonsensical timeoutMs (%s) falls back to the operator default, not an error', async (bad) => {
      // These previously reached execFile and threw ERR_OUT_OF_RANGE, which the catch
      // reported as exitCode 1 — a configuration fault presented as a command failure.
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
