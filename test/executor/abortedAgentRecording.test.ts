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
