import { describe, it, expect, vi } from 'vitest';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { PipelineDefinition } from '../../src/types/pipeline.js';
import { PipelineError } from '../../src/errors/index.js';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { RegistryClient } from '../../src/registry/RegistryClient.js';
import {
  makeCommandResult,
  makeWorkflowResult,
  makeWorkflowExecutor,
  makeCommandExecutor,
  makeRegistry,
} from './fixtures.js';

import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const agentExec = {} as AgentExecutor;

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          { id: 'pre-check', name: 'Pre-check', type: 'command', ref: 'cmd-a@1.0.0' },
          { id: 'deploy', name: 'Deploy', type: 'command', ref: 'cmd-b@1.0.0', skip_if: "pre-check.decision == 'PASS'" },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[1]!.status).toBe('skipped');
      expect(result.stages[1]!.skipReason).toBe('condition_met');
    });

    it('does not skip when condition evaluates to false', async () => {
      const cmdResults = [
        makeCommandResult({ name: 'cmd-a', score: 80, decision: 'WARN' }),
        makeCommandResult({ name: 'cmd-b', score: 90 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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

      // Flush microtask queue so the background promise chain settles
      // (resolveCmd → push stage result → check cancel → break → exit)
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      const result = await handle.status();
      expect(result.stages).toHaveLength(1); // Only stage-1 ran; stage-2 was cancelled
      expect(result.status).toBe('cancelled');
    });

    it('handle.cancel() throws on already-complete pipeline', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult()]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const handle = await executor.start(makePipelineDef(), { target: '/tmp/test' });
      await handle.wait(10);

      await expect(handle.cancel()).rejects.toThrow(PipelineError);
    });
  });

  describe('steps and no-content stages (pdl-steps-execution-spec Phase 0)', () => {
    it('passes a steps-only stage through with PASS and a null score pair', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          {
            id: 'preflight', name: 'Preflight', type: 'steps',
            steps: [{ name: 'Detect TypeScript', command: 'test -f tsconfig.json && echo DETECTED || echo NOT_DETECTED' }],
          },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('completed');
      const stageResult = result.stages[0]!.result!;
      expect(stageResult.decision).toBe('PASS');
      expect(stageResult.score).toBeNull();
      expect(stageResult.maxScore).toBeNull();
      expect(cmdExec.execute).not.toHaveBeenCalled();
    });

    it('recognizes a steps stage without an explicit type (pre-normalization shape)', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          {
            id: 'preflight', name: 'Preflight',
            steps: [{ name: 'Check', command: '[ -d "." ] && echo DETECTED' }],
          } as unknown as PipelineDefinition['pipeline']['stages'][number],
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('completed');
      expect(result.stages[0]!.result!.score).toBeNull();
    });

    it('excludes the steps stage from the pipeline average instead of injecting 100', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 80 })]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          { id: 'preflight', name: 'Preflight', type: 'steps', steps: [{ name: 'Check', command: 'true' }] },
          { id: 'validate', name: 'Validate', type: 'command', ref: 'a@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // Previously avg(100, 80) = 90 — the fabricated 100 inflated the pipeline.
      expect(result.score).toBe(80);
    });

    it('keeps depends_on chains flowing across a steps stage', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult({ score: 75 })]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          { id: 'preflight', name: 'Preflight', type: 'steps', steps: [{ name: 'Check', command: 'true' }] },
          { id: 'validate', name: 'Validate', type: 'command', ref: 'a@1', depends_on: ['preflight'] },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[1]!.status).toBe('completed');
      expect(cmdExec.execute).toHaveBeenCalledTimes(1);
    });

    it('executes steps for real under allowStageSteps and derives the decision', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger, true);

      const def = makePipelineDef({
        stages: [
          {
            id: 'preflight', name: 'Preflight', type: 'steps',
            steps: [{ name: 'Detect', command: 'echo DETECTED' }],
          },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp' });

      const stage = result.stages[0]!;
      expect(stage.status).toBe('completed');
      expect(stage.result!.decision).toBe('PASS');
      expect(stage.result!.score).toBeNull();
      expect(stage.steps).toHaveLength(1);
      expect(stage.steps![0]!.output).toBe('DETECTED');
      expect(stage.steps![0]!.status).toBe('passed');
    });

    it('fails the stage when a step hard-fails under allowStageSteps', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger, true);

      const def = makePipelineDef({
        stages: [
          {
            id: 'gate', name: 'Build Gate', type: 'steps',
            steps: [{ name: 'compile', command: 'exit 2' }],
          },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp' });

      expect(result.stages[0]!.result!.decision).toBe('FAIL');
      expect(result.stages[0]!.steps![0]!.status).toBe('failed');
      expect(result.stages[0]!.result!.score).toBeNull();
    });

    it('keeps decision PASS when the only failing step is continue_on_error', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger, true);

      const def = makePipelineDef({
        stages: [
          {
            id: 'gate', name: 'Soft Gate', type: 'steps',
            steps: [
              { name: 'soft-check', command: 'exit 1', continue_on_error: true },
              { name: 'hard-check', command: 'echo ok' },
            ],
          },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp' });

      // The soft failure is recorded on the step but must not fail the stage —
      // locks the stage-decision continue_on_error filter (mutation-survivor fix).
      expect(result.stages[0]!.steps![0]!.status).toBe('failed');
      expect(result.stages[0]!.result!.decision).toBe('PASS');
    });

    it('honors the per-run allowStageSteps override over the config default', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      // Config-level: disabled
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger, false);

      const def = makePipelineDef({
        stages: [
          { id: 'preflight', name: 'Preflight', type: 'steps', steps: [{ name: 'Detect', command: 'echo DETECTED' }] },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp' }, { allowStageSteps: true });

      expect(result.stages[0]!.steps).toHaveLength(1);
      expect(result.stages[0]!.steps![0]!.output).toBe('DETECTED');
    });

    it('fails loud on a stage with no ref, agents, or steps instead of fabricating a PASS', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          // Multi-entry workflows array: normalization cannot hoist, engine cannot run.
          {
            id: 'multi', name: 'Multi',
            workflows: [{ ref: 'ship@1.0.0' }, { ref: 'other@1.0.0' }],
          } as unknown as PipelineDefinition['pipeline']['stages'][number],
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.stages[0]!.status).toBe('failed');
      expect(result.stages[0]!.skipReason).toMatch(/no executable content/);
      expect(result.stages[0]!.result).toBeUndefined();
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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          { id: 's1', name: 'S1', type: 'command', ref: 'a@1' },
          { id: 's2', name: 'S2', type: 'command', ref: 'b@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.score).toBe(90); // avg of 80, 100
    });

    it('excludes a scoreless stage from the pipeline average (Phase 6 null handling)', async () => {
      const cmdResults = [
        makeCommandResult({ score: 80 }),
        makeCommandResult({ score: null }), // e.g. an all-generator stage — no score
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          { id: 's1', name: 'S1', type: 'command', ref: 'a@1' },
          { id: 's2', name: 'S2', type: 'command', ref: 'b@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      // The scoreless stage is filtered, not folded in as 0: avg([80]) = 80, not avg(80,0)=40.
      expect(result.score).toBe(80);
    });

    it('computes average score across 3 stages with non-symmetric scores', async () => {
      const cmdResults = [
        makeCommandResult({ score: 70 }),
        makeCommandResult({ score: 80 }),
        makeCommandResult({ score: 90 }),
      ];
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor(cmdResults);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const def = makePipelineDef({
        stages: [
          { id: 's1', name: 'S1', type: 'command', ref: 'a@1' },
          { id: 's2', name: 'S2', type: 'command', ref: 'b@1' },
          { id: 's3', name: 'S3', type: 'command', ref: 'c@1' },
        ],
      });

      const result = await executor.execute(def, { target: '/tmp/test' });

      expect(result.score).toBe(80); // avg of 70, 80, 90
      expect(result.stages).toHaveLength(3);
    });

    it('computes PASS decision when no failures', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor([makeCommandResult({ decision: 'PASS' })]);
      const registry = makeRegistry();
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

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
      // Pipeline decision must reflect the thrown-error failure
      expect(result.decision).toBe('FAIL');
      expect(result.metrics.stagesFailed).toBe(1);
      expect(result.metrics.stagesExecuted).toBe(2);
    });

    it('records failed stage when registry is unavailable', async () => {
      const wfExec = makeWorkflowExecutor();
      const cmdExec = makeCommandExecutor();
      const registry = {
        resolve: vi.fn().mockRejectedValue(new Error('Registry unavailable')),
      } as unknown as RegistryClient;
      const executor = new PipelineExecutor(wfExec, cmdExec, agentExec, registry, noopLogger);

      const handle = await executor.start(makePipelineDef(), { target: '/tmp/test' });
      const result = await handle.wait();

      expect(result.stages[0]!.status).toBe('failed');
      expect(result.stages[0]!.skipReason).toContain('Registry unavailable');
    });
  });
});
