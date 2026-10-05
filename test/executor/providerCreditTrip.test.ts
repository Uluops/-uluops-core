/**
 * A provider 402 stops the whole pipeline run (OpenRouter plan D13, slice 1d).
 *
 * Real PipelineExecutor and WorkflowExecutor, so the run signal is forwarded through actual code.
 * The command executor stands in for the agent → AIProvider hop and does exactly what
 * AIProvider.handleGenerateError does on a mapped 402: `tripRunFor(callerSignal, message)`, then
 * throw the typed error. (AgentExecutor forwarding the signal into generate() has its own test;
 * AIProvider tripping a registered signal on a real mapped 402 is tested in AIProvider.test.ts.)
 *
 * NEGATIVE CONTROL: against 0.47.0 (no registry, no trip) the later stage runs, the in-flight
 * sibling is never aborted, and the run is not `cancelled`.
 */
import { describe, it, expect, vi } from 'vitest';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { ProviderCreditError, CancelledError } from '../../src/errors/index.js';
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
  const seen = { siblingAborted: false, laterStarted: false };
  const cmdExec = {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, _input: unknown, options?: ExecutionOptions) => {
      const signal = options?.abortSignal;
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

describe('provider 402 stops a nested pipeline run (D13)', () => {
  it('cancels the run: later stages never start, the in-flight sibling is aborted, wait() does not throw', async () => {
    const { executor, seen } = harness();
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    const result = await handle.wait();

    expect(result.status).toBe('cancelled');
    expect(seen.siblingAborted).toBe(true);
    expect(seen.laterStarted).toBe(false);
    expect(result.stages[1]!.status).toBe('skipped');
    // The reason is the provider's own text, carried on the stage that hit it.
    expect(result.stages[0]!.skipReason).toContain('can only afford 83666');
    expect(JSON.stringify(await handle.status())).not.toContain('cancelled by user');
  });

  it('a hop that wraps the signal makes the lookup miss: the run is NOT cancelled (proves the test can fail)', async () => {
    const { executor, seen } = harness({ wrap: true });
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    const result = await handle.wait().catch(e => (e as { context?: { partialResult?: { status: string } } }).context?.partialResult);

    expect(result?.status).not.toBe('cancelled');
    expect(seen.siblingAborted).toBe(false);
  });

  it('handle.cancel() is unchanged: cancelled, user reason, in-flight work aborted', async () => {
    const { executor, seen } = harness();
    const handle = await executor.start(pipelineDef(), { target: '/tmp/test' });
    // Cancel before the 402 lands (it fires 20 ms in).
    await new Promise(r => setTimeout(r, 5));
    await handle.cancel();
    const result = await handle.wait();
    expect(result.status).toBe('cancelled');
    expect(seen.siblingAborted).toBe(true);
    expect(seen.laterStarted).toBe(false);
  });
});
