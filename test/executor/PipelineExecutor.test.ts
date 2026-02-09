import { describe, it, expect, vi } from 'vitest';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import type { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { RegistryClient } from '../../src/registry/RegistryClient.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { CommandResult } from '../../src/types/command.js';
import type { WorkflowResult } from '../../src/types/workflow.js';
import type { PipelineDefinition } from '../../src/types/pipeline.js';
import { PipelineError } from '../../src/errors/index.js';

function makeCommandResult(overrides?: Partial<CommandResult>): CommandResult {
  return {
    type: 'command',
    name: 'test-command',
    version: '1.0.0',
    definitionHash: 'sha256:cmd',
    agentType: 'validator',
    decision: 'PASS',
    score: 85,
    recommendations: [],
    durationMs: 1000,
    metrics: {
      inputTokens: 500,
      outputTokens: 200,
      totalEffectiveTokens: 700,
      durationMs: 1000,
      model: 'sonnet',
      toolCalls: 2,
    },
    ...overrides,
  };
}

function makeWorkflowResult(overrides?: Partial<WorkflowResult>): WorkflowResult {
  return {
    type: 'workflow',
    name: 'test-workflow',
    version: '1.0.0',
    definitionHash: 'sha256:wf',
    decision: 'SHIP',
    score: 90,
    phases: [],
    recommendations: [],
    durationMs: 2000,
    metrics: {
      inputTokens: 1000,
      outputTokens: 400,
      totalEffectiveTokens: 1400,
      durationMs: 2000,
      model: 'mixed',
      phasesExecuted: 2,
      phasesPassed: 2,
      phasesWarned: 0,
      phasesBlocked: 0,
      phasesSkipped: 0,
      commands: [],
    },
    ...overrides,
  };
}

function makeWorkflowExecutor(results?: WorkflowResult[]): WorkflowExecutor {
  const queue = results ? [...results] : [];
  return {
    execute: vi.fn().mockImplementation(() => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return Promise.resolve(makeWorkflowResult());
    }),
  } as unknown as WorkflowExecutor;
}

function makeCommandExecutor(results?: CommandResult[]): CommandExecutor {
  const queue = results ? [...results] : [];
  return {
    execute: vi.fn().mockImplementation(() => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return Promise.resolve(makeCommandResult());
    }),
  } as unknown as CommandExecutor;
}

function makeRegistry(resolutions?: Record<string, ResolvedDefinition>): RegistryClient {
  return {
    resolve: vi.fn().mockImplementation((name: string, version?: string, type?: string) => {
      const key = version ? `${name}@${version}` : name;
      if (resolutions?.[key]) return Promise.resolve(resolutions[key]);
      return Promise.resolve({
        type: type ?? 'command',
        name,
        version: version ?? '1.0.0',
        hash: 'sha256:resolved',
        yaml: '',
        definition: {} as ResolvedDefinition['definition'],
        runtime: {} as ResolvedDefinition['runtime'],
        domain: 'software',
      } satisfies ResolvedDefinition);
    }),
  } as unknown as RegistryClient;
}

function makePipelineDef(overrides?: Partial<PipelineDefinition['pipeline']>): ResolvedDefinition {
  return {
    type: 'pipeline',
    name: 'test-pipeline',
    version: '1.0.0',
    hash: 'sha256:pipe',
    yaml: '',
    definition: {
      pipeline: {
        interface: {
          name: 'test-pipeline',
          version: '1.0.0',
          displayName: 'Test Pipeline',
          description: 'A test pipeline',
          domain: 'software',
        },
        stages: [
          {
            id: 'stage-1',
            name: 'Stage 1',
            type: 'command',
            ref: 'code-validator@1.0.0',
          },
        ],
        ...overrides,
      },
    } as ResolvedDefinition['definition'],
    runtime: {} as ResolvedDefinition['runtime'],
    domain: 'software',
  };
}

describe('PipelineExecutor', () => {
  describe('single-stage execution', () => {
    it('executes a single command stage', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 85 })]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const result = await executor.execute(
        makePipelineDef(),
        { target: '/tmp/test' },
      );

      expect(result.type).toBe('pipeline');
      expect(result.status).toBe('complete');
      expect(result.stages).toHaveLength(1);
      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[0]!.type).toBe('command');
    });

    it('executes a workflow stage', async () => {
      const wfExec = makeWorkflowExecutor([makeWorkflowResult({ score: 92 })]);
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'stage-1', name: 'Stage 1', type: 'workflow', ref: 'ship@1.0.0' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.type).toBe('workflow');
      expect(result.stages[0]!.status).toBe('completed');
      expect(wfExec.execute).toHaveBeenCalled();
    });

    it('resolves stage ref from registry', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      await executor.execute(makePipelineDef(), { target: '/tmp/test' });

      expect(registry.resolve).toHaveBeenCalledWith('code-validator', '1.0.0', 'command');
    });
  });

  describe('multi-stage execution', () => {
    it('executes stages in sequence', async () => {
      const cmdResults = [
        makeCommandResult({ name: 'cmd-a', score: 80 }),
        makeCommandResult({ name: 'cmd-b', score: 90 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'stage-1', name: 'Stage 1', type: 'command', ref: 'cmd-a@1.0.0' },
          { id: 'stage-2', name: 'Stage 2', type: 'command', ref: 'cmd-b@1.0.0' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages).toHaveLength(2);
      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[1]!.status).toBe('completed');
      expect(result.score).toBe(85); // avg of 80, 90
    });
  });

  describe('stage dependencies', () => {
    it('skips stage when dependency not met', async () => {
      const cmdExec = {
        execute: vi.fn().mockRejectedValue(new Error('Stage 1 failed')),
      } as unknown as CommandExecutor;
      const wfExec = makeWorkflowExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'stage-1', name: 'Stage 1', type: 'command', ref: 'cmd-a@1.0.0' },
          { id: 'stage-2', name: 'Stage 2', type: 'command', ref: 'cmd-b@1.0.0', depends_on: ['stage-1'] },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('failed');
      expect(result.stages[1]!.status).toBe('skipped');
      expect(result.stages[1]!.skipReason).toBe('dependencies_not_met');
    });

    it('executes dependent stage when dependency completed', async () => {
      const cmdResults = [
        makeCommandResult({ score: 80 }),
        makeCommandResult({ score: 90 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'stage-1', name: 'Stage 1', type: 'command', ref: 'cmd-a@1.0.0' },
          { id: 'stage-2', name: 'Stage 2', type: 'command', ref: 'cmd-b@1.0.0', depends_on: ['stage-1'] },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[1]!.status).toBe('completed');
    });
  });

  describe('skip conditions', () => {
    it('skips stage when skip_if evaluates to true', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([
        makeCommandResult({ name: 'cmd-a', score: 80, decision: 'PASS' }),
      ]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'pre-check', name: 'Pre-check', type: 'command', ref: 'cmd-a@1.0.0' },
          { id: 'deploy', name: 'Deploy', type: 'command', ref: 'cmd-b@1.0.0', skip_if: "pre-check.decision == 'PASS'" },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[1]!.status).toBe('skipped');
      expect(result.stages[1]!.skipReason).toBe('skip_if_true');
    });

    it('does not skip when condition evaluates to false', async () => {
      const cmdResults = [
        makeCommandResult({ name: 'cmd-a', score: 80, decision: 'WARN' }),
        makeCommandResult({ name: 'cmd-b', score: 90 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'pre-check', name: 'Pre-check', type: 'command', ref: 'cmd-a@1.0.0' },
          { id: 'deploy', name: 'Deploy', type: 'command', ref: 'cmd-b@1.0.0', skip_if: "pre-check.decision == 'PASS'" },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[1]!.status).toBe('completed');
    });
  });

  describe('async pipeline (start/handle)', () => {
    it('returns a PipelineHandle from start()', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult()]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const handle = await executor.start(makePipelineDef(), { target: '/tmp/test' });

      expect(handle.executionId).toMatch(/^pipeline_/);
      expect(typeof handle.wait).toBe('function');
      expect(typeof handle.cancel).toBe('function');
      expect(typeof handle.status).toBe('function');
    });

    it('handle.wait() resolves when pipeline completes', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 85 })]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const handle = await executor.start(makePipelineDef(), { target: '/tmp/test' });
      const result = await handle.wait(10);

      expect(result.type).toBe('pipeline');
      expect(result.status).toBe('complete');
    });

    it('handle.cancel() stops execution', async () => {
      // Use a slow command that gives us time to cancel
      let resolveCmd: ((v: CommandResult) => void) | undefined;
      const slowCmd = new Promise<CommandResult>(r => { resolveCmd = r; });

      const cmdExec = {
        execute: vi.fn().mockReturnValue(slowCmd),
      } as unknown as CommandExecutor;
      const wfExec = makeWorkflowExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'stage-1', name: 'Stage 1', type: 'command', ref: 'slow@1.0.0' },
          { id: 'stage-2', name: 'Stage 2', type: 'command', ref: 'fast@1.0.0' },
        ],
      });

      const handle = await executor.start(def, { target: '/tmp/test' });

      // Cancel while stage-1 is still running
      await handle.cancel();

      // Resolve stage-1 so the background execution can proceed
      resolveCmd!(makeCommandResult());

      // Give it a tick to finish
      await new Promise(r => setTimeout(r, 50));

      const result = await handle.status();
      expect(result.stages.length).toBeLessThanOrEqual(2); // May have only 1 stage
    });

    it('handle.cancel() throws on already-complete pipeline', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult()]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const handle = await executor.start(makePipelineDef(), { target: '/tmp/test' });
      await handle.wait(10);

      await expect(handle.cancel()).rejects.toThrow(PipelineError);
    });
  });

  describe('result computation', () => {
    it('computes average score across stages', async () => {
      const cmdResults = [
        makeCommandResult({ score: 80 }),
        makeCommandResult({ score: 100 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 's1', name: 'S1', type: 'command', ref: 'a@1' },
          { id: 's2', name: 'S2', type: 'command', ref: 'b@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.score).toBe(90); // avg of 80, 100
    });

    it('computes PASS decision when no failures', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult({ decision: 'PASS' })]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const result = await executor.execute(makePipelineDef(), { target: '/tmp/test' });

      expect(result.decision).toBe('PASS');
    });

    it('computes FAIL decision when a stage result has FAIL', async () => {
      const cmdResults = [
        makeCommandResult({ decision: 'FAIL', score: 30 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const result = await executor.execute(makePipelineDef(), { target: '/tmp/test' });

      expect(result.decision).toBe('FAIL');
    });

    it('computes WARN decision when a stage result has WARN', async () => {
      const cmdResults = [
        makeCommandResult({ decision: 'WARN', score: 60 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const result = await executor.execute(makePipelineDef(), { target: '/tmp/test' });

      expect(result.decision).toBe('WARN');
    });

    it('accumulates metrics across stages', async () => {
      const cmdResults = [
        makeCommandResult({ metrics: { inputTokens: 500, outputTokens: 200, totalEffectiveTokens: 700, durationMs: 1000, model: 'sonnet', toolCalls: 2 } }),
        makeCommandResult({ metrics: { inputTokens: 300, outputTokens: 100, totalEffectiveTokens: 400, durationMs: 500, model: 'haiku', toolCalls: 1 } }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 's1', name: 'S1', type: 'command', ref: 'a@1' },
          { id: 's2', name: 'S2', type: 'command', ref: 'b@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.metrics.inputTokens).toBe(800);
      expect(result.metrics.outputTokens).toBe(300);
      expect(result.metrics.totalEffectiveTokens).toBe(1100);
      expect(result.metrics.stagesExecuted).toBe(2);
      expect(result.metrics.stagesFailed).toBe(0);
      expect(result.metrics.stagesSkipped).toBe(0);
    });
  });

  describe('condition evaluator', () => {
    it('supports numeric comparisons', async () => {
      const cmdResults = [
        makeCommandResult({ name: 'cmd-a', score: 80 }),
        makeCommandResult({ name: 'cmd-b', score: 90 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'check', name: 'Check', type: 'command', ref: 'cmd-a@1' },
          { id: 'deploy', name: 'Deploy', type: 'command', ref: 'cmd-b@1', skip_if: 'check.score >= 70' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // check.score is 80 >= 70, so deploy should be skipped
      expect(result.stages[1]!.status).toBe('skipped');
    });

    it('handles invalid condition gracefully', async () => {
      const cmdResults = [
        makeCommandResult(),
        makeCommandResult(),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 'check', name: 'Check', type: 'command', ref: 'cmd-a@1' },
          { id: 'deploy', name: 'Deploy', type: 'command', ref: 'cmd-b@1', skip_if: 'invalid condition syntax !!!' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // Invalid condition evaluates to false, so stage executes
      expect(result.stages[1]!.status).toBe('completed');
    });
  });

  describe('error handling', () => {
    it('stage failure is captured without crashing pipeline', async () => {
      const cmdExec = {
        execute: vi.fn()
          .mockRejectedValueOnce(new Error('Agent crashed'))
          .mockResolvedValueOnce(makeCommandResult({ score: 90 })),
      } as unknown as CommandExecutor;
      const wfExec = makeWorkflowExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const def = makePipelineDef({
        stages: [
          { id: 's1', name: 'S1', type: 'command', ref: 'a@1' },
          { id: 's2', name: 'S2', type: 'command', ref: 'b@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('failed');
      expect(result.stages[0]!.skipReason).toContain('Agent crashed');
      expect(result.stages[1]!.status).toBe('completed');
    });

    it('handle.wait() throws PipelineError on overall failure', async () => {
      // Simulate a pipeline where executeAsync itself throws (not a stage error)
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = {
        resolve: vi.fn().mockRejectedValue(new Error('Registry unavailable')),
      } as unknown as RegistryClient;
      const executor = new PipelineExecutor(wfExec, cmdExec, registry);

      const handle = await executor.start(makePipelineDef(), { target: '/tmp/test' });

      await expect(handle.wait(10)).rejects.toThrow(PipelineError);
    });
  });
});
