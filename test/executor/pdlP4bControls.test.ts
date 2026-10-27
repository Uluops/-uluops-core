/**
 * PDL 1.6.0 P4b negative controls. Each runs one conformance case end to end (pdlConformanceHarness)
 * and asserts only through fields that existed before P4b (stage `status` and `skipReason`, agents
 * launched, the run `decision`, the saved verdict SubmissionClient writes, the timeout an agent was
 * given), so the file runs unchanged against the pre-P4b core and fails there. Recorded against
 * 602b34f (core feat/pdl-1.6.0-p3a, P4a head): every test below fails on it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FIX, cases, runCase } from './pdlConformanceHarness.js';

const mockSave = vi.fn();
vi.mock('@uluops/ops-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uluops/ops-sdk')>();
  return { ...actual, OpsClient: vi.fn(() => ({ runs: { save: mockSave, validate: vi.fn(), listByProject: vi.fn(), get: vi.fn() } })) };
});

let root = '';
let targets: Record<string, string> = {};
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pdl-p4b-controls-'));
  cpSync(path.join(FIX, 'targets'), path.join(root, 'targets'), { recursive: true, verbatimSymlinks: true });
  const rel = (p: string) => path.relative(process.cwd(), path.join(root, 'targets', p));
  targets = { dir: rel('project'), file: rel('project/docs/design-spec.md'), symlink: rel('linked-spec.md') };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (id: string) => runCase(cases.find(c => c.id === id)!, targets, mockSave);
const stage = (r: Awaited<ReturnType<typeof run>>, id: string) => r.result.stages.find(s => s.id === id)!;

describe('PDL 1.6.0 P4b negative controls', () => {
  it('a warn-gated negative saves allGatesPassed true and the run PASSes (D13; was false / FAIL)', async () => {
    const r = await run('gates/warn-negative-default-ignore');
    expect(r.written.summary.allGatesPassed).toBe(true);
    expect(r.result.decision).toBe('PASS');
  });

  it('an accepted CONDITIONAL saves allGatesPassed false (gate-decision D2; was true)', async () => {
    const r = await run('gates/conditional-at-default-gate');
    expect(r.written.summary.allGatesPassed).toBe(false);
  });

  it('run-control/abort-skips-only-dependents launches `independent` (D1; was skipped)', async () => {
    const r = await run('run-control/abort-skips-only-dependents');
    expect(r.launches.map(l => l.agent)).toContain('stub-gate-c');
    expect(stage(r, 'independent').status).toBe('completed');
    expect(stage(r, 'synthesis').status).toBe('skipped');
  });

  it('a stage in flight at a stop does not record `completed` (§6 item 9; was completed)', async () => {
    const r = await run('run-control/cancel-with-two-agents-in-flight');
    expect(stage(r, 'review').status).not.toBe('completed');
  });

  it('on_failure: skip is fail: the dependent stage runs (§6 item 16; was skipped)', async () => {
    const r = await run('gates/skip-is-fail');
    expect(stage(r, 'b').status).toBe('completed');
  });

  it('a stage whose every agent is skipped by condition is skipped, and its dependent runs (D10; was a failed abort gate)', async () => {
    const r = await run('gates/all-agents-skipped');
    expect(stage(r, 'checks').status).toBe('skipped');
    expect(stage(r, 'after').status).toBe('completed');
  });

  it('an ERRORED stage behind warn makes the run WARN (D19; was FAIL)', async () => {
    const r = await run('gates/errored-behind-warn');
    expect(r.result.decision).toBe('WARN');
  });

  it('agentRef.timeout reaches the agent (was ignored: the run timeout applied)', async () => {
    const r = await run('gates/errored-by-timeout');
    expect(r.launches.find(l => l.agent === 'stub-gate-a')?.timeoutMs).toBe(1000);
  }, 5_000);
});
