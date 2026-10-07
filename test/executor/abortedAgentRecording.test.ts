/**
 * Aborted agents are NOT COMPLETED, not crashed (aborted-agent-recording spec v0.2.0).
 *
 * An agent stopped by a stop of its run — a user cancel(), a provider-credit trip, a caller
 * abortSignal — is recorded as decision ABORTED, neutral, null score, NO recommendation. Genuine
 * crashes and the 402 originator keep the critical crash placeholder. Containers apply
 * negative > aborted > conditional > positive.
 *
 * Test ids (T1..T17) are the spec's §9 rows. NC = how the test fails against 0.49.0; MC = the
 * mutation that makes a guard test fail (for tests that pass today by construction).
 */
import { describe, it, expect, vi } from 'vitest';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { ProviderCreditError, CancelledError, PipelineError, TimeoutError } from '../../src/errors/index.js';
import { tripRunFor } from '../../src/utils/runTrip.js';
import { isRunStopAbort } from '../../src/utils/runStop.js';
import { abortedPlaceholder, isAbortedRecord, ABORTED_DECISION, CRASH_PLACEHOLDER_VERSION } from '../../src/utils/crashPlaceholder.js';
import { ABORTED_DECISION as EXPORTED_ABORTED, isAbortedRecord as exportedIsAborted } from '../../src/index.js';
import type { ExecutionOptions } from '../../src/types/execution.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { PipelineDefinition } from '../../src/types/pipeline.js';
import type { WorkflowDefinition } from '../../src/types/workflow.js';
import type { CommandDefinition } from '../../src/types/command.js';
import type { AgentResult } from '../../src/types/agent.js';
import { makeAgentDef, makeCommandResult, makeRegistry, makeValidatorResult } from './fixtures.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const CREDIT = 'Out of credit with provider "openrouter" (HTTP 402). Provider message: can only afford 83666';

/** Rejects with CancelledError when its signal aborts; resolves after `ms` otherwise. */
function untilAborted(signal: AbortSignal | undefined, result: AgentResult, ms = 500): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(result), ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError('Execution was cancelled by the caller')); }, { once: true });
  });
}

type Behaviour = 'pass' | 'wait' | 'credit' | 'timeout-then-wait' | 'boom';
function agentExecutor(plan: Record<string, Behaviour>): AgentExecutor {
  return {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, _i: unknown, options?: ExecutionOptions) => {
      const signal = options?.abortSignal;
      const name = resolved.name;
      switch (plan[name]) {
        case 'pass': return makeValidatorResult({ name, score: 90, recommendations: [] });
        case 'credit':
          await new Promise(r => setTimeout(r, 20));
          tripRunFor(signal, CREDIT);
          throw new ProviderCreditError(CREDIT, 'openrouter');
        case 'timeout-then-wait': throw new TimeoutError(1000);
        case 'boom': throw new Error('boom');
        default: return untilAborted(signal, makeValidatorResult({ name }));
      }
    }),
  } as unknown as AgentExecutor;
}

function inlinePipeline(refs: string[]): ResolvedDefinition {
  return {
    type: 'pipeline', name: 'p', version: '1.0.0', hash: 'sha256:p', yaml: '', domain: 'software',
    runtime: {} as ResolvedDefinition['runtime'],
    definition: {
      pipeline: {
        interface: { name: 'p', version: '1.0.0', displayName: 'P', description: 'd', domain: 'software' },
        stages: [{ id: 'panel', name: 'Panel', type: 'agents', agents: refs.map(ref => ({ ref })) }],
      },
    } as unknown as PipelineDefinition,
  };
}

function pipelineExecutor(agentExec: AgentExecutor, names: string[]) {
  const registry = makeRegistry(Object.fromEntries(names.map(n => [n, makeAgentDef(n)])));
  const cmdExec = { execute: vi.fn() } as never;
  return new PipelineExecutor(new WorkflowExecutor(cmdExec, registry), cmdExec, agentExec, registry, noopLogger);
}

const settle = (p: Promise<unknown>) => p.then(r => ({ resolved: r as never, thrown: undefined }), (e: unknown) => ({ resolved: undefined, thrown: e as PipelineError & { context: { partialResult: never } } }));

// ─── §4 detection rule ──────────────────────────────────────────────────────────────────────────

describe('isRunStopAbort (§4 truth table)', () => {
  const aborted = () => { const c = new AbortController(); c.abort(); return c.signal; };
  const live = () => new AbortController().signal;

  it('CancelledError on an aborted run signal is a run-stop abort', () => {
    expect(isRunStopAbort(new CancelledError('x'), aborted())).toBe(true);
  });
  // T5 (unit form). MC: swap the code check for `instanceof CancelledError` → fails.
  it('a foreign-copy { code: CANCELLED } on an aborted signal is a run-stop abort', () => {
    expect(isRunStopAbort({ name: 'CancelledError', code: 'CANCELLED', message: 'x' }, aborted())).toBe(true);
  });
  // T4 (unit form). MC: drop the signal conjunct → fails.
  it('CancelledError while the run signal is live is a crash', () => {
    expect(isRunStopAbort(new CancelledError('x'), live())).toBe(false);
    expect(isRunStopAbort(new CancelledError('x'), undefined)).toBe(false);
  });
  // T3 (unit form). MC: signal-only predicate → fails.
  it('the 402 originator, a timeout, a plain error and a raw DOMException are crashes even in a stopped run', () => {
    const s = aborted();
    expect(isRunStopAbort(new ProviderCreditError(CREDIT, 'openrouter'), s)).toBe(false);
    expect(isRunStopAbort(new TimeoutError(1000), s)).toBe(false);
    expect(isRunStopAbort(new Error('boom'), s)).toBe(false);
    expect(isRunStopAbort(new DOMException('aborted', 'AbortError'), s)).toBe(false);
    expect(isRunStopAbort(null, s)).toBe(false);
  });
});

// ─── T17 factory pin ────────────────────────────────────────────────────────────────────────────

describe('abortedPlaceholder (T17)', () => {
  it('pins every field of §3.1', () => {
    const r = abortedPlaceholder('steady', new CancelledError('x'), { startedAt: Date.now() - 1500 });
    expect(r).toMatchObject({
      type: 'agent', name: 'steady', version: CRASH_PLACEHOLDER_VERSION, definitionHash: '', agentType: 'validator',
      decision: 'ABORTED', decisionCategory: 'neutral', score: null, maxScore: null, recommendations: [],
      degradationMarkers: [{ code: 'execution.run-stopped', phase: 'execution', severity: 'critical' }],
      completeness: 'failed',
    });
    expect(r.summary).toMatch(/^Not completed/);
    expect(r.metrics.costBasis).toBe('unpriced');
    expect('costUsd' in r.metrics).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(1400);
    expect(isAbortedRecord(r)).toBe(true);
  });

  it('a real definition using ABORTED as its own word is not an aborted record', () => {
    expect(isAbortedRecord({ decision: 'ABORTED', version: '1.2.0' })).toBe(false);
  });

  it('is exported from the package entry', () => {
    expect(EXPORTED_ABORTED).toBe(ABORTED_DECISION);
    expect(exportedIsAborted).toBe(isAbortedRecord);
  });
});

// ─── Inline-agents stage (S1) ───────────────────────────────────────────────────────────────────

describe('inline-agents stage', () => {
  // T1. NC: decisions FAIL and two critical "cancelled by the caller" recommendations.
  it('a user cancel records the in-flight agents ABORTED with no recommendation', async () => {
    const exec = pipelineExecutor(agentExecutor({ a: 'wait', b: 'wait' }), ['a', 'b']);
    const handle = await exec.start(inlinePipeline(['a', 'b']), { target: '/tmp' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    const result = await handle.wait();
    const agents = result.stages[0]!.agentResults!;
    expect(agents.length).toBe(2);
    expect(agents.map(a => a.decision)).toEqual(['ABORTED', 'ABORTED']);
    expect(agents.map(a => a.decisionCategory)).toEqual(['neutral', 'neutral']);
    expect(agents.map(a => a.score)).toEqual([null, null]);
    expect(result.recommendations.map(r => r.title)).toEqual([]);
    expect(result.decision).toBe('CANCELLED');
  });

  // T2. NC: two recommendations (the originator's and the sibling's crash).
  it('a credit trip leaves exactly one failing record — the 402 originator — and the stage FAILs', async () => {
    const exec = pipelineExecutor(agentExecutor({ pricey: 'credit', steady: 'wait' }), ['pricey', 'steady']);
    const handle = await exec.start(inlinePipeline(['pricey', 'steady']), { target: '/tmp' });
    const { thrown } = await settle(handle.wait());
    expect(thrown).toBeInstanceOf(PipelineError);
    const partial = thrown!.context.partialResult as { recommendations: Array<{ title: string }>; stages: Array<{ result: { decision: string }; agentResults: AgentResult[] }> };
    expect(partial.recommendations.length).toBe(1);
    expect(partial.recommendations[0]!.title).toContain('can only afford 83666');
    const byName = Object.fromEntries(partial.stages[0]!.agentResults.map(a => [a.name, a]));
    expect(byName['steady']!.decision).toBe('ABORTED');
    expect(byName['pricey']!.decision).toBe('FAIL');
    expect(partial.stages[0]!.result.decision).toBe('FAIL'); // negative beats aborted
  });

  // T3. MC: replace the predicate with `runSignal?.aborted` alone → the timeout reads ABORTED.
  it('an agent that timed out before the run was cancelled stays a crash', async () => {
    const exec = pipelineExecutor(agentExecutor({ slow: 'timeout-then-wait', b: 'wait' }), ['slow', 'b']);
    const handle = await exec.start(inlinePipeline(['slow', 'b']), { target: '/tmp' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    const result = await handle.wait();
    const byName = Object.fromEntries(result.stages[0]!.agentResults!.map(a => [a.name, a]));
    expect(byName['slow']!.decision).toBe('FAIL');
    expect(byName['slow']!.recommendations).toHaveLength(1);
    expect(byName['b']!.decision).toBe('ABORTED');
  });

  // T4. MC: drop the signal conjunct → ABORTED.
  it('a CancelledError while the run is NOT stopped is a crash', async () => {
    const agentExec = { execute: vi.fn().mockRejectedValue(new CancelledError('foreign')) } as unknown as AgentExecutor;
    const exec = pipelineExecutor(agentExec, ['x']);
    const result = await (await exec.start(inlinePipeline(['x']), { target: '/tmp' })).wait();
    expect(result.stages[0]!.agentResults![0]!.decision).toBe('FAIL');
  });

  // T5. MC: `instanceof CancelledError` instead of the code check → crash.
  it('a foreign-copy CancelledError shape is recognised by code', async () => {
    const agentExec = {
      execute: vi.fn().mockImplementation((_r: unknown, _i: unknown, o?: ExecutionOptions) => new Promise((_res, rej) => {
        o?.abortSignal?.addEventListener('abort', () => rej({ name: 'CancelledError', code: 'CANCELLED', message: 'x' }), { once: true });
      })),
    } as unknown as AgentExecutor;
    const exec = pipelineExecutor(agentExec, ['x']);
    const handle = await exec.start(inlinePipeline(['x']), { target: '/tmp' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    expect((await handle.wait()).stages[0]!.agentResults![0]!.decision).toBe('ABORTED');
  });

  // T16 + OD-7. NC: against 0.49.0 the caller signal left the run `running`, it ended `completed`,
  // and (without the computeDecision guard) a stage whose completed agent passed reported PASS.
  it('a consumer abortSignal stops the run: cancelled, CANCELLED, never PASS', async () => {
    const exec = pipelineExecutor(agentExecutor({ ok: 'pass', waits: 'wait' }), ['ok', 'waits']);
    const caller = new AbortController();
    const handle = await exec.start(inlinePipeline(['ok', 'waits']), { target: '/tmp' }, { abortSignal: caller.signal });
    await new Promise(r => setTimeout(r, 5));
    caller.abort();
    const result = await handle.wait();
    expect(result.status).toBe('cancelled');
    expect(result.decision).toBe('CANCELLED');
    const decisions = result.stages[0]!.agentResults!.map(a => a.decision).sort();
    expect(decisions).toEqual(['ABORTED', 'PASS']);
    expect(result.stages[0]!.result!.decision).toBe('ABORTED');
  });

  it('a consumer signal that is ALREADY aborted at start stops the run before any stage', async () => {
    const agentExec = agentExecutor({ ok: 'pass' });
    const exec = pipelineExecutor(agentExec, ['ok']);
    const caller = new AbortController();
    caller.abort();
    const result = await (await exec.start(inlinePipeline(['ok']), { target: '/tmp' }, { abortSignal: caller.signal })).wait();
    expect(result.status).toBe('cancelled');
    expect(result.stages[0]!.status).toBe('skipped');
    expect((agentExec.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ─── Multi-agent command (S2/S3) ────────────────────────────────────────────────────────────────

function commandDef(agents: string[], sequential: boolean): ResolvedDefinition {
  return {
    type: 'command', name: 'panel', version: '1.0.0', hash: 'sha256:cmd', yaml: '', domain: 'software',
    runtime: {} as ResolvedDefinition['runtime'],
    definition: {
      command: {
        interface: { name: 'panel', version: '1.0.0', displayName: 'Panel', description: 'd', domain: 'software' },
        agents,
        execution: { model: { default: 'sonnet' }, timeout: 30000, thresholds: { pass: 75, warn: 50 }, sequential },
      },
    } as CommandDefinition,
  };
}

/** Run a command with its own caller signal, aborting it after `afterMs`. */
async function runCommand(plan: Record<string, Behaviour>, agents: string[], sequential: boolean, afterMs = 5) {
  const agentExec = agentExecutor(plan);
  const exec = new CommandExecutor(agentExec, makeRegistry());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), afterMs);
  const outcome = await exec.execute(commandDef(agents, sequential), { target: '/tmp' }, { abortSignal: controller.signal })
    .then(r => ({ result: r, error: undefined }), (e: unknown) => ({ result: undefined, error: e as Error }));
  return { ...outcome, agentExec };
}

describe('multi-agent command', () => {
  // T6. NC: FAIL/negative with B's critical recommendation.
  it('parallel: A passes, B aborted → ABORTED/neutral, score from A, no recommendation from B', async () => {
    const { result } = await runCommand({ a: 'pass', b: 'wait' }, ['a@1', 'b@1'], false);
    expect(result).toMatchObject({ decision: 'ABORTED', decisionCategory: 'neutral', score: 90 });
    expect(result!.recommendations.map(r => r.title)).toEqual([]);
  });

  // T7. NC: FAIL.
  it('sequential: A completes, B aborted, C never dispatched', async () => {
    const { result, agentExec } = await runCommand({ a: 'pass', b: 'wait', c: 'pass' }, ['a@1', 'b@1', 'c@1'], true);
    expect(result).toMatchObject({ decision: 'ABORTED', decisionCategory: 'neutral', score: 90 });
    expect((agentExec.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  // T8. NC: throws ExecutionError("All agents failed …").
  it('all aborted → returns ABORTED, does not throw (OD-4)', async () => {
    const { result, error } = await runCommand({ a: 'wait', b: 'wait' }, ['a@1', 'b@1'], false);
    expect(error).toBeUndefined();
    expect(result!.decision).toBe('ABORTED');
  });

  // T9. NC: throws "All agents failed (2 of 2 dispatched crashed)".
  it('one crash + one aborted → FAIL with exactly the crash recommendation, no throw', async () => {
    const { result, error } = await runCommand({ a: 'boom', b: 'wait' }, ['a@1', 'b@1'], false);
    expect(error).toBeUndefined();
    // Both children are scoreless, so the scoreless branch decides: FAILED, negative.
    expect(result).toMatchObject({ decision: 'FAILED', decisionCategory: 'negative' });
    expect(result!.recommendations.map(r => r.title)).toEqual(['Agent a@1 failed: boom']);
  });

  it('control: every agent genuinely crashing still throws', async () => {
    const { error } = await runCommand({ a: 'boom', b: 'boom' }, ['a@1', 'b@1'], false, 1000);
    expect(error?.message).toMatch(/All agents failed \(2 of 2/);
  });
});

// ─── Workflow phase (S4/S5) ─────────────────────────────────────────────────────────────────────

function workflowDef(steps: string[], parallel: boolean): ResolvedDefinition {
  return {
    type: 'workflow', name: 'ship', version: '1.0.0', hash: 'sha256:wf', yaml: '', domain: 'software',
    runtime: {} as ResolvedDefinition['runtime'],
    definition: {
      workflow: {
        interface: { name: 'ship', version: '1.0.0', displayName: 'Ship', description: 'd', domain: 'software' },
        orchestration: {
          phases: [{ id: 'checks', name: 'Checks', commands: steps, parallel, gate: { threshold: 0, aggregate: 'average', on_fail: 'block' } }],
          on_failure: 'continue',
        },
        aggregation: { score: { method: 'average' }, decision: { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' } },
      },
    } as unknown as WorkflowDefinition,
  };
}

async function runWorkflow(plan: Record<string, 'pass' | 'wait' | 'boom'>, steps: string[], parallel = true) {
  const cmdExec = {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, _i: unknown, o?: { abortSignal?: AbortSignal }) => {
      const b = plan[resolved.name];
      if (b === 'pass') return makeCommandResult({ name: resolved.name, score: 90 });
      if (b === 'boom') throw new Error('boom');
      return new Promise((_res, rej) => o?.abortSignal?.addEventListener('abort', () => rej(new CancelledError('x')), { once: true }));
    }),
  } as unknown as CommandExecutor;
  const exec = new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  return exec.execute(workflowDef(steps, parallel), { target: '/tmp' }, { abortSignal: controller.signal });
}

describe('workflow phase', () => {
  // T10. NC: phase `blocked`, workflow `BLOCK`.
  it('A completes, B aborted → phase aborted, workflow ABORTED/neutral', async () => {
    const result = await runWorkflow({ a: 'pass', b: 'wait' }, ['a', 'b']);
    expect(result.phases[0]!.decision).toBe('aborted');
    expect(result.decision).toBe('ABORTED');
    expect(result.decisionCategory).toBe('neutral');
    expect(result.recommendations.map(r => r.title)).toEqual(['Issue 1']); // A's own, nothing from B
  });

  // T11. NC: throws WorkflowError("All steps in phase … failed") → blocked phase.
  it('all steps aborted → no throw, phase aborted', async () => {
    const result = await runWorkflow({ a: 'wait', b: 'wait' }, ['a', 'b']);
    expect(result.phases[0]!.decision).toBe('aborted');
    expect(result.phases[0]!.commands.map(c => c.decision)).toEqual(['ABORTED', 'ABORTED']);
  });

  it('sequential: an aborted step stops the phase and is recorded ABORTED', async () => {
    const result = await runWorkflow({ a: 'wait', b: 'pass' }, ['a', 'b'], false);
    expect(result.phases[0]!.commands.map(c => c.decision)).toEqual(['ABORTED']);
    expect(result.phases[0]!.decision).toBe('aborted');
  });

  // T12. MC: invert the precedence (aborted before the negative check) → phase aborted.
  it('a real crash + an aborted step → phase blocked, workflow BLOCK (negative beats aborted)', async () => {
    const result = await runWorkflow({ a: 'boom', b: 'wait' }, ['a', 'b']);
    expect(result.phases[0]!.decision).toBe('blocked');
    expect(result.decision).toBe('BLOCK');
  });
});

// ─── crew #110 fold (Alex's decisions 2026-10-05 + reviewer findings) ───────────────────────────

describe('fold: negative means categorical (Alex, crew #110 F1)', () => {
  // NC: against 911115f this is FAIL/negative — a threshold verdict over half a panel.
  it('sum aggregation: 90 + a stopped agent under a 150 threshold is ABORTED, not FAIL', async () => {
    const agentExec = agentExecutor({ a: 'pass', b: 'wait' });
    const exec = new CommandExecutor(agentExec, makeRegistry());
    const def = commandDef(['a@1', 'b@1'], false);
    const cmd = (def.definition as CommandDefinition).command as unknown as Record<string, unknown>;
    cmd['aggregation'] = { method: 'sum' };
    (cmd['execution'] as Record<string, unknown>)['thresholds'] = { pass: 150, warn: 100 };
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    const result = await exec.execute(def, { target: '/tmp' }, { abortSignal: c.signal });
    expect(result).toMatchObject({ decision: 'ABORTED', decisionCategory: 'neutral', score: 90 });
  });

  // Second re-check H1: a lens negative capped to WARN is a CONDITIONAL verdict, which aborted
  // outranks. NC: against 3381f4f the command kept WARN, which hid the stop from the phase above.
  it('a scored lens negative beside a stopped agent makes the command ABORTED, not WARN', async () => {
    const lens = makeValidatorResult({ name: 'lens', decision: 'DISORDERED', decisionCategory: 'negative', score: 82, recommendations: [] });
    const agentExec = {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition, _i: unknown, o?: ExecutionOptions) =>
        r.name === 'lens' ? lens : untilAborted(o?.abortSignal, makeValidatorResult())),
    } as unknown as AgentExecutor;
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    const result = await new CommandExecutor(agentExec, makeRegistry())
      .execute(commandDef(['lens@1', 'b@1'], false), { target: '/tmp' }, { abortSignal: c.signal });
    expect(result.decision).toBe('ABORTED');
  });
});

describe('fold: workflow phase precedence matches the command rule', () => {
  function wf(phases: unknown[], extra: Record<string, unknown> = {}): ResolvedDefinition {
    const d = workflowDef([], true);
    const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
    w.orchestration = { ...w.orchestration, phases, ...extra };
    return d;
  }
  function stepExec(plan: Record<string, 'pass' | 'low' | 'wait' | 'boom'>) {
    return {
      execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, _i: unknown, o?: { abortSignal?: AbortSignal }) => {
        const b = plan[resolved.name];
        if (b === 'pass') return makeCommandResult({ name: resolved.name, score: 90 });
        if (b === 'low') return makeCommandResult({ name: resolved.name, score: 10, decision: 'PASS', decisionCategory: 'positive' });
        if (b === 'boom') throw new Error('boom');
        return new Promise((_res, rej) => o?.abortSignal?.addEventListener('abort', () => rej(new CancelledError('x')), { once: true }));
      }),
    } as unknown as CommandExecutor;
  }
  async function run(def: ResolvedDefinition, plan: Record<string, 'pass' | 'low' | 'wait' | 'boom'>) {
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    return new WorkflowExecutor(stepExec(plan), makeRegistry(), undefined, noopLogger).execute(def, { target: '/tmp' }, { abortSignal: c.signal });
  }

  // NC: against 911115f the score gate (threshold 50, panel avg 10) BLOCKs a stopped panel.
  it('a low score beside a stopped step is aborted under on_fail block and warn alike', async () => {
    for (const on_fail of ['block', 'warn']) {
      const r = await run(wf([{ id: 'p', name: 'P', commands: ['low', 'w'], parallel: true, gate: { threshold: 50, aggregate: 'average', on_fail } }]), { low: 'low', w: 'wait' });
      expect(r.phases[0]!.decision, on_fail).toBe('aborted');
    }
  });

  // OD-12 "crash decides": a crash beside a stopped step makes the phase `blocked` — postures
  // (on_fail: warn) do not apply to a stopped phase. NC: against 3381f4f this phase was `warned`
  // and the workflow HOLD; against 1fab201 it was `aborted` and the crash vanished (auditor F1).
  it('a crash beside a stopped step under on_fail warn is blocked: crash decides', async () => {
    const r = await run(wf([{ id: 'p', name: 'P', commands: ['b', 'w'], parallel: true, gate: { threshold: 0, aggregate: 'average', on_fail: 'warn' } }]), { b: 'boom', w: 'wait' });
    expect(r.phases[0]!.decision).toBe('blocked');
    expect(r.decision).toBe('BLOCK');
  });

  // Guard (test-architect #1). MC: swap hasBlocked/hasAborted in aggregate() → ABORTED.
  it('two phases, one blocked by a crash and one aborted: the workflow is BLOCK', async () => {
    const r = await run(wf([
      { id: 'a', name: 'A', commands: ['b1', 'b2'], parallel: true, gate: { threshold: 0, aggregate: 'average', on_fail: 'block' } },
      { id: 'b', name: 'B', commands: ['ok', 'w'], parallel: true, gate: { threshold: 0, aggregate: 'average', on_fail: 'block' } },
    ]), { b1: 'boom', b2: 'pass', ok: 'pass', w: 'wait' });
    expect(r.phases.map(p => p.decision).sort()).toEqual(['aborted', 'blocked']);
    expect(r.decision).toBe('BLOCK');
  });

  // crew #110 F2. NC: against 911115f the workflow score is 0 beside a phase that scored 90.
  it('a workflow whose only scored work is in a stopped phase has score null, not 0', async () => {
    const r = await run(wf([{ id: 'p', name: 'P', commands: ['ok', 'w'], parallel: true, gate: { threshold: 0, aggregate: 'average', on_fail: 'block' } }]), { ok: 'pass', w: 'wait' });
    expect(r.phases[0]!.score).toBe(90);
    expect(r.score).toBeNull();
  });

  // crew #110 F6 + re-check H1. NC: against 911115f the queued phase is dispatched.
  it('a phase queued behind max_parallel when the run stops is recorded aborted, not dispatched', async () => {
    const exec = stepExec({ w1: 'wait', q: 'pass' });
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    const r = await new WorkflowExecutor(exec, makeRegistry(), undefined, noopLogger).execute(wf([
      { id: 'first', name: 'First', commands: ['w1'], parallel: true },
      { id: 'queued', name: 'Queued', commands: ['q'], parallel: true },
    ], { max_parallel: 1 }), { target: '/tmp' }, { abortSignal: c.signal });
    expect(r.phases.find(p => p.id === 'queued')!.decision).toBe('aborted');
    expect(r.phases.find(p => p.id === 'queued')!.commands).toEqual([]);
    expect((exec.execute as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[0] as ResolvedDefinition).name)).not.toContain('q');
  });

  // test-architect #5: a step that is itself a REAL multi-agent command aggregated to ABORTED
  // (real version) — only isStoppedResult's container clause sees it.
  it('a real multi-agent command step that aggregated to ABORTED makes the phase aborted', async () => {
    const registry = makeRegistry({ panel: commandDef(['a@1', 'b@1'], false) });
    const realCmd = new CommandExecutor(agentExecutor({ a: 'pass', b: 'wait' }), registry);
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    const r = await new WorkflowExecutor(realCmd, registry, undefined, noopLogger).execute(
      wf([{ id: 'p', name: 'P', commands: ['panel'], parallel: true }]), { target: '/tmp' }, { abortSignal: c.signal });
    expect(r.phases[0]!.commands[0]!.version).toBe('1.0.0');
    expect(r.phases[0]!.commands[0]!.decision).toBe('ABORTED');
    expect(r.phases[0]!.decision).toBe('aborted');
  });
});

describe('fold: a caller DEADLINE is a timeout, not a stop (Alex, crew #110 P1)', () => {
  // NC: against 911115f the run ends `cancelled`, wait() resolves, the waiting agent is ABORTED.
  it('AbortSignal.timeout as the caller signal fails the run and keeps agents as crashes', async () => {
    const exec = pipelineExecutor(agentExecutor({ waits: 'wait' }), ['waits']);
    const handle = await exec.start(inlinePipeline(['waits']), { target: '/tmp' }, { abortSignal: AbortSignal.timeout(10) });
    const { thrown } = await settle(handle.wait());
    expect(thrown).toBeInstanceOf(PipelineError);
    expect(thrown!.message).toMatch(/deadline/);
    const partial = thrown!.context.partialResult as { status: string; stages: Array<{ agentResults: AgentResult[] }> };
    expect(partial.status).toBe('failed');
    expect(partial.stages[0]!.agentResults.map(a => a.decision)).toEqual(['FAIL']);
  });

  it('isRunStopAbort is false under a fired deadline signal', async () => {
    const d = AbortSignal.timeout(1);
    await new Promise(r => setTimeout(r, 10));
    expect(isRunStopAbort(new CancelledError('x'), d)).toBe(false);
  });
});

describe('fold: pipeline edges', () => {
  function refPipeline(): ResolvedDefinition {
    const d = inlinePipeline([]);
    (d.definition as unknown as PipelineDefinition).pipeline.stages = [
      { id: 's1', name: 'S1', type: 'command', ref: 'one@1' },
      { id: 's2', name: 'S2', type: 'command', ref: 'two@1' },
    ] as never;
    return d;
  }
  function refExecutor() {
    const cmdExec = {
      execute: vi.fn().mockImplementation((_r: unknown, _i: unknown, o?: { abortSignal?: AbortSignal }) =>
        new Promise((_res, rej) => o?.abortSignal?.addEventListener('abort', () => rej(new CancelledError('x')), { once: true }))),
    } as unknown as CommandExecutor;
    const registry = makeRegistry();
    return new PipelineExecutor(new WorkflowExecutor(cmdExec, registry), cmdExec, {} as AgentExecutor, registry, noopLogger);
  }

  // Alex, crew #110 F4. NC: against 911115f the stage is `failed` and counts in stagesFailed.
  it('a stopped single-agent ref stage is a completed stage holding an ABORTED record', async () => {
    const handle = await refExecutor().start(refPipeline(), { target: '/tmp' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    const result = await handle.wait();
    expect(result.stages[0]!.status).toBe('completed');
    expect(result.stages[0]!.agentResults!.map(a => a.decision)).toEqual(['ABORTED']);
    expect(result.metrics.stagesFailed).toBe(0);
    expect(result.stages[1]!.status).toBe('skipped');
  });

  // crew #110 F3. NC: against 911115f cancel() throws "already complete (status: cancelled)".
  it('cancel() after the caller signal stopped the run is a no-op', async () => {
    const caller = new AbortController();
    const handle = await refExecutor().start(refPipeline(), { target: '/tmp' }, { abortSignal: caller.signal });
    await new Promise(r => setTimeout(r, 5));
    caller.abort();
    await expect(handle.cancel()).resolves.toBeUndefined();
    expect((await handle.wait()).status).toBe('cancelled');
  });

  // test-architect #4. MC: drop removeEventListener in start()'s unregister → fails.
  it('the caller-signal listener is removed when the run settles', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const exec = pipelineExecutor(agentExecutor({ ok: 'pass' }), ['ok']);
    await (await exec.start(inlinePipeline(['ok']), { target: '/tmp' }, { abortSignal: caller.signal })).wait();
    await new Promise(r => setTimeout(r, 0));
    expect(remove.mock.calls.map(c => c[0])).toContain('abort');
  });

  // crew #110 F5. NC: against 911115f the early foreign CANCELLED is classified after the stop and
  // reads ABORTED.
  it('a CANCELLED that rejected while the run was live stays a crash after a later stop', async () => {
    const agentExec = {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition, _i: unknown, o?: ExecutionOptions) => {
        if (r.name === 'early') throw new CancelledError('foreign');
        return untilAborted(o?.abortSignal, makeValidatorResult({ name: r.name }));
      }),
    } as unknown as AgentExecutor;
    const exec = pipelineExecutor(agentExec, ['early', 'late']);
    const handle = await exec.start(inlinePipeline(['early', 'late']), { target: '/tmp' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    const byName = Object.fromEntries((await handle.wait()).stages[0]!.agentResults!.map(a => [a.name, a.decision]));
    expect(byName).toEqual({ early: 'FAIL', late: 'ABORTED' });
  });

  // The computeDecision ABORTED guard is DEFENCE IN DEPTH and unreachable through the public API
  // today: every stop source (cancel, credit trip, caller abort, deadline) now goes through
  // stopRun, which sets status before any child classifies, so the status short-circuit decides
  // first. No test claims to cover it (test-architect #3).
});

describe('isStoppedResult (crew #110 F3)', () => {
  it('matches a placeholder and a real-versioned container that aggregated to ABORTED', async () => {
    const { isStoppedResult } = await import('../../src/index.js');
    expect(isStoppedResult(abortedPlaceholder('x', new CancelledError('x')))).toBe(true);
    expect(isStoppedResult({ decision: 'ABORTED', version: '1.0.0', degradationMarkers: [{ code: 'execution.run-stopped' }] })).toBe(true);
    // Re-check M1: a model can output "ABORTED"; without core's marker it is not a stopped run.
    expect(isStoppedResult({ decision: 'ABORTED', version: '1.0.0' })).toBe(false);
    expect(isStoppedResult({ decision: 'PASS', version: '1.0.0', degradationMarkers: [{ code: 'budget.forced-wrap-up' }] })).toBe(false);
  });
});

describe('fold re-check (H1, M1, M2)', () => {
  function stepsWf(phases: unknown[], extra: Record<string, unknown> = {}): ResolvedDefinition {
    const d = workflowDef([], true);
    const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
    w.orchestration = { ...w.orchestration, phases, ...extra };
    return d;
  }

  // H1. NC: against 03cbb39 this reads SHIP — the queued phase was `skipped`, "no evidence".
  it('a stop between phases never yields SHIP', async () => {
    const cmdExec = {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition) => {
        if (r.name === 'first') { controller.abort(); return makeCommandResult({ name: 'first', score: 90 }); }
        return makeCommandResult({ name: r.name, score: 90 });
      }),
    } as unknown as CommandExecutor;
    const controller = new AbortController();
    const r = await new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger).execute(stepsWf([
      { id: 'a', name: 'A', commands: ['first'], parallel: true },
      { id: 'b', name: 'B', commands: ['queued'], parallel: true },
    ], { max_parallel: 1 }), { target: '/tmp' }, { abortSignal: controller.signal });
    expect(r.phases.map(p => p.decision)).toEqual(['passed', 'aborted']);
    expect(r.decision).toBe('ABORTED');
    expect(r.degradationMarkers?.map(m => m.code)).toEqual(['execution.run-stopped']);
  });

  it('under a caller deadline, phases the stop kept from starting are blocked, not aborted', async () => {
    const cmdExec = { execute: vi.fn().mockImplementation(async (r: ResolvedDefinition) => makeCommandResult({ name: r.name, score: 90 })) } as unknown as CommandExecutor;
    const d = AbortSignal.timeout(1);
    await new Promise(r => setTimeout(r, 10));
    const r = await new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger).execute(
      stepsWf([{ id: 'a', name: 'A', commands: ['x'], parallel: true }]), { target: '/tmp' }, { abortSignal: d });
    expect(r.phases[0]!.decision).toBe('blocked');
    expect(r.decision).toBe('BLOCK');
  });

  // M1. NC: against 03cbb39 a model-emitted ABORTED (neutral, real version) made the phase
  // `aborted` and the workflow score null in a run nobody stopped.
  it('a real step whose model said "ABORTED" in an unstopped run is not a stopped step', async () => {
    const cmdExec = { execute: vi.fn().mockResolvedValue(makeCommandResult({ name: 'odd', score: 80, decision: 'ABORTED', decisionCategory: 'neutral' })) } as unknown as CommandExecutor;
    const r = await new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger).execute(
      stepsWf([{ id: 'a', name: 'A', commands: ['odd'], parallel: true, gate: { threshold: 50, aggregate: 'average', on_fail: 'block' } }]), { target: '/tmp' });
    expect(r.phases[0]!.decision).toBe('passed');
    expect(r.score).toBe(80);
  });

  // M2. NC: against 03cbb39 cancel() rejects "already complete (status: failed)" mid-unwind.
  it('cancel() after a caller deadline, while the run is unwinding, is a no-op', async () => {
    // The agent takes 60 ms to unwind after the abort, so cancel() at 20 ms lands mid-unwind.
    const slowUnwind = {
      execute: vi.fn().mockImplementation((_r: unknown, _i: unknown, o?: ExecutionOptions) => new Promise((_res, rej) => {
        o?.abortSignal?.addEventListener('abort', () => setTimeout(() => rej(new CancelledError('x')), 60), { once: true });
      })),
    } as unknown as AgentExecutor;
    const exec = pipelineExecutor(slowUnwind, ['waits']);
    const handle = await exec.start(inlinePipeline(['waits']), { target: '/tmp' }, { abortSignal: AbortSignal.timeout(5) });
    await new Promise(r => setTimeout(r, 20));
    expect(handle.isComplete()).toBe(true); // status is already `failed` — the reason the old guard misfired
    await expect(handle.cancel()).resolves.toBeUndefined();
    await settle(handle.wait());
    // A SETTLED run still rejects, as before.
    await expect(handle.cancel()).rejects.toThrow(/already complete/);
  });

  it('a stopped multi-agent command and stage carry the run-stopped marker', async () => {
    const { result } = await runCommand({ a: 'pass', b: 'wait' }, ['a@1', 'b@1'], false);
    expect(result!.degradationMarkers?.map(m => m.code)).toEqual(['execution.run-stopped']);
  });
});

describe('second re-check (M1, M2, L1)', () => {
  function layout(sameLevel: boolean): ResolvedDefinition {
    const d = workflowDef([], true);
    const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
    w.orchestration = {
      ...w.orchestration,
      on_failure: 'warn',
      ...(sameLevel ? { max_parallel: 1 } : {}),
      phases: [
        { id: 'a', name: 'A', commands: ['first'], parallel: true },
        { id: 'b', name: 'B', commands: ['second'], parallel: true, ...(sameLevel ? {} : { depends_on: ['a'] }) },
      ],
    };
    return d;
  }
  async function deadlineDuringA(def: ResolvedDefinition) {
    const c = new AbortController();
    const cmdExec = {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition) => {
        if (r.name === 'first') c.abort(new DOMException('deadline', 'TimeoutError'));
        return makeCommandResult({ name: r.name, score: 90, metrics: { inputTokens: 1, outputTokens: 1, totalEffectiveTokens: 2, durationMs: 1, model: 'm', toolCalls: 0, costUsd: 0.01, costBasis: 'estimated' } as never });
      }),
    } as unknown as CommandExecutor;
    return new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger).execute(def, { target: '/tmp' }, { abortSignal: c.signal });
  }

  // M1. NC: against 3381f4f the queued layout reads HOLD (on_failure warn rewrote it) while the
  // later-level layout reads BLOCK — scheduling decided the verdict of one deadline.
  it('one deadline, two layouts, one verdict: BLOCK, never HOLD', async () => {
    const queued = await deadlineDuringA(layout(true));
    const later = await deadlineDuringA(layout(false));
    expect(queued.phases.map(p => p.decision)).toEqual(['passed', 'blocked']);
    expect(later.phases.map(p => p.decision)).toEqual(['passed', 'blocked']);
    expect([queued.decision, later.decision]).toEqual(['BLOCK', 'BLOCK']);
  });

  // M2. NC: against 3381f4f the stopped phase counts as executed and makes the cost unpriced.
  it('a phase a deadline kept from starting is not executed and adds no cost', async () => {
    const r = await deadlineDuringA(layout(false));
    expect(r.metrics.phasesExecuted).toBe(1);
    expect(r.metrics.costUsd).toBe(0.01);
    expect(r.phases[1]!.stoppedBeforeStart).toBe(true);
  });

  // L1. NC: against 3381f4f a skip_if phase after the stop is recorded aborted, not skipped.
  it('a phase skip_if would have skipped stays skipped after a stop', async () => {
    const d = workflowDef([], true);
    const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
    w.orchestration = { ...w.orchestration, phases: [
      { id: 'a', name: 'A', commands: ['first'], parallel: true },
      { id: 'b', name: 'B', commands: ['second'], parallel: true, depends_on: ['a'], skip_if: '{{ input.skipB }}' },
    ] };
    const c = new AbortController();
    const cmdExec = { execute: vi.fn().mockImplementation(async () => { c.abort(); return makeCommandResult({ score: 90 }); }) } as unknown as CommandExecutor;
    const exec = new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger);
    const r = await exec.execute(d, { target: '/tmp', options: { skipB: true } } as never, { abortSignal: c.signal });
    expect(r.phases[1]!.decision).toBe('skipped');
  });
});

describe('second re-check H1: a stop survives every hand-off', () => {
  // NC: against 3381f4f — command WARN (no marker), phase passed, workflow SHIP.
  it('a workflow whose command step held a lens negative and a stopped agent never reads SHIP', async () => {
    const lens = makeValidatorResult({ name: 'lens', decision: 'DISORDERED', decisionCategory: 'negative', score: 82, recommendations: [] });
    const agentExec = {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition, _i: unknown, o?: ExecutionOptions) =>
        r.name === 'lens' ? lens : untilAborted(o?.abortSignal, makeValidatorResult())),
    } as unknown as AgentExecutor;
    const registry = makeRegistry({ panel: commandDef(['lens@1', 'b@1'], false) });
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    const d = workflowDef(['panel'], true);
    const r = await new WorkflowExecutor(new CommandExecutor(agentExec, registry), registry, undefined, noopLogger)
      .execute(d, { target: '/tmp' }, { abortSignal: c.signal });
    expect(r.decision).not.toBe('SHIP');
    expect(r.decision).toBe('ABORTED');
  });

  // Guard: a container whose own verdict IS negative from a real failure keeps it. MC: drop the
  // `decisionCategory === 'negative'` conjunct's partner (child-negative) → ABORTED.
  it('a crash beside a stopped step under on_fail block stays blocked', async () => {
    const r = await runWorkflow({ a: 'boom', b: 'wait' }, ['a', 'b']);
    expect(r.phases[0]!.decision).toBe('blocked');
  });
});

/**
 * INVARIANT, independent of any one rule's wording: if any agent in a workflow was stopped by an
 * explicit run stop, the workflow never reads SHIP or HOLD — a quality verdict over work that did
 * not finish. Enumerated over real CommandExecutor + WorkflowExecutor: a phase holding a 2-agent
 * command step and a plain step, every agent-outcome mix, gate on_fail × workflow on_failure.
 * Written after three review rounds each found the previous fold's own joints; the per-rule tests
 * kept passing while the composition broke, so this asserts the composed property directly.
 */
describe('invariant: a stopped workflow never reads SHIP or HOLD', () => {
  type B = 'pass' | 'warnscore' | 'lens' | 'boom' | 'wait';
  const outcomes: B[] = ['pass', 'warnscore', 'lens', 'boom', 'wait'];
  function agentFor(b: B, name: string, signal?: AbortSignal): Promise<AgentResult> {
    switch (b) {
      case 'pass': return Promise.resolve(makeValidatorResult({ name, score: 90, recommendations: [] }));
      case 'warnscore': return Promise.resolve(makeValidatorResult({ name, score: 60, decision: 'WARN', decisionCategory: 'conditional', recommendations: [] }));
      case 'lens': return Promise.resolve(makeValidatorResult({ name, score: 82, decision: 'DISORDERED', decisionCategory: 'negative', recommendations: [] }));
      case 'boom': return Promise.reject(new Error('boom'));
      case 'wait': return untilAborted(signal, makeValidatorResult({ name }));
    }
  }

  for (const mode of ['explicit', 'deadline'] as const)
  it(`holds across 300 compositions (${mode} stop)`, async () => {
    let checked = 0;
    let stoppedRuns = 0;
    for (const x of outcomes) for (const y of outcomes) for (const z of ['pass', 'boom', 'wait'] as const)
    for (const on_fail of ['block', 'warn']) for (const on_failure of ['continue', 'warn']) {
      const plan: Record<string, B> = { x, y, z };
      const agentExec = {
        execute: vi.fn().mockImplementation((r: ResolvedDefinition, _i: unknown, o?: ExecutionOptions) => agentFor(plan[r.name]!, r.name, o?.abortSignal)),
      } as unknown as AgentExecutor;
      const registry = makeRegistry({
        panel: commandDef(['x@1', 'y@1'], false),
        plain: commandDef(['z@1'], false),
      });
      const d = workflowDef([], true);
      const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
      w.orchestration = { ...w.orchestration, on_failure, phases: [
        { id: 'p', name: 'P', commands: ['panel', 'plain'], parallel: true, gate: { threshold: 70, aggregate: 'average', on_fail } },
      ] };
      const c = new AbortController();
      const anyWait = [x, y, z].includes('wait');
      if (anyWait) setTimeout(() => (mode === 'deadline' ? c.abort(new DOMException('deadline', 'TimeoutError')) : c.abort()), 3);
      const r = await new WorkflowExecutor(new CommandExecutor(agentExec, registry), registry, undefined, noopLogger)
        .execute(d, { target: '/tmp' }, { abortSignal: c.signal })
        .catch((e: unknown) => ({ decision: `THREW:${(e as Error).name}` }) as { decision: string });
      checked++;
      if (anyWait) {
        stoppedRuns++;
        // OD-12 "crash decides", stated exactly: a stopped workflow is BLOCK iff something really
        // crashed (a deadline's in-flight agents count), else ABORTED. Never SHIP or HOLD, and a
        // deadline is never the neutral ABORTED. (An all-steps-crashed phase may throw; that is a
        // crash outcome too.)
        const crashed = mode === 'deadline' || [x, y, z].includes('boom');
        const label = `${mode}: ${x},${y},${z} on_fail=${on_fail} on_failure=${on_failure}`;
        if (crashed) expect(['BLOCK', 'THREW:WorkflowError'], label).toContain(r.decision);
        else expect(r.decision, label).toBe('ABORTED');
        // The same rule at the PHASE a consumer reads: no posture, no gate verdict survives a stop.
        const phase = (r as { phases?: Array<{ decision: string }> }).phases?.[0];
        if (phase) expect(phase.decision, `phase ${label}`).toBe(crashed ? 'blocked' : 'aborted');
      }
    }
    expect(checked).toBe(300);
    expect(stoppedRuns).toBeGreaterThan(100); // the property was actually exercised
  });
});

describe('OD-13: a real failure beats a later user cancel at the pipeline', () => {
  // NC: against 1fab201 this reads CANCELLED — the status short-circuit ranked the cancel above a
  // stage that had already really FAILED.
  it('a stage FAILs, the run continues, then cancel(): decision FAIL, status still cancelled', async () => {
    const agentExec = {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition, _i: unknown, o?: ExecutionOptions) =>
        r.name === 'bad' ? makeValidatorResult({ name: 'bad', score: 20, decision: 'FAIL', decisionCategory: 'negative' })
          : untilAborted(o?.abortSignal, makeValidatorResult({ name: r.name }))),
    } as unknown as AgentExecutor;
    const exec = pipelineExecutor(agentExec, ['bad', 'slow']);
    const d = inlinePipeline([]);
    (d.definition as unknown as PipelineDefinition).pipeline.stages = [
      { id: 's1', name: 'S1', type: 'agents', agents: [{ ref: 'bad' }] },
      { id: 's2', name: 'S2', type: 'agents', agents: [{ ref: 'slow' }] },
    ] as never;
    const handle = await exec.start(d, { target: '/tmp' });
    await new Promise(r => setTimeout(r, 10));
    await handle.cancel();
    const result = await handle.wait();
    expect(result.status).toBe('cancelled');
    expect(result.decision).toBe('FAIL');
  });

  it('control: a cancel with no failure is still CANCELLED', async () => {
    const exec = pipelineExecutor(agentExecutor({ a: 'wait' }), ['a']);
    const handle = await exec.start(inlinePipeline(['a']), { target: '/tmp' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    expect((await handle.wait()).decision).toBe('CANCELLED');
  });
});

/**
 * OD-14 "finished keeps verdict" (Alex 2026-10-06): crash-decides applies only to the parts a stop
 * reached. A phase that FINISHED before the stop keeps its own verdict — gate and warn postures
 * included — so the same phases get the same verdict whether they sit in one workflow or are split
 * across pipeline stages.
 *
 * LAYOUT INVARIANCE, enumerated over real WorkflowExecutor + PipelineExecutor: phase A finishes,
 * phase B is reached by the stop (its trigger step fires the stop and waits on it). Layout 1: one
 * workflow, B depends_on A. Layout 2: a pipeline of two workflow-ref stages, one phase each. The
 * oracle is independent of both: A's verdict is what A alone, unstopped, returns; the run is
 * negative iff B holds a real crash (a deadline counts) or A alone is negative; else no verdict.
 */
describe('OD-14: finished keeps verdict, layout-invariant', () => {
  type S = 'pass' | 'low' | 'lens' | 'boom' | 'trigger';
  const aSets: S[][] = [['pass'], ['low'], ['lens'], ['boom', 'pass'], ['boom'], ['low', 'pass']];
  const bSets: S[][] = [['trigger'], ['trigger', 'pass'], ['trigger', 'low'], ['trigger', 'boom']];
  type Mode = 'explicit' | 'deadline';

  function phase(id: string, steps: string[], on_fail: string, extra: Record<string, unknown> = {}) {
    return { id, name: id.toUpperCase(), commands: steps, parallel: true, gate: { threshold: 50, aggregate: 'average', on_fail }, ...extra };
  }
  function wfOf(name: string, phases: unknown[], on_failure = 'continue'): ResolvedDefinition {
    const d = workflowDef([], true);
    d.name = name;
    const w = (d.definition as unknown as { workflow: { interface: { name: string }; orchestration: Record<string, unknown> } }).workflow;
    w.interface.name = name;
    w.orchestration = { ...w.orchestration, on_failure, phases };
    return d;
  }
  /** Step names are `<phase>-<i>-<behaviour>`; the trigger fires the stop on the shared controller. */
  function stepsFor(p: string, set: S[]) { return set.map((b, i) => `${p}-${i}-${b}`); }
  function stepExec(c: AbortController | undefined, mode: Mode) {
    return {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition, _i: unknown, o?: { abortSignal?: AbortSignal }) => {
        const b = r.name.split('-')[2] as S;
        switch (b) {
          case 'pass': return makeCommandResult({ name: r.name, score: 90 });
          case 'low': return makeCommandResult({ name: r.name, score: 10, decision: 'PASS', decisionCategory: 'positive' });
          case 'lens': return makeCommandResult({ name: r.name, score: 82, decision: 'DISORDERED', decisionCategory: 'negative' });
          case 'boom': throw new Error('boom');
          case 'trigger':
            return new Promise((_res, rej) => {
              o?.abortSignal?.addEventListener('abort', () => rej(new CancelledError('x')), { once: true });
              c?.abort(mode === 'deadline' ? new DOMException('deadline', 'TimeoutError') : undefined);
            });
        }
      }),
    } as unknown as CommandExecutor;
  }
  const cat = (decision: string) => ({ FAIL: 'negative', BLOCK: 'negative', CANCELLED: 'neutral', ABORTED: 'neutral', WARN: 'conditional', HOLD: 'conditional', PASS: 'positive', SHIP: 'positive' } as Record<string, string>)[decision] ?? `?${decision}`;

  async function aloneCategory(a: S[], on_fail: string, on_failure = 'continue'): Promise<string> {
    const r = await new WorkflowExecutor(stepExec(undefined, 'explicit'), makeRegistry(), undefined, noopLogger)
      .execute(wfOf('a', [phase('a', stepsFor('a', a), on_fail)], on_failure), { target: '/tmp' })
      .catch(() => ({ decision: 'BLOCK' }));
    return cat(r.decision);
  }
  // Same level under max_parallel 1, not depends_on: a blocked A would make B dependencies-not-met
  // (skipped), so the stop would never happen and the case would test nothing.
  async function oneWorkflowResult(a: S[], b: S[], on_fail: string, mode: Mode, on_failure = 'continue') {
    const c = new AbortController();
    const d = wfOf('ab', [phase('a', stepsFor('a', a), on_fail), phase('b', stepsFor('b', b), on_fail)], on_failure);
    (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow.orchestration.max_parallel = 1;
    return new WorkflowExecutor(stepExec(c, mode), makeRegistry(), undefined, noopLogger)
      .execute(d, { target: '/tmp' }, { abortSignal: c.signal })
      .catch(() => ({ decision: 'BLOCK', phases: undefined }));
  }
  async function oneWorkflow(a: S[], b: S[], on_fail: string, mode: Mode, on_failure = 'continue'): Promise<string> {
    const r = await oneWorkflowResult(a, b, on_fail, mode, on_failure);
    // Every case must actually reach B with the stop — otherwise it is not an OD-14 case.
    if (r.phases) expect(r.phases.find(p => p.id === 'b')!.decision, 'B reached by the stop').toMatch(/^(aborted|blocked)$/);
    return cat(r.decision);
  }
  async function twoStages(a: S[], b: S[], on_fail: string, mode: Mode, on_failure = 'continue'): Promise<string> {
    const c = new AbortController();
    const registry = makeRegistry({
      wa: wfOf('wa', [phase('a', stepsFor('a', a), on_fail)], on_failure),
      wb: wfOf('wb', [phase('b', stepsFor('b', b), on_fail)], on_failure),
    });
    const cmdExec = stepExec(c, mode);
    const exec = new PipelineExecutor(new WorkflowExecutor(cmdExec, registry, undefined, noopLogger), cmdExec, {} as AgentExecutor, registry, noopLogger);
    const d = inlinePipeline([]);
    (d.definition as unknown as PipelineDefinition).pipeline.stages = [
      { id: 's1', name: 'S1', type: 'workflow', ref: 'wa@1' },
      { id: 's2', name: 'S2', type: 'workflow', ref: 'wb@1' },
    ] as never;
    const { resolved, thrown } = await settle((await exec.start(d, { target: '/tmp' }, { abortSignal: c.signal })).wait());
    const decision = (resolved as { decision?: string } | undefined)?.decision
      ?? (thrown?.context?.partialResult as { decision?: string } | undefined)?.decision ?? 'FAIL';
    return cat(decision);
  }

  for (const mode of ['explicit', 'deadline'] as const)
  it(`one workflow and two pipeline stages agree with the oracle across 96 layouts (${mode} stop)`, async () => {
    let checked = 0;
    // on_failure: warn included (fuzz F1): a phase whose every step crashed is not softened by it.
    for (const a of aSets) for (const b of bSets) for (const on_fail of ['block', 'warn']) for (const on_failure of ['continue', 'warn']) {
      const bCrashed = mode === 'deadline' || b.includes('boom');
      const expected = bCrashed || (await aloneCategory(a, on_fail, on_failure)) === 'negative' ? 'negative' : 'neutral';
      const label = `${mode}: A=${a} B=${b} on_fail=${on_fail} on_failure=${on_failure}`;
      expect(await oneWorkflow(a, b, on_fail, mode, on_failure), `workflow ${label}`).toBe(expected);
      expect(await twoStages(a, b, on_fail, mode, on_failure), `pipeline ${label}`).toBe(expected);
      checked++;
    }
    expect(checked).toBe(96);
  });

  // The two cases 254af8b got wrong, pinned by name. NC: against 254af8b the first reads ABORTED
  // (a finished blocked phase lost its verdict to the stop) and the second reads BLOCK (a crash
  // inside a finished, posture-softened phase was counted as if the stop had reached it).
  it('a finished blocked phase keeps BLOCK beside a later stopped phase', async () => {
    const r = await oneWorkflowResult(['low'], ['trigger'], 'block', 'explicit');
    expect(r.phases!.map(p => p.decision)).toEqual(['blocked', 'aborted']); // precondition: B was stopped
    expect(r.decision).toBe('BLOCK');
  });
  // A crash is a scoreless negative, so it blocks its phase categorically — under on_fail: warn the
  // finished phase is `warned`, and that softened verdict is what it keeps.
  it('a crash inside a finished phase softened to warned does not make a stopped workflow BLOCK', async () => {
    expect(await aloneCategory(['boom', 'pass'], 'warn')).toBe('conditional'); // precondition
    expect(await oneWorkflow(['boom', 'pass'], ['trigger'], 'warn', 'explicit')).toBe('neutral');
  });
});

describe('run #113 mechanicals', () => {
  // D1. NC: against 254af8b a step-less phase (blocked by its fail-closed gate, nothing thrown)
  // counted as a crash, so a stop elsewhere read BLOCK.
  it('an authored-empty blocked phase is not a crash: a stop in a sibling phase reads ABORTED', async () => {
    const d = workflowDef([], true);
    const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
    w.orchestration = { ...w.orchestration, phases: [
      { id: 'empty', name: 'Empty', commands: [], parallel: true, gate: { threshold: 50, aggregate: 'average', on_fail: 'block' } },
      { id: 'b', name: 'B', commands: ['w'], parallel: true },
    ] };
    const c = new AbortController();
    const cmdExec = { execute: vi.fn().mockImplementation((_r: unknown, _i: unknown, o?: { abortSignal?: AbortSignal }) =>
      new Promise((_res, rej) => { o?.abortSignal?.addEventListener('abort', () => rej(new CancelledError('x')), { once: true }); c.abort(); })) } as unknown as CommandExecutor;
    const r = await new WorkflowExecutor(cmdExec, makeRegistry(), undefined, noopLogger).execute(d, { target: '/tmp' }, { abortSignal: c.signal });
    const empty = r.phases.find(p => p.id === 'empty')!;
    // Precondition: the empty phase is blocked by its gate, not by anything thrown. If an empty
    // phase ever stops being blocked, this test no longer exercises D1 — fail loudly.
    expect(empty.decision).toBe('blocked');
    expect(empty.error).toBeUndefined();
    // OD-14 makes a FINISHED blocked phase negative on its own, so assert the narrower D1 fact:
    // it is not reported as a crash.
    expect(r.degradationMarkers?.map(m => m.code) ?? []).not.toContain('execution.child-crashed');
  });

  // L1. NC: against 254af8b the stage is `failed` with no agentResults — the deadline's crash
  // record and its mark were dropped.
  it('a single-agent ref stage under a caller deadline is completed with a deadline-marked crash record', async () => {
    const c = new AbortController();
    const cmdExec = {
      execute: vi.fn().mockImplementation((_r: unknown, _i: unknown, o?: { abortSignal?: AbortSignal }) =>
        new Promise((_res, rej) => { o?.abortSignal?.addEventListener('abort', () => rej(new CancelledError('x')), { once: true }); c.abort(new DOMException('deadline', 'TimeoutError')); })),
    } as unknown as CommandExecutor;
    const registry = makeRegistry();
    const exec = new PipelineExecutor(new WorkflowExecutor(cmdExec, registry), cmdExec, {} as AgentExecutor, registry, noopLogger);
    const d = inlinePipeline([]);
    (d.definition as unknown as PipelineDefinition).pipeline.stages = [{ id: 's1', name: 'S1', type: 'command', ref: 'one@1' }] as never;
    const { thrown } = await settle((await exec.start(d, { target: '/tmp' }, { abortSignal: c.signal })).wait());
    const stage = (thrown!.context.partialResult as { stages: Array<{ status: string; agentResults?: AgentResult[]; result?: { degradationMarkers?: Array<{ code: string }> } }> }).stages[0]!;
    expect(stage.status).toBe('completed');
    expect(stage.agentResults!.map(a => [a.decision, a.version])).toEqual([['FAIL', CRASH_PLACEHOLDER_VERSION]]);
    expect(stage.result!.degradationMarkers!.map(m => m.code)).toContain('execution.deadline');
  });
});

describe('fuzz #114 folds (F1, F2, F3; Alex 2026-10-06)', () => {
  function wf(phases: unknown[], on_failure: string): ResolvedDefinition {
    const d = workflowDef([], true);
    const w = (d.definition as unknown as { workflow: { orchestration: Record<string, unknown> } }).workflow;
    w.orchestration = { ...w.orchestration, on_failure, phases };
    return d;
  }
  const gate = (on_fail = 'block') => ({ threshold: 50, aggregate: 'average', on_fail });
  /** `fire` aborts the run signal and then RETURNS normally — the stop reaches nothing. */
  function stepExec(c: AbortController | undefined, deadline = false) {
    return {
      execute: vi.fn().mockImplementation(async (r: ResolvedDefinition) => {
        if (r.name.startsWith('boom')) throw new Error('boom');
        if (r.name.startsWith('low')) return makeCommandResult({ name: r.name, score: 10, decision: 'PASS', decisionCategory: 'positive' });
        if (r.name.startsWith('fire')) c?.abort(deadline ? new DOMException('deadline', 'TimeoutError') : undefined);
        return makeCommandResult({ name: r.name, score: 90 });
      }),
    } as unknown as CommandExecutor;
  }

  // F1. NC: against 92a6d6c this reads HOLD — on_failure: warn rewrote a phase that produced no
  // verdict (every step crashed) to `warned`; the same phase as its own workflow throws.
  it('a phase whose every step crashed stays blocked under on_failure: warn (unstopped)', async () => {
    const r = await new WorkflowExecutor(stepExec(undefined), makeRegistry(), undefined, noopLogger)
      .execute(wf([{ id: 'a', name: 'A', commands: ['boom'], parallel: true, gate: gate() }, { id: 'p', name: 'P', commands: ['ok'], parallel: true, gate: gate() }], 'warn'), { target: '/tmp' });
    expect(r.phases.find(p => p.id === 'a')!.decision).toBe('blocked');
    expect(r.decision).toBe('BLOCK');
  });
  // Guard: a GATE-blocked phase is still softened — the exemption is for crashed-outright phases only.
  it('control: a gate-blocked phase is still softened to warned under on_failure: warn', async () => {
    const r = await new WorkflowExecutor(stepExec(undefined), makeRegistry(), undefined, noopLogger)
      .execute(wf([{ id: 'a', name: 'A', commands: ['low'], parallel: true, gate: gate() }, { id: 'p', name: 'P', commands: ['ok'], parallel: true, gate: gate() }], 'warn'), { target: '/tmp' });
    expect(r.phases.find(p => p.id === 'a')!.decision).toBe('warned');
    expect(r.decision).toBe('HOLD');
  });

  // F2. NC: against 92a6d6c the pipeline reads CANCELLED / FAIL while the workflow reads SHIP.
  for (const deadline of [false, true])
  it(`a stop that reached nothing keeps the verdict at both levels (${deadline ? 'deadline' : 'explicit'})`, async () => {
    const c1 = new AbortController();
    const w = await new WorkflowExecutor(stepExec(c1, deadline), makeRegistry(), undefined, noopLogger)
      .execute(wf([{ id: 'a', name: 'A', commands: ['fire'], parallel: true, gate: gate() }], 'continue'), { target: '/tmp' }, { abortSignal: c1.signal });
    expect(w.decision).toBe('SHIP');

    const c2 = new AbortController();
    const registry = makeRegistry({ wa: wf([{ id: 'a', name: 'A', commands: ['fire'], parallel: true, gate: gate() }], 'continue') });
    const cmdExec = stepExec(c2, deadline);
    const exec = new PipelineExecutor(new WorkflowExecutor(cmdExec, registry, undefined, noopLogger), cmdExec, {} as AgentExecutor, registry, noopLogger);
    const d = inlinePipeline([]);
    (d.definition as unknown as PipelineDefinition).pipeline.stages = [{ id: 's1', name: 'S1', type: 'workflow', ref: 'wa@1' }] as never;
    const { resolved, thrown } = await settle((await exec.start(d, { target: '/tmp' }, { abortSignal: c2.signal })).wait());
    const result = (resolved ?? thrown!.context.partialResult) as { decision: string; status: string };
    expect(result.decision).toBe('PASS');
    // The run-level fact is kept: the status records the stop, and a deadline still throws.
    expect(result.status).toBe(deadline ? 'failed' : 'cancelled');
    expect(thrown !== undefined).toBe(deadline);
  });
  // Guard: a stop that kept a later stage from starting DID reach something.
  it('control: a stop that skipped a later stage still reads CANCELLED', async () => {
    const c = new AbortController();
    const registry = makeRegistry({ wa: wf([{ id: 'a', name: 'A', commands: ['fire'], parallel: true, gate: gate() }], 'continue') });
    const cmdExec = stepExec(c);
    const exec = new PipelineExecutor(new WorkflowExecutor(cmdExec, registry, undefined, noopLogger), cmdExec, {} as AgentExecutor, registry, noopLogger);
    const d = inlinePipeline([]);
    (d.definition as unknown as PipelineDefinition).pipeline.stages = [
      { id: 's1', name: 'S1', type: 'workflow', ref: 'wa@1' },
      { id: 's2', name: 'S2', type: 'workflow', ref: 'wa@1' },
    ] as never;
    const result = await (await exec.start(d, { target: '/tmp' }, { abortSignal: c.signal })).wait();
    expect(result.stages[1]!.status).toBe('skipped');
    expect(result.decision).toBe('CANCELLED');
  });

  // F3. NC: against 92a6d6c C is recorded aborted/stoppedBeforeStart (deadline: blocked + a
  // child-crashed marker) for a phase the on_failure: stop halt would have skipped anyway.
  for (const deadline of [false, true])
  it(`an on_failure halt beside a stop in the same level leaves later phases skipped (${deadline ? 'deadline' : 'explicit'})`, async () => {
    const c = new AbortController();
    const r = await new WorkflowExecutor(stepExec(c, deadline), makeRegistry(), undefined, noopLogger)
      .execute(wf([
        { id: 'a', name: 'A', commands: ['low'], parallel: true, gate: gate() },
        { id: 'b', name: 'B', commands: ['fire'], parallel: true, gate: gate() },
        { id: 'c', name: 'C', commands: ['ok'], parallel: true, gate: gate(), depends_on: ['b'] },
      ], 'stop'), { target: '/tmp' }, { abortSignal: c.signal });
    const C = r.phases.find(p => p.id === 'c')!;
    expect(C.decision).toBe('skipped');
    expect(C.stoppedBeforeStart).toBeUndefined();
    expect(r.degradationMarkers?.map(m => m.code) ?? []).not.toContain('execution.child-crashed');
    expect(r.decision).toBe('BLOCK');
  });
});
