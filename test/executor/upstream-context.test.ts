/**
 * Stage output forwarding — spec §5 unit groups 1–8
 * (stage-output-forwarding-spec v0.3.1).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildUpstreamContext,
  renderUpstreamSection,
  headTailRetain,
  UPSTREAM_STAGE_SLICE_CAP,
  UPSTREAM_STAGE_FULL_CAP,
  UPSTREAM_TOTAL_CAP,
  UPSTREAM_KILL_SWITCH_ENV,
} from '../../src/executor/upstreamContext.js';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { normalizePipelineSection } from '../../src/registry/normalize.js';
import type { StageDefinition, StageResult, PipelineDefinition } from '../../src/types/pipeline.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { UpstreamStageContext, ExecutionInput } from '../../src/types/execution.js';
import type { AgentExecutor as AgentExecutorType } from '../../src/executor/AgentExecutor.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { ToolHandler } from '../../src/executor/ToolHandler.js';
import {
  makeValidatorResult,
  makeCommandResult,
  makeWorkflowExecutor,
  makeCommandExecutor,
  makeRegistry,
} from './fixtures.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// ─── Builders ────────────────────────────────────────────────────────────

function stage(id: string, overrides?: Partial<StageDefinition>): StageDefinition {
  return { id, name: id, type: 'agents', agents: [{ ref: `${id}-agent@1.0.0` }], ...overrides };
}

function completedAgentStage(id: string, agentOverrides?: Parameters<typeof makeValidatorResult>[0]): StageResult {
  return {
    id,
    name: id,
    type: 'command',
    status: 'completed',
    agentResults: [makeValidatorResult({ name: `${id}-agent`, ...agentOverrides })],
    durationMs: 10,
  };
}

afterEach(() => {
  delete process.env[UPSTREAM_KILL_SWITCH_ENV];
});

// ─── Group 1: buildUpstreamContext matrix ────────────────────────────────

describe('buildUpstreamContext', () => {
  it('forwards only depends_on stages', () => {
    const s = stage('synthesis', { depends_on: ['analysis'] });
    const all = [stage('analysis'), stage('other'), s];
    const prior = [completedAgentStage('analysis'), completedAgentStage('other')];
    const ctx = buildUpstreamContext(s, all, prior);
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.stageId).toBe('analysis');
    expect(ctx[0]!.agentName).toBe('analysis-agent');
  });

  it('honors producer forward: none', () => {
    const s = stage('synthesis', { depends_on: ['gate'] });
    const all = [stage('gate', { forward: 'none' }), s];
    const ctx = buildUpstreamContext(s, all, [completedAgentStage('gate')]);
    expect(ctx).toHaveLength(0);
  });

  it('honors consumer receives: none', () => {
    const s = stage('synthesis', { depends_on: ['analysis'], receives: 'none' });
    const all = [stage('analysis'), s];
    const ctx = buildUpstreamContext(s, all, [completedAgentStage('analysis')]);
    expect(ctx).toHaveLength(0);
  });

  it('forward: full attaches head+tail-retained rawOutput', () => {
    const s = stage('synthesis', { depends_on: ['deep'] });
    const all = [stage('deep', { forward: 'full' }), s];
    const raw = 'H'.repeat(20_000) + 'MIDDLE' + 'T'.repeat(20_000);
    const prior = [completedAgentStage('deep', { rawOutput: raw } as never)];
    const ctx = buildUpstreamContext(s, all, prior);
    expect(ctx[0]!.fullText).toBeDefined();
    expect(ctx[0]!.fullText).toContain('elided');
    expect(ctx[0]!.fullText!.startsWith('HHH')).toBe(true);
    expect(ctx[0]!.fullText!.endsWith('TTT')).toBe(true);
    expect(ctx[0]!.fullText!).not.toContain('MIDDLE');
  });

  it('skips steps-only upstream stages silently', () => {
    const s = stage('build', { depends_on: ['preflight'] });
    const all = [stage('preflight', { type: 'steps', agents: undefined }), s];
    const prior: StageResult[] = [{
      id: 'preflight', name: 'preflight', type: 'command', status: 'completed',
      steps: [{ name: 'detect', status: 'completed', output: 'DETECTED', durationMs: 5 }],
      result: { ...makeCommandResult({ score: null, maxScore: null }), recommendations: [] },
      durationMs: 5,
    }];
    const ctx = buildUpstreamContext(s, all, prior);
    expect(ctx).toHaveLength(0);
  });

  it('emits a labeled absence for a non-completed partial dependency', () => {
    const s = stage('synthesis', { depends_on: ['ok', 'broken'] });
    const all = [stage('ok'), stage('broken'), s];
    const prior: StageResult[] = [
      completedAgentStage('ok'),
      { id: 'broken', name: 'broken', type: 'command', status: 'failed', skipReason: 'x'.repeat(500), durationMs: 1 },
    ];
    const ctx = buildUpstreamContext(s, all, prior);
    expect(ctx).toHaveLength(2);
    const absent = ctx.find((e) => e.stageId === 'broken')!;
    expect(absent.absent).toBe(true);
    expect(absent.absentReason!.length).toBeLessThanOrEqual(200);
  });

  it('ref-stage results forward the structured slice; full degrades to auto with a log', () => {
    const log = vi.fn();
    const s = stage('synthesis', { depends_on: ['scan'] });
    const all = [stage('scan', { type: 'command', ref: 'security-analyst@1.0.0', agents: undefined, forward: 'full' }), s];
    const prior: StageResult[] = [{
      id: 'scan', name: 'scan', type: 'command', status: 'completed',
      result: makeCommandResult({ name: 'security-analyst', decision: 'PASS', score: 91 }),
      durationMs: 10,
    }];
    const ctx = buildUpstreamContext(s, all, prior, log);
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.refLabel).toBe('command: security-analyst@1.0.0');
    expect(ctx[0]!.agentName).toBeUndefined();
    expect(ctx[0]!.fullText).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('degrades to auto'));
  });

  it('kill switch disables forwarding entirely', () => {
    process.env[UPSTREAM_KILL_SWITCH_ENV] = '1';
    const s = stage('synthesis', { depends_on: ['analysis'] });
    const ctx = buildUpstreamContext(s, [stage('analysis'), s], [completedAgentStage('analysis')]);
    expect(ctx).toHaveLength(0);
  });
});

// ─── Group 2: severity sort ──────────────────────────────────────────────

describe('severity sort (run #31 A2/F2)', () => {
  it('a critical finding in the LAST declared position survives into the top-5 slice', () => {
    // flattenRecommendations is category-declaration-ordered: model an upstream
    // agent whose first rubric categories yielded 6 low/info findings and whose
    // final category held the critical one.
    const recs = [
      { title: 'low-1', priority: 'backlog' as const, severity: 'low' as const },
      { title: 'info-1', priority: 'backlog' as const, severity: 'info' as const },
      { title: 'low-2', priority: 'backlog' as const, severity: 'low' as const },
      { title: 'info-2', priority: 'backlog' as const, severity: 'info' as const },
      { title: 'low-3', priority: 'backlog' as const, severity: 'low' as const },
      { title: 'info-3', priority: 'backlog' as const, severity: 'info' as const },
      { title: 'THE-CRITICAL', priority: 'critical' as const, severity: 'critical' as const },
    ];
    const s = stage('synthesis', { depends_on: ['analysis'] });
    const ctx = buildUpstreamContext(s, [stage('analysis'), s], [completedAgentStage('analysis', { recommendations: recs } as never)]);
    const slice = ctx[0]!.recommendations!;
    expect(slice).toHaveLength(5);
    expect(slice[0]!.title).toBe('THE-CRITICAL');
  });

  it('is stable within a severity tier (original order preserved)', () => {
    const recs = [
      { title: 'high-first', priority: 'critical' as const, severity: 'high' as const },
      { title: 'high-second', priority: 'critical' as const, severity: 'high' as const },
    ];
    const s = stage('x', { depends_on: ['a'] });
    const ctx = buildUpstreamContext(s, [stage('a'), s], [completedAgentStage('a', { recommendations: recs } as never)]);
    expect(ctx[0]!.recommendations!.map((r) => r.title)).toEqual(['high-first', 'high-second']);
  });
});

// ─── Group 3: caps + truncation ──────────────────────────────────────────

describe('caps and truncation', () => {
  it('caps a single oversized slice near the per-stage cap with a marker', () => {
    const entry: UpstreamStageContext = {
      stageId: 'big', agentName: 'big-agent', decision: 'PASS', decisionCategory: 'positive',
      score: 80, maxScore: 100,
      summary: 'S'.repeat(20_000),
      recommendations: [{ title: 'R'.repeat(2_000), severity: 'high' }],
    };
    const out = renderUpstreamSection([entry]);
    expect(out.length).toBeLessThanOrEqual(UPSTREAM_STAGE_SLICE_CAP + 1_000);
    expect(out).toContain('[upstream context truncated');
    expect(out).toContain('### big / big-agent'); // header floor
  });

  it('full entries get the larger cap', () => {
    const entry: UpstreamStageContext = {
      stageId: 'deep', agentName: 'deep-agent', decision: 'PASS', decisionCategory: 'positive',
      score: 80, maxScore: 100,
      fullText: headTailRetain('F'.repeat(50_000), 16_000, 8_000),
    };
    const out = renderUpstreamSection([entry]);
    expect(out.length).toBeGreaterThan(UPSTREAM_STAGE_SLICE_CAP);
    expect(out.length).toBeLessThanOrEqual(UPSTREAM_STAGE_FULL_CAP + 1_500);
  });

  it('total cap applies the tie-break and never drops headers (wide fan-in)', () => {
    const entries: UpstreamStageContext[] = Array.from({ length: 8 }, (_, i) => ({
      stageId: `up-${i}`, agentName: `agent-${i}`, decision: 'PASS', decisionCategory: 'positive',
      score: 80, maxScore: 100,
      summary: 'N'.repeat(7_000),
      recommendations: Array.from({ length: 5 }, (_, j) => ({ title: `f-${i}-${j} ` + 'x'.repeat(200), severity: 'medium' })),
    }));
    const out = renderUpstreamSection(entries);
    expect(out.length).toBeLessThanOrEqual(UPSTREAM_TOTAL_CAP + 2_000);
    for (let i = 0; i < 8; i++) expect(out).toContain(`### up-${i} / agent-${i}`);
    expect(out).toContain('[upstream context truncated');
  });

  it('header-only floor: headers survive even past the total cap, with the overflow marker', () => {
    const entries: UpstreamStageContext[] = Array.from({ length: 400 }, (_, i) => ({
      stageId: `stage-with-a-rather-long-identifier-${i}`,
      agentName: `agent-with-a-rather-long-name-${i}`,
      decision: 'PASS', decisionCategory: 'positive', score: 80, maxScore: 100,
    }));
    const out = renderUpstreamSection(entries);
    expect(out).toContain('header-only floor');
    for (const probe of [0, 199, 399]) {
      expect(out).toContain(`stage-with-a-rather-long-identifier-${probe}`);
    }
  });
});

// ─── Group 4: renderUpstreamSection shapes ───────────────────────────────

describe('renderUpstreamSection', () => {
  it('returns empty string (no section) for empty context', () => {
    expect(renderUpstreamSection([])).toBe('');
    expect(renderUpstreamSection(undefined)).toBe('');
  });

  it('renders the agent header with decision, score, and category', () => {
    const out = renderUpstreamSection([{
      stageId: 'analysis', agentName: 'confucius-analyst',
      decision: 'HARMONIOUS', decisionCategory: 'positive', score: 84, maxScore: 100,
      summary: 'Names mostly match functions.',
      recommendations: [{ title: 'Ritual gap', severity: 'high', filePath: 'src/foo.ts', lineNumber: 12 }],
    }]);
    expect(out).toContain('## Upstream Analysis');
    expect(out).toContain('### analysis / confucius-analyst — HARMONIOUS (84/100, category: positive)');
    expect(out).toContain('Summary: Names mostly match functions.');
    expect(out).toContain('- [high] Ritual gap (src/foo.ts:12)');
  });

  it('renders category: unclassified when decisionCategory is absent', () => {
    const out = renderUpstreamSection([{ stageId: 's', agentName: 'a', decision: 'ODD', score: null }]);
    expect(out).toContain('category: unclassified');
    expect(out).toContain('no score');
  });

  it('renders the ref-stage header shape', () => {
    const out = renderUpstreamSection([{
      stageId: 'scan', refLabel: 'command: security-analyst@1.0.0',
      decision: 'PASS', decisionCategory: 'positive', score: 91, maxScore: 100,
    }]);
    expect(out).toContain('### scan (command: security-analyst@1.0.0) — PASS (91/100, category: positive)');
  });

  it('renders labeled absences', () => {
    const out = renderUpstreamSection([{ stageId: 'broken', absent: true, absentReason: 'stage failed' }]);
    expect(out).toContain('### broken — no output (stage failed)');
  });
});

// ─── Group 5: complete message part sequence ─────────────────────────────

describe('buildInitialMessage part sequence (spec §5.5)', () => {
  it('orders preamble < Directive < Upstream Analysis < Target < tree < closing', async () => {
    const executor = new AgentExecutor({} as ResolvedConfig, {} as AIProvider, noopLogger);
    const toolHandler = {
      fulfill: async () => ({ content: 'src/index.ts (1 KB, 40 lines)\nsrc/util.py (2 KB, 80 lines)' }),
    } as unknown as ToolHandler;
    const input: ExecutionInput = {
      target: '/tmp/proj',
      prompt: 'Focus on security',
      upstreamContext: [{
        stageId: 'analysis', agentName: 'confucius-analyst',
        decision: 'HARMONIOUS', decisionCategory: 'positive', score: 84, maxScore: 100,
      }],
    };
    const msg: string = await (executor as unknown as {
      buildInitialMessage(i: ExecutionInput, t: ToolHandler, a: string): Promise<string>;
    }).buildInitialMessage(input, toolHandler, 'analyst');

    const idx = {
      preamble: msg.indexOf('Analyze the following project:'),
      directive: msg.indexOf('Directive:'),
      upstream: msg.indexOf('## Upstream Analysis'),
      target: msg.indexOf('Target: /tmp/proj'),
      tree: msg.indexOf('Project Structure:'),
      closing: msg.indexOf('Use the provided tools'),
    };
    for (const [name, i] of Object.entries(idx)) expect(i, `${name} present`).toBeGreaterThanOrEqual(0);
    expect(idx.preamble).toBeLessThan(idx.directive);
    expect(idx.directive).toBeLessThan(idx.upstream);
    expect(idx.upstream).toBeLessThan(idx.target);
    expect(idx.target).toBeLessThan(idx.tree);
    expect(idx.tree).toBeLessThan(idx.closing);
  });

  it('emits no upstream section when the context is absent', async () => {
    const executor = new AgentExecutor({} as ResolvedConfig, {} as AIProvider, noopLogger);
    const toolHandler = { fulfill: async () => ({ content: 'a.ts' }) } as unknown as ToolHandler;
    const msg: string = await (executor as unknown as {
      buildInitialMessage(i: ExecutionInput, t: ToolHandler, a: string): Promise<string>;
    }).buildInitialMessage({ target: '/tmp/proj' }, toolHandler, 'analyst');
    expect(msg).not.toContain('Upstream Analysis');
  });
});

// ─── Groups 6+7: pipeline-level forwarding, ordering contract, leak test ─

function makeForwardingPipeline(stage2Overrides?: Partial<StageDefinition>): ResolvedDefinition {
  return {
    type: 'pipeline',
    name: 'fwd-pipeline',
    version: '1.0.0',
    hash: 'sha256:pipe',
    yaml: '',
    definition: {
      pipeline: {
        interface: { name: 'fwd-pipeline', version: '1.0.0', displayName: 'F', description: 'd', domain: 'software' },
        stages: [
          { id: 'analysis', name: 'analysis', type: 'agents', agents: [{ ref: 'agent-a@1.0.0' }, { ref: 'agent-b@1.0.0' }] },
          { id: 'synthesis', name: 'synthesis', type: 'agents', agents: [{ ref: 'synth@1.0.0' }], depends_on: ['analysis'], ...stage2Overrides },
        ],
      },
    } as ResolvedDefinition['definition'],
    runtime: {} as ResolvedDefinition['runtime'],
    domain: 'software',
  };
}

function makeCapturingAgentExecutor(opts?: { delayFor?: Record<string, number> }): {
  executor: AgentExecutorType;
  inputs: Array<{ name: string; input: ExecutionInput }>;
} {
  const inputs: Array<{ name: string; input: ExecutionInput }> = [];
  const executor = {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition, input: ExecutionInput) => {
      const delay = opts?.delayFor?.[resolved.name];
      if (delay) await new Promise((r) => setTimeout(r, delay));
      inputs.push({ name: resolved.name, input });
      return makeValidatorResult({ name: resolved.name });
    }),
  } as unknown as AgentExecutorType;
  return { executor, inputs };
}

describe('PipelineExecutor forwarding integration', () => {
  it('downstream agents receive the upstream slice; upstream agents receive none', async () => {
    const { executor: agentExec, inputs } = makeCapturingAgentExecutor();
    const pipeline = new PipelineExecutor(makeWorkflowExecutor(), makeCommandExecutor(), agentExec, makeRegistry(), noopLogger);
    const sharedInput: ExecutionInput = { target: '/tmp/proj' };
    await pipeline.execute(makeForwardingPipeline(), sharedInput);

    const synthInput = inputs.find((c) => c.name === 'synth')!.input;
    expect(synthInput.upstreamContext).toBeDefined();
    expect(synthInput.upstreamContext!.map((e) => e.agentName)).toEqual(['agent-a', 'agent-b']);

    for (const c of inputs.filter((i) => i.name !== 'synth')) {
      expect(c.input.upstreamContext).toBeUndefined();
    }
    // Clone mandate (run #31 A6): the shared input object itself is never mutated.
    expect('upstreamContext' in sharedInput).toBe(false);
  });

  it('receives: none yields a clean context and leaks nothing (spec §5.7)', async () => {
    const { executor: agentExec, inputs } = makeCapturingAgentExecutor();
    const pipeline = new PipelineExecutor(makeWorkflowExecutor(), makeCommandExecutor(), agentExec, makeRegistry(), noopLogger);
    const sharedInput: ExecutionInput = { target: '/tmp/proj' };
    await pipeline.execute(makeForwardingPipeline({ receives: 'none' }), sharedInput);

    const synthInput = inputs.find((c) => c.name === 'synth')!.input;
    expect(synthInput.upstreamContext).toBeUndefined();
    expect('upstreamContext' in sharedInput).toBe(false);
  });

  it('parallel sibling results keep declaration order even when the first is slowest (spec §5.6)', async () => {
    const { executor: agentExec } = makeCapturingAgentExecutor({ delayFor: { 'agent-a': 50 } });
    const pipeline = new PipelineExecutor(makeWorkflowExecutor(), makeCommandExecutor(), agentExec, makeRegistry(), noopLogger);
    const result = await pipeline.execute(makeForwardingPipeline(), { target: '/tmp/proj' });

    const analysis = result.stages.find((s) => s.id === 'analysis')!;
    expect(analysis.agentResults!.map((r) => r.name)).toEqual(['agent-a', 'agent-b']);

    const synthesis = result.stages.find((s) => s.id === 'synthesis')!;
    expect(synthesis.status).toBe('completed');
  });
});

// ─── Group 8: normalization round-trip ───────────────────────────────────

describe('normalization round-trip', () => {
  it('forward/receives survive normalizePipelineSection unchanged', () => {
    const section = {
      stages: [
        { id: 'a', name: 'a', agents: [{ ref: 'x@1.0.0' }], forward: 'full' },
        { id: 'b', name: 'b', agents: [{ ref: 'y@1.0.0' }], depends_on: ['a'], receives: 'none' },
      ],
    };
    const out = normalizePipelineSection(section) as { stages: Array<Record<string, unknown>> };
    expect(out.stages[0]!['forward']).toBe('full');
    expect(out.stages[1]!['receives']).toBe('none');
    expect(out.stages[0]!['type']).toBe('agents');
  });
});
