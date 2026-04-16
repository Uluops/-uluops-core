import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { WorkflowDefinition } from '../../src/types/workflow.js';
import { WorkflowError } from '../../src/errors/index.js';
import { makeCommandResult, makeCommandExecutor, makeRegistry } from './fixtures.js';

/**
 * Creates a CommandExecutor that dispatches results by command name.
 * Unlike the queue-based makeCommandExecutor, this returns deterministic
 * results regardless of execution order — essential for parallel tests.
 */
function makeNamedCommandExecutor(
  resultMap: Record<string, Partial<Parameters<typeof makeCommandResult>[0]>>,
  opts?: { delayMs?: Record<string, number> },
): CommandExecutor {
  return {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition) => {
      const delay = opts?.delayMs?.[resolved.name];
      if (delay) await new Promise(r => setTimeout(r, delay));
      const overrides = resultMap[resolved.name] ?? {};
      return makeCommandResult({ name: resolved.name, ...overrides });
    }),
  } as unknown as CommandExecutor;
}

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

      expect(registry.resolve).toHaveBeenCalledWith('code-validator', undefined);
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

    it('passes when score equals threshold exactly (>= boundary)', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 70 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });
      expect(result.phases[0]!.decision).toBe('passed');
    });

    it('blocks when score is one below threshold', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 69 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'validate', name: 'Validation', commands: ['cmd'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });
      expect(result.phases[0]!.decision).toBe('blocked');
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
      const rec = { agent: 'test', title: 'Duplicate Issue', priority: 'suggested' as const, filePath: 'src/a.ts', lineNumber: 10 };
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
        expect(we.context!.partialResult!.name).toBe('test-workflow');
        expect(we.context!.partialResult!.type).toBe('workflow');
        expect(we.context!.partialResult!.definitionHash).toBe('sha256:wf');
        expect(we.context!.partialResult!.phases).toBeDefined();
        expect(Array.isArray(we.context!.partialResult!.phases)).toBe(true);
        expect(we.context!.partialResult!.recommendations).toBeDefined();
        expect(Array.isArray(we.context!.partialResult!.recommendations)).toBe(true);
        expect(typeof we.context!.partialResult!.durationMs).toBe('number');
      }
    });
  });

  // ─── DAG Parallel Execution ─────────────────────────────────────────────

  describe('DAG parallel execution', () => {
    it('executes independent phases in parallel (same topological level)', async () => {
      const executionOrder: string[] = [];
      const cmdExec = {
        execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition) => {
          executionOrder.push(resolved.name);
          // Small delay to verify concurrency
          await new Promise(r => setTimeout(r, 10));
          return makeCommandResult({ name: resolved.name, score: 85 });
        }),
      } as unknown as CommandExecutor;
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'Phase A', commands: ['cmd-a'] },
            { id: 'b', name: 'Phase B', commands: ['cmd-b'] },
            { id: 'c', name: 'Phase C', commands: ['cmd-c'] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // All three are independent — all in level 0, all executed
      expect(result.phases).toHaveLength(3);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
      expect(cmdExec.execute).toHaveBeenCalledTimes(3);
    });

    it('respects dependency ordering across levels', async () => {
      const levelTimestamps: Record<string, number> = {};
      const cmdExec = {
        execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition) => {
          levelTimestamps[resolved.name] = Date.now();
          return makeCommandResult({ name: resolved.name, score: 85 });
        }),
      } as unknown as CommandExecutor;
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      // a,b are independent (level 0); c depends on both (level 1)
      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'] },
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a', 'b'] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(3);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
      // c must start after both a and b complete
      expect(levelTimestamps['cmd-c']!).toBeGreaterThanOrEqual(levelTimestamps['cmd-a']!);
      expect(levelTimestamps['cmd-c']!).toBeGreaterThanOrEqual(levelTimestamps['cmd-b']!);
    });

    it('handles diamond dependency pattern', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 90 },
        'cmd-b': { score: 85 },
        'cmd-c': { score: 80 },
        'cmd-d': { score: 75 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      // Diamond: a -> b,c -> d
      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a'] },
            { id: 'd', name: 'D', commands: ['cmd-d'], depends_on: ['b', 'c'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(4);
      expect(result.phases.map(p => p.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
    });

    it('skips downstream phases when upstream blocks in diamond', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 90 },
        'cmd-b': { score: 40 },  // fails gate
        'cmd-c': { score: 80 },
        'cmd-d': { score: 75 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a'] },
            { id: 'd', name: 'D', commands: ['cmd-d'], depends_on: ['b', 'c'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(4);
      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('passed');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'c')!.decision).toBe('passed');
      // d depends on b (blocked) AND c (passed) → skipped
      expect(result.phases.find(p => p.id === 'd')!.decision).toBe('skipped');
    });

    it('throws on cyclic dependencies', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], depends_on: ['b'] },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'stop',
        },
      });

      await expect(executor.execute(def, { target: '/tmp/test' }))
        .rejects.toThrow('Cycle detected');
    });

    it('throws on non-existent dependency', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], depends_on: ['nonexistent'] },
          ],
          on_failure: 'stop',
        },
      });

      await expect(executor.execute(def, { target: '/tmp/test' }))
        .rejects.toThrow('does not exist');
    });
  });

  // ─── Failure Behaviors (Claims 2, 19) ───────────────────────────────────

  describe('failure behaviors', () => {
    it('stop: finishes current level, skips subsequent levels', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },  // fails gate
        'cmd-b': { score: 90 },  // same level as a — should still execute
        'cmd-c': { score: 85 },  // next level — should be skipped
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'] },  // same level (no deps)
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a', 'b'] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(3);
      // a and b are same level — both execute
      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('passed');
      // c is next level — skipped due to stop
      expect(result.phases.find(p => p.id === 'c')!.decision).toBe('skipped');
      expect(result.decision).toBe('BLOCK');
    });

    it('abort: skips all subsequent levels immediately', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },  // fails gate
        'cmd-b': { score: 90 },
        'cmd-c': { score: 85 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'] },
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a', 'b'] },
          ],
          on_failure: 'abort',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(3);
      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('passed');
      // c skipped due to abort
      expect(result.phases.find(p => p.id === 'c')!.decision).toBe('skipped');
      expect(result.decision).toBe('BLOCK');
    });

    it('continue: proceeds past failures, dependent phases check deps', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },  // fails gate
        'cmd-b': { score: 90 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.decision).toBe('blocked');
      // b depends on blocked a → skipped by dependency check
      expect(result.phases[1]!.decision).toBe('skipped');
    });

    it('continue: independent downstream phases still execute', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'] },  // no depends_on → independent
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('blocked');
      // b is independent of a — should still execute
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('passed');
    });

    it('warn: downgrades blocked to warned, proceeds normally', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'warn',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      // a was blocked but downgraded to warned by on_failure: 'warn'
      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('warned');
      // b depends on a — warned deps satisfy dependency check
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('passed');
      expect(result.decision).toBe('HOLD');  // warned → HOLD
    });

    it('stop vs abort: stop allows same-level phases, abort is identical for sequential deps', async () => {
      // This test verifies stop and abort diverge when phases are in the same level
      // With three sequential levels: a -> b -> c, stop and abort behave identically
      // The difference is visible when same-level phases exist (tested in stop/abort tests above)

      // Sequential chain with stop
      const cmdExecStop = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const defStop = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'stop',
        },
      });
      const resultStop = await new WorkflowExecutor(cmdExecStop, makeRegistry()).execute(defStop, { target: '/tmp/test' });

      // Sequential chain with abort
      const cmdExecAbort = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const defAbort = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'abort',
        },
      });
      const resultAbort = await new WorkflowExecutor(cmdExecAbort, makeRegistry()).execute(defAbort, { target: '/tmp/test' });

      // Both produce same result for linear chains
      expect(resultStop.phases.map(p => p.decision)).toEqual(resultAbort.phases.map(p => p.decision));
    });

    it('gate on_fail: warn produces warned decision at phase level', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 50 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd'], gate: { threshold: 70, aggregate: 'average', on_fail: 'warn' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('warned');
      expect(result.decision).toBe('HOLD');
    });

    it('gate on_fail: abort produces blocked decision', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 50 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd'], gate: { threshold: 70, aggregate: 'average', on_fail: 'abort' } },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('blocked');
      expect(result.decision).toBe('BLOCK');
    });
  });

  // ─── max_parallel Concurrency Limit ─────────────────────────────────────

  describe('max_parallel', () => {
    it('limits concurrent phase execution', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const cmdExec = {
        execute: vi.fn().mockImplementation(async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise(r => setTimeout(r, 20));
          currentConcurrent--;
          return makeCommandResult({ score: 85 });
        }),
      } as unknown as CommandExecutor;
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'] },
            { id: 'c', name: 'C', commands: ['cmd-c'] },
            { id: 'd', name: 'D', commands: ['cmd-d'] },
          ],
          on_failure: 'stop',
          max_parallel: 2,
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(4);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
      // With max_parallel: 2, no more than 2 should run simultaneously
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('runs all phases when max_parallel exceeds phase count', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 90 },
        'cmd-b': { score: 85 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'] },
          ],
          on_failure: 'stop',
          max_parallel: 10,
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(2);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
    });
  });

  // ─── Aborted Phase Metrics ──────────────────────────────────────────────

  describe('aborted phase metrics', () => {
    it('tracks phasesAborted count in metrics', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.metrics.phasesBlocked).toBe(1);
      expect(result.metrics.phasesSkipped).toBe(1);
      expect(result.metrics.phasesAborted).toBe(0);
      expect(result.metrics.phasesExecuted).toBe(1);
    });
  });

  describe('aborted phase in aggregate path', () => {
    it('excludes aborted phases from score calculation and produces BLOCK decision', async () => {
      // Phase a scores 40 (blocked), phase b scores 90 (passed), phase c is skipped by abort.
      // With abort behavior, c should be skipped. The aggregate should only consider
      // phases that actually ran (a=40, b=90). Since hasAborted is true → BLOCK.
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'abort' } },
            { id: 'b', name: 'B', commands: ['cmd-b'] },
            { id: 'c', name: 'C', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'abort',
        },
        aggregation: {
          score: { method: 'weighted_average', weights: { a: 1, b: 1, c: 1 } },
          decision: { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' },
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // c is skipped (abort) — its score should not factor into aggregate
      expect(result.phases.find(p => p.id === 'c')!.decision).toBe('skipped');
      // Score should be average of a (40) and b (90) only = 65, not diluted by c's zero
      expect(result.score).toBe(65);
      // Decision is BLOCK because phase a was blocked
      expect(result.decision).toBe('BLOCK');
    });
  });

  // ─── Complex DAG Scenarios ──────────────────────────────────────────────

  describe('complex DAG scenarios', () => {
    it('wide fan-out: many independent phases all execute', async () => {
      const phases = Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        name: `Phase ${i}`,
        commands: [`cmd-${i}`],
      }));

      const resultMap: Record<string, { score: number }> = {};
      for (let i = 0; i < 6; i++) resultMap[`cmd-${i}`] = { score: 80 + i };

      const cmdExec = makeNamedCommandExecutor(resultMap);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: { phases, on_failure: 'stop' },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(6);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
      expect(cmdExec.execute).toHaveBeenCalledTimes(6);
    });

    it('mixed independent and dependent phases at multiple levels', async () => {
      // Level 0: a, b (independent)
      // Level 1: c depends on a, d depends on b
      // Level 2: e depends on c and d
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 90 },
        'cmd-b': { score: 85 },
        'cmd-c': { score: 80 },
        'cmd-d': { score: 75 },
        'cmd-e': { score: 70 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'] },
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a'] },
            { id: 'd', name: 'D', commands: ['cmd-d'], depends_on: ['b'] },
            { id: 'e', name: 'E', commands: ['cmd-e'], depends_on: ['c', 'd'] },
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(5);
      expect(result.phases.every(p => p.decision === 'passed')).toBe(true);
      expect(result.score).toBe(80); // average of 90,85,80,75,70 = 80
    });

    it('failure in middle of diamond blocks only downstream deps', async () => {
      // a -> b(fail), c -> d (depends on b,c — skipped)
      // e is independent of everything
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 90 },
        'cmd-b': { score: 30 },  // fails
        'cmd-c': { score: 80 },
        'cmd-d': { score: 75 },
        'cmd-e': { score: 95 },
      });
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a'] },
            { id: 'd', name: 'D', commands: ['cmd-d'], depends_on: ['b', 'c'] },
            { id: 'e', name: 'E', commands: ['cmd-e'] },  // independent
          ],
          on_failure: 'continue',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('passed');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'c')!.decision).toBe('passed');
      expect(result.phases.find(p => p.id === 'd')!.decision).toBe('skipped');  // blocked dep
      expect(result.phases.find(p => p.id === 'e')!.decision).toBe('passed');   // independent
    });

    it('single phase still works (degenerate DAG)', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 92 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [{ id: 'only', name: 'Only Phase', commands: ['cmd'] }],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.score).toBe(92);
    });

    it('empty phases array produces SHIP with score 0', async () => {
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [],
          on_failure: 'stop',
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases).toHaveLength(0);
      expect(result.score).toBe(0);
      expect(result.decision).toBe('SHIP');
    });

    it('phase-level error produces blocked result, does not crash workflow', async () => {
      const cmdExec = {
        execute: vi.fn()
          .mockResolvedValueOnce(makeCommandResult({ name: 'cmd-a', score: 85 }))
          .mockRejectedValueOnce(new Error('Network timeout'))
          .mockResolvedValueOnce(makeCommandResult({ name: 'cmd-c', score: 90 })),
      } as unknown as CommandExecutor;
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'] },
            { id: 'b', name: 'B', commands: ['cmd-b'] },  // will fail
            { id: 'c', name: 'C', commands: ['cmd-c'], depends_on: ['a'] },
          ],
          on_failure: 'continue',
        },
      });

      // a and b are level 0 (parallel) — b's error is caught by Promise.allSettled
      // c is level 1, depends only on a (passed)
      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('passed');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'c')!.decision).toBe('passed');
    });
  });
});
