/**
 * The agent shell does not inherit operator credentials.
 *
 * Model-issued commands ran with the full `process.env`: ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
 * ULUOPS_API_KEY and anything else the operator had exported, one `env` away from the model and
 * from there to the provider. PDL steps scrubbed exactly this class (StepsExecutor), and config.ts
 * calls steps "the same trust boundary as allowedTools bash"; the shell did not. Unreachable for
 * registry-resolved agents until 38ce9462 made the shell gate live, so it is fixed alongside.
 *
 * Real child processes, not the mocked `exec` of ShellExecutor.test.ts: the property under test
 * is what the child can see.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { executeShellAsString } from '../../src/ai/shellExecutor.js';

const SET = ['ULUOPS_TEST_SECRET_API_KEY', 'ULUOPS_TEST_GH_TOKEN', 'ANTHROPIC_TEST_PROBE', 'ULUOPS_TEST_PLAIN'];

afterEach(() => {
  for (const k of SET) delete process.env[k];
});

describe('agent shell environment', () => {
  it('secret-class variables are not visible to model-issued commands', async () => {
    process.env['ULUOPS_TEST_SECRET_API_KEY'] = 'sk-should-not-leak';
    process.env['ULUOPS_TEST_GH_TOKEN'] = 'ghp-should-not-leak';
    process.env['ANTHROPIC_TEST_PROBE'] = 'anthropic-should-not-leak';
    const out = await executeShellAsString(
      'printf "[%s][%s][%s]" "$ULUOPS_TEST_SECRET_API_KEY" "$ULUOPS_TEST_GH_TOKEN" "$ANTHROPIC_TEST_PROBE"',
      process.cwd(), 10_000,
    );
    expect(out).toBe('[][][]');
  });

  it('CONTROL — ordinary variables still pass through (PATH, a plain var)', async () => {
    process.env['ULUOPS_TEST_PLAIN'] = 'visible';
    const out = await executeShellAsString('printf "%s|%s" "$ULUOPS_TEST_PLAIN" "${PATH:+has-path}"', process.cwd(), 10_000);
    expect(out).toBe('visible|has-path');
  });
});
