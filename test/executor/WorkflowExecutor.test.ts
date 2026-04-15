import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { WorkflowDefinition } from '../../src/types/workflow.js';
import { WorkflowError } from '../../src/errors/index.js';
import { makeCommandResult, makeCommandExecutor, makeRegistry } from './fixtures.js';

function makeWorkflowDef(overrides?: Partial<WorkflowDefinition['workflow']>): ResolvedDefinition {
  return {
    type: 'workflow',
    name: 'test-workflow',
    version: '1.0.0',
    hash: 'sha256:wf',
    yaml: '',
    definition: {
      workflow: {
        interface: {
          name: 'test-workflow',
          version: '1.0.0',
          displayName: 'Test Workflow',
          description: 'A test workflow',
          domain: 'software',
        },
        orchestration: {
          phases: [
            {
              id: 'validate',
              name: 'Validation',
              commands: ['code-validator'],
              gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' },
            },
          ],
          on_failure: 'stop',
        },
        aggregation: {
          score: { method: 'average' },
          decision: { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' },
        },
        ...overrides,
      },
    } as ResolvedDefinition['definition'],
    runtime: {} as ResolvedDefinition['runtime'],
    domain: 'software',
  };
}

describe('WorkflowExecutor', () => {
  describe('single-phase execution', () => {
    it('executes a single phase and returns workflow result', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 90 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const result = await executor.execute(
        makeWorkflowDef(),
        { target: '/tmp/test' },
      );

      expect(result.type).toBe('workflow');
      expect(result.name).toBe('test-workflow');
      expect(result.version).toBe('1.0.0');
      expect(result.definitionHash).toBe('sha256:wf');
      expect(result.decision).toBe('SHIP');
      expect(result.score).toBe(90);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.decision).toBe('passed');
    });

    it('resolves commands via registry', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      await executor.execute(makeWorkflowDef(), { target: '/tmp/test' });

      expect(registry.resolve).toHaveBeenCalledWith('code-validator');
    });
  });

  describe('multi-phase execution', () => {
    it('executes phases in order', async () => {
      const results = [
        makeCommandResult({ name: 'validator-a', score: 80 }),
        makeCommandResult({ name: 'validator-b', score: 90 }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'phase-1', name: 'Phase 1', commands: ['validator-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'phase-2', name: 'Phase 2', commands: ['validator-b'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.phases[1]!.decision).toBe('passed');
      expect(result.decision).toBe('SHIP');
      expect(result.score).toBe(85); // average of 80 and 90
    });

    it('stops on failure when on_failure is stop (dependent phases skipped)', async () => {
      const results = [
        makeCommandResult({ name: 'validator-a', score: 40 }), // Below threshold
        makeCommandResult({ name: 'validator-b', score: 90 }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'phase-1', name: 'Phase 1', commands: ['validator-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'phase-2', name: 'Phase 2', commands: ['validator-b'], depends_on: ['phase-1'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2); // Phase 2 skipped due to stop
      expect(result.phases[0]!.decision).toBe('blocked');
      expect(result.phases[1]!.decision).toBe('skipped');
      expect(result.decision).toBe('BLOCK');
    });

    it('continues on failure when on_failure is continue', async () => {
      const results = [
        makeCommandResult({ name: 'validator-a', score: 40 }),
        makeCommandResult({ name: 'validator-b', score: 90 }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'phase-1', name: 'Phase 1', commands: ['validator-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'phase-2', name: 'Phase 2', commands: ['validator-b'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2); // Both phases executed
      expect(result.phases[0]!.decision).toBe('blocked');
      expect(result.phases[1]!.decision).toBe('passed');
    });
  });

  describe('gate evaluation', () => {
    it('warns when gate on_fail is warn', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 50 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd'], gate: { threshold: 70, aggregate: 'average', on_fail: 'warn' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('warned');
      expect(result.decision).toBe('HOLD');
    });

    it('passes when no gate is defined', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 30 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd'] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('passed');
    });
  });

  describe('phase dependencies', () => {
    it('skips phase when dependency is blocked', async () => {
      const results = [
        makeCommandResult({ score: 40 }), // Phase 1 will be blocked
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'phase-1', name: 'Phase 1', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'phase-2', name: 'Phase 2', commands: ['cmd-b'], depends_on: ['phase-1'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.decision).toBe('blocked');
      expect(result.phases[1]!.decision).toBe('skipped');
    });

    it('executes phase when dependency passed', async () => {
      const results = [
        makeCommandResult({ score: 85 }),
        makeCommandResult({ score: 90 }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'phase-1', name: 'Phase 1', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'phase-2', name: 'Phase 2', commands: ['cmd-b'], depends_on: ['phase-1'] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.phases[1]!.decision).toBe('passed');
    });
  });

  describe('skip conditions', () => {
    it('skips phase when skip_if evaluates to true', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd'], skip_if: '{{ input.skipValidation }}' },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(
        def,
        { target: '/tmp/test', options: { skipValidation: true } },
      );

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.decision).toBe('skipped');
    });

    it('does not skip when condition is falsy', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult()]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd'], skip_if: '{{ input.skipValidation }}' },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(
        def,
        { target: '/tmp/test', options: { skipValidation: false } },
      );

      expect(result.phases[0]!.decision).toBe('passed');
    });
  });

  describe('parallel execution', () => {
    it('executes commands in parallel when parallel is true', async () => {
      const results = [
        makeCommandResult({ name: 'cmd-a', score: 80 }),
        makeCommandResult({ name: 'cmd-b', score: 90 }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd-a', 'cmd-b'], parallel: true, gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.commands).toHaveLength(2);
      expect(result.phases[0]!.score).toBe(85); // average
      expect(cmdExec.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('aggregation', () => {
    it('uses weighted scores across phases', async () => {
      const results = [
        makeCommandResult({ score: 100 }),
        makeCommandResult({ score: 50 }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'phase-1', name: 'Phase 1', commands: ['cmd-a'] },
            { id: 'phase-2', name: 'Phase 2', commands: ['cmd-b'] },
          ],
          on_failure: 'continue',
        },
        aggregation: {
          score: { method: 'weighted_average', weights: { 'phase-1': 3, 'phase-2': 1 } },
          decision: { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' },
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.score).toBe(88); // round((100*3 + 50*1) / 4) = 87.5 → 88
    });

    it('uses custom decision labels', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 90 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        aggregation: {
          score: { method: 'average' },
          decision: { SHIP: 'DEPLOY', HOLD: 'REVIEW', BLOCK: 'REJECT' },
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.decision).toBe('DEPLOY');
    });
  });

  describe('recommendation deduplication', () => {
    it('deduplicates recommendations by title+filePath+lineNumber', async () => {
      const rec = { validator: 'test', title: 'Duplicate Issue', priority: 'suggested' as const, filePath: 'src/a.ts', lineNumber: 10 };
      const results = [
        makeCommandResult({ recommendations: [rec, { ...rec }] }),
        makeCommandResult({ recommendations: [rec] }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'p1', name: 'P1', commands: ['cmd-a'] },
            { id: 'p2', name: 'P2', commands: ['cmd-b'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // All 3 have same key, so should deduplicate to 1
      expect(result.recommendations).toHaveLength(1);
    });
  });

  describe('metrics', () => {
    it('accumulates token metrics across phases', async () => {
      const results = [
        makeCommandResult({
          metrics: { inputTokens: 500, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 25, totalEffectiveTokens: 750, durationMs: 1000, model: 'sonnet', toolCalls: 3 },
        }),
        makeCommandResult({
          metrics: { inputTokens: 300, outputTokens: 100, cacheCreationTokens: 30, cacheReadTokens: 10, totalEffectiveTokens: 430, durationMs: 800, model: 'sonnet', toolCalls: 2 },
        }),
      ];
      const cmdExec = makeCommandExecutor(results);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'p1', name: 'P1', commands: ['cmd-a'] },
            { id: 'p2', name: 'P2', commands: ['cmd-b'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.metrics.inputTokens).toBe(800);
      expect(result.metrics.outputTokens).toBe(300);
      expect(result.metrics.cacheCreationTokens).toBe(80);
      expect(result.metrics.cacheReadTokens).toBe(35);
      expect(result.metrics.phasesExecuted).toBe(2);
      expect(result.metrics.phasesPassed).toBe(2);
      expect(result.metrics.phasesSkipped).toBe(0);
    });
  });

  describe('empty phase/stage edge cases', () => {
    it('phase with empty commands array returns score 0', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'empty', name: 'Empty Phase', commands: [] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.score).toBe(0);
      expect(result.phases[0]!.commands).toHaveLength(0);
      expect(cmdExec.execute).not.toHaveBeenCalled();
    });

    it('empty commands phase with gate blocks at threshold', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'empty', name: 'Empty Phase', commands: [], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('blocked');
      expect(result.decision).toBe('BLOCK');
    });

    it('all phases skipped results in SHIP decision with score 0', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'p1', name: 'Phase 1', commands: ['cmd-a'], skip_if: '{{ input.skip }}' },
            { id: 'p2', name: 'Phase 2', commands: ['cmd-b'], skip_if: '{{ input.skip }}' },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(
        def,
        { target: '/tmp/test', options: { skip: true } },
      );

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.decision).toBe('skipped');
      expect(result.phases[1]!.decision).toBe('skipped');
      expect(result.score).toBe(0);
      expect(result.decision).toBe('SHIP');
      expect(result.metrics.phasesSkipped).toBe(2);
      expect(result.metrics.phasesExecuted).toBe(0);
    });

    it('empty commands phase does not produce recommendations', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'empty', name: 'Empty', commands: [] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.recommendations).toHaveLength(0);
      expect(result.metrics.inputTokens).toBe(0);
      expect(result.metrics.outputTokens).toBe(0);
    });

    it('empty commands phase with no gate passes', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'empty', name: 'Empty', commands: [] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // No gate defined → evaluateGate returns 'passed' regardless of score
      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.decision).toBe('SHIP');
    });

    it('mix of skipped and empty phases produces correct metrics', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 80 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'skip', name: 'Skipped', commands: ['cmd-a'], skip_if: '{{ input.skip }}' },
            { id: 'run', name: 'Runs', commands: ['cmd-b'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(
        def,
        { target: '/tmp/test', options: { skip: true } },
      );

      expect(result.phases[0]!.decision).toBe('skipped');
      expect(result.phases[1]!.decision).toBe('passed');
      expect(result.metrics.phasesSkipped).toBe(1);
      expect(result.metrics.phasesExecuted).toBe(1);
      expect(result.metrics.phasesPassed).toBe(1);
      expect(result.score).toBe(80); // Only non-skipped phase counts
    });
  });

  describe('error handling', () => {
    it('throws WorkflowError with partial result on command failure', async () => {
      const cmdExec = {
        execute: vi.fn().mockRejectedValue(new Error('Agent timeout')),
      } as unknown as CommandExecutor;
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      try {
        await executor.execute(makeWorkflowDef(), { target: '/tmp/test' });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowError);
        const we = error as WorkflowError;
        expect(we.message).toContain('Agent timeout');
        expect(we.context?.partialResult).toBeDefined();
      }
    });
  });
});
