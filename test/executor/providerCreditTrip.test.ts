/**
 * A provider 402 stops the whole pipeline run (OpenRouter plan D13, slice 1d).
 *
 * Real PipelineExecutor and WorkflowExecutor, so the run signal is forwarded through actual code.
 * The command executor stands in for the agent → AIProvider hop and does exactly what
 * AIProvider.handleGenerateError does on a mapped 402: `tripRunFor(callerSignal, message)`, then
 * throw the typed error. (AgentExecutor forwarding the signal into generate() has its own test;
 * AIProvider tripping a registered signal on a real mapped 402 is tested in AIProvider.test.ts.)
 *
 * The run ends `failed`, not `cancelled` (plan v0.6.3, Alex 2026-10-05; crew run #107): nobody
 * chose to stop it, so wait() throws a PipelineError whose message is the provider's text.
 *
 * NEGATIVE CONTROL: against 0.47.0 (no registry, no trip) the later stage runs and the in-flight
 * sibling is never aborted.
 */
import { describe, it, expect, vi } from 'vitest';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { ProviderCreditError, CancelledError, PipelineError } from '../../src/errors/index.js';
import { tripRunFor } from '../../src/utils/runTrip.js';
import type { ExecutionOptions } from '../../src/types/execution.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { WorkflowDefinition } from '../../src/types/workflow.js';
import type { PipelineDefinition } from '../../src/types/pipeline.js';
import { makeCommandResult, makeRegistry } from './fixtures.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const CREDIT = 'Out of credit with provider "openrouter" (HTTP 402). Provider message: can only afford 83666';

const workflowDef = (): ResolvedDefinition => ({
  type: 'workflow', name: 'ship', version: '1.0.0', hash: 'sha256:wf', yaml: '', domain: 'software',
  runtime: {} as ResolvedDefinition['runtime'],
  definition: {
    workflow: {
      interface: { name: 'ship', version: '1.0.0', displayName: 'Ship', description: 'd', domain: 'software' },
      orchestration: {
        phases: [{ id: 'checks', name: 'Checks', commands: ['credit-cmd', 'sibling-cmd'], parallel: true,
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } }],
        on_failure: 'continue',
      },
      aggregation: { score: { method: 'average' }, decision: { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' } },
    },
  } as unknown as WorkflowDefinition,
});

const pipelineDef = (): ResolvedDefinition => ({
  type: 'pipeline', name: 'p', version: '1.0.0', hash: 'sha256:p', yaml: '', domain: 'software',
  runtime: {} as ResolvedDefinition['runtime'],
  definition: {
    pipeline: {
      interface: { name: 'p', version: '1.0.0', displayName: 'P', description: 'd', domain: 'software' },
      stages: [
        { id: 'stage-1', name: 'Workflow', type: 'workflow', ref: 'ship@1.0.0' },
        { id: 'stage-2', name: 'Later', type: 'command', ref: 'later@1.0.0' },
      ],
    },
  } as unknown as PipelineDefinition,
});

/**
 * `wrap` simulates a hop that wraps the signal instead of forwarding it: the lookup misses.
 * The sibling settles on its own after a while, so a run that is NOT stopped still finishes.
 */
function harness(opts: { wrap?: boolean } = {}) {
  const seen = { siblingAborted: false, laterStarted: false, signal: undefined as AbortSignal | undefined };
  const cmdExec = {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, _input: unknown, options?: ExecutionOptions) => {
      const signal = options?.abortSignal;
      seen.signal ??= signal;
      if (resolved.name === 'credit-cmd') {
        await new Promise(r => setTimeout(r, 20)); // let the sibling get in flight first
        tripRunFor(opts.wrap && signal ? AbortSignal.any([signal]) : signal, CREDIT);
        throw new ProviderCreditError(CREDIT, 'openrouter', 'openrouter_key_limit');
      }
      if (resolved.name === 'sibling-cmd') {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(makeCommandResult({ name: 'sibling-cmd' })), 300);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            seen.siblingAborted = true;
            reject(new CancelledError('aborted'));
          }, { once: true });
        });
      }
      seen.laterStarted = true;
      return makeCommandResult({ name: resolved.name });
    }),
  } as unknown as CommandExecutor;
  const registry = makeRegistry({ ship: workflowDef(), 'ship@1.0.0': workflowDef() });
  const executor = new PipelineExecutor(
    new WorkflowExecutor(cmdExec, registry, undefined, noopLogger), cmdExec, {} as AgentExecutor, registry, noopLogger,
  );
  return { executor, seen };
}

/** The partial result a stopped run carries on its thrown PipelineError. */
type Thrown = { message: string; context?: { partialResult?: { status: string; decisionCategory?: string; stages: Array<{ status: string; skipReason?: string }> } } };
const settle = (p: Promise<unknown>) => p.then(r => ({ resolved: r as { status: string }, thrown: undefined }), (e: unknown) => ({ resolved: undefined, thrown: e as Thrown }));

describe('provider 402 stops a pipeline run (D13, ending failed)', () => {
  it('fails the run with the provider text: later stages skipped, in-flight sibling aborted', async () => {
    const { executor, seen } = harness();
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    const { resolved, thrown } = await settle(handle.wait());

    expect(resolved).toBeUndefined();
    expect(thrown).toBeInstanceOf(PipelineError);
    // The reason is the thrown message — for every topology, not just one stage shape.
    expect(thrown!.message).toContain('can only afford 83666');
    const partial = thrown!.context!.partialResult!;
    expect(partial.status).toBe('failed');
    expect(partial.decisionCategory).toBe('negative');
    expect(partial.stages[1]!.status).toBe('skipped');
    expect(partial.stages[1]!.skipReason).toContain('can only afford 83666');
    expect(seen.siblingAborted).toBe(true);
    expect(seen.laterStarted).toBe(false);
  });

  it('a hop that wraps the signal makes the lookup miss: the run is not stopped (proves the test can fail)', async () => {
    const { executor, seen } = harness({ wrap: true });
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    await settle(handle.wait());
    expect(seen.siblingAborted).toBe(false);
    expect(seen.laterStarted).toBe(true);
  });

  it('handle.cancel() is unchanged: cancelled, wait() resolves, in-flight work aborted', async () => {
    const { executor, seen } = harness();
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    await new Promise(r => setTimeout(r, 5)); // before the 402 lands at 20 ms
    await handle.cancel();
    const { resolved, thrown } = await settle(handle.wait());
    expect(thrown).toBeUndefined();
    expect(resolved!.status).toBe('cancelled');
    expect(seen.siblingAborted).toBe(true);
    expect(seen.laterStarted).toBe(false);
  });

  it('a 402 after a user cancel keeps the cancel: the trip reports it did nothing', async () => {
    const { executor, seen } = harness();
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    expect(tripRunFor(seen.signal, CREDIT)).toBe(false);
    const { resolved } = await settle(handle.wait());
    expect(resolved!.status).toBe('cancelled');
  });

  it('a trip after the run settled changes nothing and reports false', async () => {
    const { executor, seen } = harness();
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    await settle(handle.wait());
    const before = (await handle.status()).status;
    expect(tripRunFor(seen.signal, 'late')).toBe(false);
    expect((await handle.status()).status).toBe(before);
  });
});

/**
 * The same stop in an inline-agents stage (F3/F5 of crew #107): agents run through
 * Promise.allSettled and the stage itself does not throw, so the reason must come from the
 * run, not from a stage error.
 */
describe('provider 402 in an inline-agents stage', () => {
  it('fails the run with the provider text and skips the next stage', async () => {
    const seen = { siblingAborted: false, laterStarted: false };
    const agentExec = {
      execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, _i: unknown, options?: ExecutionOptions) => {
        const signal = options?.abortSignal;
        if (resolved.name === 'pricey') {
          await new Promise(r => setTimeout(r, 20));
          tripRunFor(signal, CREDIT);
          throw new ProviderCreditError(CREDIT, 'openrouter');
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { seen.siblingAborted = true; reject(new CancelledError('aborted')); }, { once: true });
        });
      }),
    } as unknown as AgentExecutor;
    const cmdExec = { execute: vi.fn().mockImplementation(async () => { seen.laterStarted = true; return makeCommandResult(); }) } as unknown as CommandExecutor;
    const registry = makeRegistry({ pricey: { ...workflowDef(), type: 'agent', name: 'pricey' }, steady: { ...workflowDef(), type: 'agent', name: 'steady' } });
    const executor = new PipelineExecutor(new WorkflowExecutor(cmdExec, registry), cmdExec, agentExec, registry, noopLogger);
    const def = pipelineDef();
    (def.definition as unknown as PipelineDefinition).pipeline.stages = [
      { id: 'panel', name: 'Panel', type: 'agents', agents: [{ ref: 'pricey' }, { ref: 'steady' }] },
      { id: 'later', name: 'Later', type: 'command', ref: 'later@1.0.0' },
    ] as never;

    const handle = await executor.start(def, { target: '/tmp/test' });
    const { thrown } = await settle(handle.wait());
    expect(thrown).toBeInstanceOf(PipelineError);
    expect(thrown!.message).toContain('can only afford 83666');
    expect(seen.siblingAborted).toBe(true);
    expect(seen.laterStarted).toBe(false);
  });
});
