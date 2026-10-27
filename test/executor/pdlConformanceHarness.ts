/**
 * Shared harness for the PDL 1.6.0 conformance fixtures (`test/fixtures/pdl-conformance/`, README =
 * the harness contract): the cases and their oracle, the README's wrapping rule, stub agents as core
 * resolves them, the canonical stub text, and `runCase`, which runs one case end to end through the
 * real PipelineExecutor and AgentExecutor and returns what SubmissionClient writes. Used by
 * pdl-conformance.test.ts and pdlP4bControls.test.ts. Not a test file.
 *
 * A test using `runCase` mocks `@uluops/ops-sdk`'s OpsClient so `runs.save` is the `save` it passes in.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Mock } from 'vitest';
import type { Logger } from '@uluops/sdk-core';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { PipelineError, CancelledError, TimeoutError } from '../../src/errors/index.js';
import type { StageResult, PipelineResult } from '../../src/types/pipeline.js';
import { SubmissionClient } from '../../src/submission/SubmissionClient.js';
import { normalizePipelineSection } from '../../src/registry/normalize.js';

export type Obj = Record<string, any>;
export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdl-conformance');
export const GROUPS = ['gates', 'decisions', 'conditions', 'steps', 'run-control', 'load-errors'];

export const cases: Obj[] = GROUPS.flatMap((g) => YAML.parse(readFileSync(path.join(FIX, 'cases', `${g}.cases.yaml`), 'utf8')).cases);
export const expected = new Map<string, Obj>(
  GROUPS.flatMap((g) => YAML.parse(readFileSync(path.join(FIX, 'expected', `${g}.expected.yaml`), 'utf8')).expected).map((e: Obj) => [e.id, e]),
);

/** The README's wrapping rule: `parameters` become the manual trigger's, with `target` prepended. */
export function wrap(c: Obj): Obj {
  const declared: Obj[] = c.pipeline.parameters ?? [];
  const parameters = declared.some((p) => p.name === 'target') ? declared : [{ name: 'target', type: 'string', required: true }, ...declared];
  return {
    pipeline: {
      interface: { name: `conf-${c.id.split('/')[1]}`, version: '0.0.0', displayName: `conf ${c.id}`, description: `PDL conformance case ${c.id}`, domain: 'general' },
      triggers: [{ type: 'manual', allowed: true, parameters }],
      stages: c.pipeline.stages.map((s: Obj) => ({ name: s.id, ...s })),
    },
  };
}

export const appliesToCore = (c: Obj): boolean => (c.applies_to ?? []).includes('core');


export const stubDefs = new Map<string, Obj>(
  (YAML.parse(readFileSync(path.join(FIX, 'stubs', 'agents.yaml'), 'utf8')).stubs as Obj[]).map((x) => [x.name, x]),
);

/** A stub agent as core resolves it: the ADL `agent:` body carries the type and the vocabulary. */
export function resolvedStub(name: string): ResolvedDefinition {
  const stub = stubDefs.get(name)!;
  return {
    type: 'agent', name, version: '1.0.0', hash: `sha256:${name}`, yaml: '', domain: 'software', agentType: stub.agentType,
    definition: { agent: { interface: { name, agentType: stub.agentType }, ...(stub.decisions ? { decisions: stub.decisions } : {}) } },
    runtime: { prompt: 'stub', defaults: { model: 'sonnet', timeout: 30000 }, config: { maxScore: 100, categories: [], outputSchema: 'json' } },
  } as unknown as ResolvedDefinition;
}

/** The README's canonical stub text (Stub outputs), byte for byte. */
export function stubText(out: Obj): string {
  if (typeof out.raw === 'string') return out.raw;
  const object = out.json ?? { result: {
    ...(out.score !== undefined ? { score: out.score, max_score: 100 } : {}),
    ...(out.decision !== undefined ? { decision: out.decision } : {}),
  } };
  return `Conformance stub output.\n${out.line !== undefined ? `Decision: ${out.line}\n` : ''}\`\`\`json\n${JSON.stringify(object)}\n\`\`\``;
}

export const VERDICT_CODES = new Set(['NEUTRAL_DECISION', 'ABSENT_DECISION', 'DECISION_CONFLICT', 'FALLBACK_DECISION_SOURCE', 'FALLBACK_SCORE_SOURCE', 'SCORE_INVALID']);
export const config = {
  apiKey: 'k', ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' }, registryUrl: 'https://r', submissionUrl: 'https://s',
  dashboardUrl: 'https://d', trackingEnabled: false, timeout: 30000, debug: false, defaultThinkingBudget: 10_000, contextBudget: 200_000, maxConcurrency: 8, allowStageSteps: false,
} as unknown as ResolvedConfig;
export const provider = (text: string) => ({
  generate: async () => ({ text, usage: { input_tokens: 1, output_tokens: 1 }, toolCallCount: 0, model: 'anthropic:stub', provider: 'anthropic', steps: 1, finishReason: 'stop' }),
  resolveModel: async () => ({ provider: 'anthropic', modelId: 'stub', providerModelId: 'stub', tier: 'premium', capabilities: { tools: true }, contextWindow: 200_000, resolvedFrom: 'sonnet' }),
  createProviderShellTool: () => undefined,
}) as unknown as AIProvider;


export type Launch = { stage: string; agent: string; upstream: Obj[]; timeoutMs?: number };

export async function runCase(c: Obj, targets: Record<string, string>, save: Mock) {
  const stageOf = new Map<string, string>();
  for (const s of c.pipeline.stages as Obj[]) for (const a of (s.agents ?? []) as Obj[]) stageOf.set(a.ref, s.id);
  const launches: Launch[] = [];
  const started = new Map<string, number>();
  let cancel: () => void = () => {};
  const events = (c.events ?? []) as Array<{ when: string; do: string }>;
  // Synchronous: `done` must land before the next stage launches. cancel() stops the run before its
  // first await, so the loop's next check sees it.
  const fire = (when: string) => { if (events.some(e => e.when === when && e.do === 'cancel')) cancel(); };

  const stubProvider = {
    generate: async (opts: { system: string; timeoutMs?: number; abortSignal?: AbortSignal }) => {
      const name = opts.system.replace(/^stub:/, '');
      const out = c.stubs?.[name] ?? {};
      const stage = stageOf.get(name)!;
      const n = (started.get(stage) ?? 0) + 1;
      started.set(stage, n);
      if (n === ((c.pipeline.stages as Obj[]).find(s => s.id === stage)!.agents as Obj[]).filter(a => !a.condition).length) fire(`stage:${stage}:running`);
      if (out.timeout) await new Promise((_r, reject) => setTimeout(() => reject(new TimeoutError(opts.timeoutMs ?? 0)), opts.timeoutMs ?? 0));
      if (out.hang) {
        await new Promise((_r, reject) => {
          if (opts.abortSignal?.aborted) reject(new CancelledError());
          opts.abortSignal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
        });
      }
      return { text: stubText(out), usage: { input_tokens: 1, output_tokens: 1 }, toolCallCount: 0, model: 'anthropic:stub', provider: 'anthropic', steps: 1, finishReason: 'stop' };
    },
    resolveModel: async () => ({ provider: 'anthropic', modelId: 'stub', providerModelId: 'stub', tier: 'premium', capabilities: { tools: true }, contextWindow: 200_000, resolvedFrom: 'sonnet' }),
    createProviderShellTool: () => undefined,
  } as unknown as AIProvider;

  const agentExecutor = new AgentExecutor(config, stubProvider, noopLogger);
  const realExecute = agentExecutor.execute.bind(agentExecutor);
  agentExecutor.execute = (async (resolved: ResolvedDefinition, input: Obj, options?: Obj) => {
    launches.push({ stage: stageOf.get(resolved.name)!, agent: resolved.name, upstream: (input.upstreamContext ?? []) as Obj[], timeoutMs: options?.timeoutMs as number | undefined });
    return realExecute(resolved, input as never, options as never);
  }) as typeof agentExecutor.execute;
  const registry = { resolve: async (name: string) => ({ ...resolvedStub(name), runtime: { ...resolvedStub(name).runtime, prompt: `stub:${name}` } }) };
  const executor = new PipelineExecutor({} as never, {} as never, agentExecutor, registry as never, noopLogger, c.run?.steps !== 'disabled');

  // `stage:<id>:done` wraps the executor's one per-stage judgement. Only cases with a `done` event need
  // the hook; one without it runs on a core that predates it (the negative controls do).
  const judge = (executor as unknown as { judgeStage?: (...a: unknown[]) => StageResult });
  if (events.some(e => e.when.endsWith(':done'))) {
    if (!judge.judgeStage) throw new Error(`${c.id}: this core has no judgeStage to fire a done event from`);
    const realJudge = judge.judgeStage.bind(executor);
    judge.judgeStage = (...a: unknown[]) => { const r = realJudge(...a); fire(`stage:${r.id}:done`); return r; };
  }

  // Through the normalization every loaded pipeline gets (registry and local YAML alike): it stamps
  // each stage's runtime `type` from its shape.
  const definition = { pipeline: normalizePipelineSection(wrap(c).pipeline) };
  const handle = await executor.start({ type: 'pipeline', name: definition.pipeline['interface'] ? `conf-${c.id}` : c.id, version: '0.0.0', hash: 'sha256:conf', definition } as never,
    { target: targets[c.target ?? 'dir']!, params: c.params ?? {} });
  cancel = () => { void handle.cancel().catch(() => {}); };
  const result = await handle.wait().catch((e: unknown) => (e as PipelineError).context.partialResult as PipelineResult);

  save.mockReset();
  save.mockResolvedValueOnce({ run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: null }, agents: [], correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 } });
  await new SubmissionClient({ ...config, trackingEnabled: true }, noopLogger).submit({ project: 'conf', workflowType: 'conf', result });
  const written = save.mock.calls[0]![0] as { summary: { allGatesPassed: boolean }; agents: Array<{ name: string; decision: string }>; rawMarkdown?: string };
  return { result, launches, written };
}
