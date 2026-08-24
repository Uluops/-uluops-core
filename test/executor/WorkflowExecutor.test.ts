import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { WorkflowDefinition, WorkflowResult } from '../../src/types/workflow.js';
import type { CommandDefinition } from '../../src/types/command.js';
import type { AgentDefinition } from '../../src/types/agent.js';
import type { RegistryClient } from '../../src/registry/RegistryClient.js';
import { WorkflowError, ConfigurationError, MaxStepsExhaustedError } from '../../src/errors/index.js';
import { makeCommandResult, makeCommandExecutor, makeNamedCommandExecutor, makeRegistry, makeAgentExecutor, makeValidatorResult } from './fixtures.js';

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
    } as WorkflowDefinition,
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

      // Command steps resolve with an explicit 'command' type (not untyped) so a
      // name that exists as both an agent and a command does not throw on
      // ambiguity. See the collision regression test below.
      expect(registry.resolve).toHaveBeenCalledWith('code-validator', undefined, 'command');
    });

    it('resolves a command-step whose name exists as BOTH an agent and a command (no ambiguity throw)', async () => {
      // Regression: cognitive-lens WDLs reference `command: <analyst>@latest`, but
      // `<analyst>` is published as both an agent AND its per-agent command. An
      // untyped resolve threw "Multiple definitions named X found", blocking every
      // phase. Command-first resolution must avoid that.
      const cmdExec = makeCommandExecutor([makeCommandResult({ name: 'aristotle-analyst', score: 88 })]);
      const registry = makeRegistry({
        'aristotle-analyst': {
          type: 'command', name: 'aristotle-analyst', version: '1.0.0', hash: 'sha256:c',
          yaml: '', definition: {} as CommandDefinition,
          runtime: {} as ResolvedDefinition['runtime'], domain: 'software',
        },
      });
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [{ id: 'aristotle', name: 'Aristotle', commands: ['aristotle-analyst@latest'], gate: { threshold: 70, aggregate: 'average', on_fail: 'warn' } }],
          on_failure: 'continue',
        },
      } as Partial<WorkflowDefinition['workflow']>);

      const result = await executor.execute(def, { target: '/tmp/test' });

      // parseRef normalizes `@latest` to undefined (resolve to current latest).
      expect(registry.resolve).toHaveBeenCalledWith('aristotle-analyst', undefined, 'command');
      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.phases[0]!.score).toBe(88);
    });

    it('falls back to the agent definition when a command-step name has no command', async () => {
      // command: ref that resolves only as an agent — resolve(type=command) throws
      // ConfigurationError, executeStep retries as an agent and runs it directly.
      const cmdExec = makeCommandExecutor();
      const agentExec = makeAgentExecutor([makeValidatorResult({
        name: 'agent-only', score: 77, decision: 'EXAMINED', decisionCategory: 'positive',
      })]);
      const agentDef: ResolvedDefinition = {
        type: 'agent', name: 'agent-only', version: '1.0.0', hash: 'sha256:a',
        yaml: '', definition: {} as Partial<AgentDefinition>,
        runtime: {} as ResolvedDefinition['runtime'], domain: 'software', agentType: 'validator',
      };
      const registry = {
        resolve: vi.fn().mockImplementation((name: string, _version?: string, type?: string) => {
          if (type === 'command') return Promise.reject(new ConfigurationError(`Definition "${name}" (command) not found in registry.`));
          return Promise.resolve(agentDef);
        }),
      } as unknown as RegistryClient;
      const executor = new WorkflowExecutor(cmdExec, registry, agentExec);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [{ id: 'p', name: 'P', commands: ['agent-only'], gate: { threshold: 70, aggregate: 'average', on_fail: 'warn' } }],
          on_failure: 'continue',
        },
      } as Partial<WorkflowDefinition['workflow']>);

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(registry.resolve).toHaveBeenCalledWith('agent-only', undefined, 'command');
      expect(registry.resolve).toHaveBeenCalledWith('agent-only', undefined, 'agent');
      expect(agentExec.execute).toHaveBeenCalled();
      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.phases[0]!.score).toBe(77);
      // wrapAgentResult threads the agent's raw decision AND its vocabulary-resolved
      // category into the phase command result — the category is the only gateable
      // signal for custom vocabularies like EXAMINED.
      expect(result.phases[0]!.commands[0]!.decision).toBe('EXAMINED');
      expect(result.phases[0]!.commands[0]!.decisionCategory).toBe('positive');
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

    it('blocks a phase whose scoreless child resolves negative (null score cannot pass the gate silently)', async () => {
      // A scoreless child is dropped by aggregatePhaseScore, and evaluateGate
      // passes a null score unconditionally — the categorical guard must gate it.
      const cmdExec = makeCommandExecutor([
        makeCommandResult({ decision: 'MUTILATED', decisionCategory: 'negative', score: null, maxScore: null }),
      ]);
      const executor = new WorkflowExecutor(cmdExec, makeRegistry());

      const result = await executor.execute(makeWorkflowDef(), { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('blocked');
      expect(result.decision).toBe('BLOCK');
      expect(result.decisionCategory).toBe('negative');
    });

    it('honors on_fail warn for a scoreless-negative child', async () => {
      const cmdExec = makeCommandExecutor([
        makeCommandResult({ decision: 'MUTILATED', decisionCategory: 'negative', score: null, maxScore: null }),
      ]);
      const executor = new WorkflowExecutor(cmdExec, makeRegistry());

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'gen', name: 'Generate', commands: ['cmd'], gate: { threshold: 70, aggregate: 'average', on_fail: 'warn' } },
          ],
          on_failure: 'continue',
        },
      });
      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('warned');
      expect(result.decision).toBe('HOLD');
      expect(result.decisionCategory).toBe('conditional');
    });

    it('caps a passed phase at warned when a scored child resolves negative (d60c2ea2 twin)', async () => {
      // DISORDERED@82: the score clears the gate threshold, but the declared
      // categorical negative may never launder into an unqualified pass.
      const cmdExec = makeCommandExecutor([
        makeCommandResult({ decision: 'DISORDERED', decisionCategory: 'negative', score: 82 }),
      ]);
      const executor = new WorkflowExecutor(cmdExec, makeRegistry());

      const result = await executor.execute(makeWorkflowDef(), { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('warned');
      expect(result.decision).toBe('HOLD');
      expect(result.decisionCategory).toBe('conditional');
    });

    it('still passes a phase whose scoreless child is positive', async () => {
      const cmdExec = makeCommandExecutor([
        makeCommandResult({ decision: 'PRESERVED', decisionCategory: 'positive', score: null, maxScore: null }),
      ]);
      const executor = new WorkflowExecutor(cmdExec, makeRegistry());

      const result = await executor.execute(makeWorkflowDef(), { target: '/tmp/test' });

      expect(result.phases[0]!.decision).toBe('passed');
      expect(result.decision).toBe('SHIP');
      expect(result.decisionCategory).toBe('positive');
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
      // The category derives from phase outcomes, not the remapped string —
      // 'DEPLOY' is unknowable to classifyDecision, so the stamp is load-bearing.
      expect(result.decisionCategory).toBe('positive');
    });

    it('stamps a negative decisionCategory on a blocked outcome with remapped labels', async () => {
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 40 })]);
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        aggregation: {
          score: { method: 'average' },
          decision: { SHIP: 'DEPLOY', HOLD: 'REVIEW', BLOCK: 'REJECTED' },
        },
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // score 40 < gate threshold 70 with on_fail 'stop' → blocked phase → BLOCK,
      // remapped to 'REJECTED'. Downstream gates (pipeline computeDecision) can only
      // recognize this as negative through the stamped category.
      expect(result.decision).toBe('REJECTED');
      expect(result.decisionCategory).toBe('negative');
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
        // Not an array on this path (the outer catch) — narrow before property access.
        expect(Array.isArray(we.context!.partialResult)).toBe(false);
        const partial = we.context!.partialResult as Partial<WorkflowResult>;
        expect(partial.name).toBe('test-workflow');
        expect(partial.type).toBe('workflow');
        expect(partial.definitionHash).toBe('sha256:wf');
        expect(partial.phases).toBeDefined();
        expect(Array.isArray(partial.phases)).toBe(true);
        expect(partial.recommendations).toBeDefined();
        expect(Array.isArray(partial.recommendations)).toBe(true);
        expect(typeof partial.durationMs).toBe('number');
      }
    });

    // NOTE on the CommandResult[] arm of the type (WorkflowExecutor.ts:356):
    // that WorkflowError is constructed inside executePhase(), but every path
    // that calls executePhase() catches it before it can reach a caller of
    // execute() — a single-phase level lets it propagate to execute()'s own
    // try/catch, which immediately REWRAPS it in a new WorkflowError carrying
    // buildPartialResult(...) (the object shape); a multi-phase level catches
    // it via createBlockedPhase() and never rethrows at all. So the array arm
    // is real (it IS constructed, and the type documents that), but it is not
    // observable through the public execute() API today — confirmed here by
    // asserting the wrapped behavior actually occurs, rather than asserting
    // the array shape a caller cannot obtain.
    it('rewraps an all-steps-failed WorkflowError into the phase-gate object shape (array arm never reaches execute() callers)', async () => {
      const cmdExec = {
        execute: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as CommandExecutor;
      const registry = makeRegistry();
      const executor = new WorkflowExecutor(cmdExec, registry);

      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            {
              id: 'validate',
              name: 'Validation',
              commands: ['code-validator', 'second-validator'],
              parallel: true,
              gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' },
            },
          ],
          on_failure: 'stop',
        },
      });

      try {
        await executor.execute(def, { target: '/tmp/test' });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowError);
        const we = error as WorkflowError;
        // The inner message ("All steps in phase...") survives via
        // formatErrorMessage() interpolation into the outer wrapper's message.
        expect(we.message).toContain('All steps in phase');
        expect(Array.isArray(we.context!.partialResult)).toBe(false);
        const partial = we.context!.partialResult as Partial<WorkflowResult>;
        expect(partial.type).toBe('workflow');
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
      const executionOrder: string[] = [];
      const cmdExec = {
        execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition) => {
          executionOrder.push(resolved.name);
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
      // c must execute after both a and b (deterministic — no timestamp race)
      const cIndex = executionOrder.indexOf('cmd-c');
      expect(cIndex).toBeGreaterThan(executionOrder.indexOf('cmd-a'));
      expect(cIndex).toBeGreaterThan(executionOrder.indexOf('cmd-b'));
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

    it('stop: skips dependent phases in sequential chain when gate fails', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'stop',
        },
      });
      const result = await new WorkflowExecutor(cmdExec, makeRegistry()).execute(def, { target: '/tmp/test' });

      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('skipped');
    });

    it('abort: behaves identically to stop for sequential dependency chains', async () => {
      const cmdExec = makeNamedCommandExecutor({
        'cmd-a': { score: 40 },
        'cmd-b': { score: 90 },
      });
      const def = makeWorkflowDef({
        orchestration: {
          phases: [
            { id: 'a', name: 'A', commands: ['cmd-a'], gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } },
            { id: 'b', name: 'B', commands: ['cmd-b'], depends_on: ['a'] },
          ],
          on_failure: 'abort',
        },
      });
      const result = await new WorkflowExecutor(cmdExec, makeRegistry()).execute(def, { target: '/tmp/test' });

      expect(result.phases.find(p => p.id === 'a')!.decision).toBe('blocked');
      expect(result.phases.find(p => p.id === 'b')!.decision).toBe('skipped');
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

/**
 * The workflow-side twin of the pipeline roll-up polarity defect.
 *
 * `createBlockedPhase` sets `commands: []`, so flat-mapping the roll-up over
 * `p.commands` dropped a blocked phase entirely — indistinguishable from a SKIPPED phase,
 * which contributes nothing because nothing ran. But a phase is blocked by a thrown error,
 * and that error can land AFTER its commands have already billed.
 *
 * POSITIVE CONTROL: revert the costUsd roll-up to
 * `phaseResults.flatMap(p => p.commands.map(c => c.metrics))` and the first test fails
 * with a defined total. Confirmed against the pre-fix code.
 */
describe('WorkflowExecutor — cost roll-up degrades to unknown on a blocked phase', () => {
  const pricedMetrics = (costUsd: number) => ({
    inputTokens: 500, outputTokens: 200, totalEffectiveTokens: 750,
    durationMs: 1000, model: 'claude-sonnet-4-5-20250929', toolCalls: 3, costUsd,
  });

  // Both phases sit in the SAME topological level deliberately. A single-phase level lets
  // the phase's WorkflowError propagate to execute()'s own catch and rethrow; only a
  // multi-phase level routes it through createBlockedPhase(), which is the commands:[]
  // shape this roll-up defect lives in.
  const twoPhaseDef = () => makeWorkflowDef({
    orchestration: {
      phases: [
        { id: 'first', name: 'First', commands: ['code-validator'],
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
        { id: 'second', name: 'Second', commands: ['second-validator'],
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
      ],
      on_failure: 'continue',
    } as never,
  });

  it('does not present the surviving phase’s cost as the workflow total', async () => {
    // Dispatch by NAME, not call order — the two phases run in parallel in one level.
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        resolved.name === 'code-validator'
          ? Promise.resolve(makeCommandResult({ name: resolved.name, metrics: pricedMetrics(0.25) as never }))
          : Promise.reject(new Error('phase blew up after its commands billed'))),
    } as unknown as CommandExecutor;

    const result = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(twoPhaseDef(), { target: '/tmp/test' });

    const blocked = result.phases.find(p => p.decision === 'blocked');
    expect(blocked).toBeDefined();
    // A blocked phase now CARRIES the crash placeholders the thrown error held, rather
    // than reporting `commands: []`. That was severing the billedMetrics channel one layer
    // above every site that populates it — measured at 49,000 effective tokens reported as
    // 0 on an all-crashed workflow.
    expect(blocked!.commands).toHaveLength(1);
    expect(blocked!.commands[0]!.score).toBeNull();
    // The point of this test is unchanged and still holds: the carried placeholder omits
    // costUsd, so the roll-up degrades to unknown instead of presenting the survivor's
    // $0.25 as the workflow total.
    expect(result.metrics.costUsd).toBeUndefined();
    expect(result.metrics.costUsd).not.toBe(0.25);
  });

  it('keeps a defined total when every phase priced successfully', async () => {
    // Control: proves the guard is not blanking every workflow run.
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        Promise.resolve(makeCommandResult({ name: resolved.name, metrics: pricedMetrics(0.25) as never }))),
    } as unknown as CommandExecutor;

    const result = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(twoPhaseDef(), { target: '/tmp/test' });

    expect(result.phases.some(p => p.decision === 'blocked')).toBe(false);
    expect(result.metrics.costUsd).toBeCloseTo(0.5, 10);
  });
});

/**
 * The crash placeholder must CONSUME what the error carries — workflow step crash.
 *
 * POSITIVE CONTROL: replace `crashMetrics(outcome.reason)` in the step-rejection handler
 * with the literal zero-token object it used to inline, and the first test fails. Before
 * it existed, that revert left the entire suite green — the third of three `crashMetrics`
 * consumer sites with no coverage that could tell wired from unwired.
 */
describe('WorkflowExecutor — crashed step reads billed metrics off the error', () => {
  const billed = {
    inputTokens: 120_000, outputTokens: 8_000, totalEffectiveTokens: 128_000,
    durationMs: 412_000, model: 'anthropic:claude-sonnet-4-5', costUsd: 0.48,
  };

  // Two commands in ONE phase: a survivor plus a crash, so the phase completes with a
  // synthesized placeholder rather than throwing the all-steps-failed error.
  const onePhaseTwoCommands = () => makeWorkflowDef({
    orchestration: {
      phases: [{
        id: 'validate', name: 'Validation',
        commands: ['code-validator', 'second-validator'],
        parallel: true,
        gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' },
      }],
      on_failure: 'continue',
    } as never,
  });

  it('reports a crashed step’s ALREADY-BILLED usage, not fabricated zeros', async () => {
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        resolved.name === 'code-validator'
          ? Promise.resolve(makeCommandResult({ name: resolved.name }))
          : Promise.reject(new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed))),
    } as unknown as CommandExecutor;

    const result = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(onePhaseTwoCommands(), { target: '/tmp/test' });

    const crashed = result.phases[0]!.commands.find(c => c.decision === 'FAIL');
    expect(crashed).toBeDefined();
    expect(crashed!.metrics.inputTokens).toBe(120_000);
    expect(crashed!.metrics.costUsd).toBe(0.48);
    expect(crashed!.metrics.inputTokens).not.toBe(0);
  });

  it('leaves a crashed step’s cost ABSENT when the error carries nothing', async () => {
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        resolved.name === 'code-validator'
          ? Promise.resolve(makeCommandResult({ name: resolved.name }))
          : Promise.reject(new Error('registry timeout'))),
    } as unknown as CommandExecutor;

    const result = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(onePhaseTwoCommands(), { target: '/tmp/test' });

    const crashed = result.phases[0]!.commands.find(c => c.decision === 'FAIL');
    expect(crashed!.metrics.costUsd).toBeUndefined();
    expect(crashed!.metrics.costUsd).not.toBe(0);
  });
});

/**
 * A crashed phase must not fabricate a score into the workflow average.
 *
 * POSITIVE CONTROL: set `score: 0` back in `createBlockedPhase` and the first test fails
 * with 45 instead of 90. Confirmed by mutation.
 *
 * `aggregate()` filters 'skipped' and 'aborted' but NOT 'blocked' — the crash case — so a
 * fabricated 0 entered the weighted average and dragged reported quality down in
 * proportion to how many phases crashed. The PipelineExecutor sibling guards the identical
 * situation and explains why in an eight-line comment.
 *
 * Recorded because of WHERE it was found: the previous commit fixed `commands: []` in this
 * same object literal for the cost roll-up, wrote a positive-control test for it, and left
 * `score: 0` two lines below untouched.
 */
describe('WorkflowExecutor — a thrown phase contributes no score', () => {
  const twoPhasesOneLevel = () => makeWorkflowDef({
    orchestration: {
      phases: [
        { id: 'good', name: 'Good', commands: ['code-validator'],
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
        { id: 'crash', name: 'Crash', commands: ['second-validator'],
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
      ],
      on_failure: 'continue',
    } as never,
  });

  const survivorPlusCrash = () => ({
    execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
      resolved.name === 'code-validator'
        ? Promise.resolve(makeCommandResult({ name: resolved.name, score: 90 }))
        : Promise.reject(new Error('network timeout'))),
  } as unknown as CommandExecutor);

  it('does not drag the workflow score down with a fabricated 0', async () => {
    const result = await new WorkflowExecutor(survivorPlusCrash(), makeRegistry())
      .execute(twoPhasesOneLevel(), { target: '/tmp/test' });

    const blocked = result.phases.find(p => p.decision === 'blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.score).toBeNull();
    // The measured defect: 90 and a fabricated 0 averaged to 45.
    expect(result.score).toBe(90);
    expect(result.score).not.toBe(45);
  });

  it('still reports the crash — the phase is blocked, not quietly dropped', async () => {
    // Excluding a crash from the SCORE must not also hide it. Score nullity and outcome
    // visibility are separate concerns and both have to hold.
    const result = await new WorkflowExecutor(survivorPlusCrash(), makeRegistry())
      .execute(twoPhasesOneLevel(), { target: '/tmp/test' });

    expect(result.phases.some(p => p.decision === 'blocked')).toBe(true);
    expect(result.metrics.phasesBlocked).toBe(1);
  });

  it('keeps an AUTHORED-empty phase at 0 — the opposite case, deliberately', async () => {
    // Guards the distinction the fix rests on. An authored-empty phase must still block at
    // its gate; only a CRASHED phase is excluded from the average. Without this, someone
    // "simplifying" createBlockedPhase and aggregatePhaseScore to agree would silently let
    // empty phases pass.
    const def = makeWorkflowDef({
      orchestration: {
        phases: [{ id: 'empty', name: 'Empty', commands: [],
          gate: { threshold: 70, aggregate: 'average', on_fail: 'stop' } }],
        on_failure: 'stop',
      } as never,
    });

    const result = await new WorkflowExecutor(makeCommandExecutor(), makeRegistry())
      .execute(def, { target: '/tmp/test' });

    expect(result.phases[0]!.score).toBe(0);
    expect(result.phases[0]!.decision).toBe('blocked');
  });
});

/**
 * Sequential phase execution is FAIL-FAST but not lossy.
 *
 * POSITIVE CONTROL: remove the try/catch from the non-parallel branch of executePhase and
 * the first test fails — the throw escapes and the survivor's billed work is gone.
 */
describe('WorkflowExecutor — sequential branch contains crashes like its parallel twin', () => {
  const sequentialPhase = () => makeWorkflowDef({
    orchestration: {
      phases: [{
        id: 'validate', name: 'Validation',
        commands: ['code-validator', 'second-validator'],
        parallel: false,
        gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' },
      }],
      on_failure: 'continue',
    } as never,
  });

  it('keeps a completed step’s billed work when a later step throws', async () => {
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        resolved.name === 'code-validator'
          ? Promise.resolve(makeCommandResult({ name: resolved.name, score: 90 }))
          : Promise.reject(new Error('boom'))),
    } as unknown as CommandExecutor;

    const result = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(sequentialPhase(), { target: '/tmp/test' });

    // Survivor present with its metrics, crash present as a null-score placeholder.
    expect(result.phases[0]!.commands).toHaveLength(2);
    expect(result.phases[0]!.commands[0]!.score).toBe(90);
    expect(result.phases[0]!.commands[1]!.score).toBeNull();
    expect(result.metrics.inputTokens).toBeGreaterThan(0);
  });

  it('still THROWS when every sequential step fails — fail-fast parity preserved', async () => {
    // The all-failed check governs both branches; a single-step phase that fails must
    // behave exactly as it did before this change.
    const cmdExec = {
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as CommandExecutor;

    const def = makeWorkflowDef({
      orchestration: {
        phases: [{ id: 'validate', name: 'Validation', commands: ['code-validator'], parallel: false,
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } }],
        on_failure: 'continue',
      } as never,
    });

    await expect(new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(def, { target: '/tmp/test' })).rejects.toBeInstanceOf(WorkflowError);
  });

  it('stops dispatching after a crash — fail-fast is not weakened', async () => {
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        resolved.name === 'code-validator'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(makeCommandResult({ name: resolved.name, score: 90 }))),
    } as unknown as CommandExecutor;

    await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(sequentialPhase(), { target: '/tmp/test' })
      .catch(() => undefined);

    // The second command must never have been dispatched.
    expect(vi.mocked(cmdExec.execute)).toHaveBeenCalledTimes(1);
  });
});

/**
 * A blocked phase carries the billed work the thrown error holds, and a thrown workflow
 * still reports what completed phases spent.
 *
 * POSITIVE CONTROL: restore `commands: []` in createBlockedPhase, or drop `metrics`/`score`
 * from buildPartialResult, and the matching test below fails. Confirmed by mutation.
 *
 * executePhase throws `WorkflowError(…, { partialResult: commandResults })` where those
 * placeholders hold real `billedMetrics`; the catch was replacing them with an empty array,
 * severing the channel this release added one layer above every site that populates it.
 */
describe('WorkflowExecutor — billed work survives a blocked phase and a thrown workflow', () => {
  const billed = {
    inputTokens: 49_000, outputTokens: 1_000, totalEffectiveTokens: 50_000,
    durationMs: 9_000, model: 'anthropic:claude-sonnet-4-5', costUsd: 4.25,
  };

  it('carries the crash placeholders into the blocked phase', async () => {
    const cmdExec = {
      execute: vi.fn().mockImplementation((resolved: ResolvedDefinition) =>
        resolved.name === 'code-validator'
          ? Promise.resolve(makeCommandResult({ name: resolved.name, score: 90 }))
          : Promise.reject(new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed))),
    } as unknown as CommandExecutor;

    const def = makeWorkflowDef({
      orchestration: {
        phases: [
          { id: 'good', name: 'Good', commands: ['code-validator'],
            gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
          { id: 'crash', name: 'Crash', commands: ['second-validator'],
            gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
        ],
        on_failure: 'continue',
      } as never,
    });

    const result = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(def, { target: '/tmp/test' });

    const blocked = result.phases.find(p => p.decision === 'blocked')!;
    expect(blocked.commands).toHaveLength(1);
    // The measured defect: 49,000 effective tokens reported as 0.
    expect(blocked.commands[0]!.metrics.inputTokens).toBe(49_000);
    expect(result.metrics.totalEffectiveTokens).toBeGreaterThanOrEqual(50_000);
  });

  it('reports prior phases’ metrics and score on a THROWN workflow', async () => {
    // buildPartialResult carried phases and recommendations only, so every completed
    // phase's tokens and cost vanished with the throw — the more work a run had finished,
    // the more it lost.
    const cmdExec = {
      execute: vi.fn().mockRejectedValue(new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed)),
    } as unknown as CommandExecutor;

    const def = makeWorkflowDef({
      orchestration: {
        phases: [{ id: 'only', name: 'Only', commands: ['code-validator'],
          gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } }],
        on_failure: 'continue',
      } as never,
    });

    const error = await new WorkflowExecutor(cmdExec, makeRegistry())
      .execute(def, { target: '/tmp/test' })
      .then(() => null, (e: unknown) => e as WorkflowError);

    expect(error).toBeInstanceOf(WorkflowError);
    const partial = (error as WorkflowError).context?.partialResult as Record<string, any>;
    expect(partial).toBeDefined();
    expect(partial['metrics']).toBeDefined();
    expect(partial['metrics'].totalEffectiveTokens).toBeGreaterThan(0);
  });

  it('a SKIPPED phase reports no score — it never ran', async () => {
    const def = makeWorkflowDef({
      orchestration: {
        phases: [
          { id: 'a', name: 'A', commands: ['code-validator'],
            gate: { threshold: 200, aggregate: 'average', on_fail: 'stop' } },
          { id: 'b', name: 'B', commands: ['second-validator'], depends_on: ['a'],
            gate: { threshold: 0, aggregate: 'average', on_fail: 'continue' } },
        ],
        on_failure: 'stop',
      } as never,
    });

    const result = await new WorkflowExecutor(makeCommandExecutor(), makeRegistry())
      .execute(def, { target: '/tmp/test' });

    const skipped = result.phases.find(p => p.decision === 'skipped');
    expect(skipped).toBeDefined();
    // Externally visible on result.phases[], where a 0 reads as a measured failure.
    expect(skipped!.score).toBeNull();
  });
});
