/**
 * Run artifacts from core (0.60.0; effectiveness-analytics checklist P3-5, P3-9).
 *
 * P3-5's control is the first test: a provider whose `generate()` EDITS the target while the
 * agent runs, so an implementation that hashed at submission (after the run) would store the
 * edited revision. The stored hash must be the bytes at spawn. The real AgentExecutor and the
 * real SubmissionClient; only the model and `runs.save` are stubs.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@uluops/sdk-core';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { definitionPassThreshold } from '../../src/executor/runArtifacts.js';
import { SubmissionClient } from '../../src/submission/SubmissionClient.js';
import { CORE_WRITER_STAMP } from '../../src/version.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import type { AgentType } from '../../src/types/execution.js';
import pkg from '../../package.json' with { type: 'json' };

const mockSave = vi.fn();
vi.mock('@uluops/ops-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uluops/ops-sdk')>();
  return { ...actual, OpsClient: vi.fn(() => ({ runs: { save: mockSave, validate: vi.fn(), listByProject: vi.fn(), get: vi.fn() } })) };
});

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  apiKey: 'ulu_test', ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' }, registryUrl: 'https://r', submissionUrl: 'https://s',
  dashboardUrl: 'https://d', trackingEnabled: true, timeout: 30000, debug: false, defaultThinkingBudget: 10_000, contextBudget: 200_000, maxConcurrency: 8, allowStageSteps: false,
} as unknown as ResolvedConfig;
const REPORT = 'Report.\n```json\n' + JSON.stringify({ result: { decision: 'PASS', score: 90, max_score: 100 } }) + '\n```';
/** A provider that runs `during` while "the model works", then answers. */
const provider = (during: () => void = () => {}) => ({
  generate: async () => { during(); return { text: REPORT, usage: { input_tokens: 1, output_tokens: 1 }, toolCallCount: 0, model: 'anthropic:stub', provider: 'anthropic', steps: 1, finishReason: 'stop' }; },
  resolveModel: async () => ({ provider: 'anthropic', modelId: 'stub', providerModelId: 'stub', tier: 'premium', capabilities: { tools: true }, contextWindow: 200_000, resolvedFrom: 'sonnet' }),
  createProviderShellTool: () => undefined,
}) as unknown as AIProvider;
const agent = (agentType: AgentType, thresholds?: unknown) => ({
  type: 'agent', name: `a-${agentType}`, version: '1.0.0', hash: 'h', yaml: '', domain: 'software', agentType,
  definition: { agent: thresholds ? { decisions: { vocabulary: { positive: 'PASS', negative: 'FAIL' }, thresholds } } : {} },
  runtime: { prompt: 'p', defaults: { model: 'sonnet', timeout: 30000 }, config: { maxScore: 100, categories: [], outputSchema: 'json' } },
}) as unknown as ResolvedDefinition;
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

let repo = '';
let target = '';
beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'core-run-artifacts-')));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Uluops/Example.git']);
  target = path.join(repo, 'spec.md');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
beforeEach(() => {
  writeFileSync(target, 'revision A\n');
  mockSave.mockReset();
  mockSave.mockResolvedValue({ run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 90 }, agents: [], correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 } });
});

describe('P3-5 control: the stored hash is the revision at spawn', () => {
  it('an edit made while the agent runs, before the save, does not change the stored hash', async () => {
    const result = await new AgentExecutor(config, provider(() => writeFileSync(target, 'revision B, written mid-run\n')), noopLogger)
      .execute(agent('validator'), { target, artifactKind: 'spec' });
    await new SubmissionClient(config, noopLogger).submit({ project: 'p', workflowType: 'w', result });
    const sent = mockSave.mock.calls[0]![0] as { agents: Array<{ artifacts?: Array<{ hash: string }> }> };
    expect(sent.agents[0]!.artifacts![0]!.hash).toBe(sha('revision A\n'));
    expect(sent.agents[0]!.artifacts![0]!.hash).not.toBe(sha('revision B, written mid-run\n'));
  });
});

describe('what core sends for an instance', () => {
  it('a review agent with artifactKind: artifact, stageRole review, the definition threshold, writer stamps', async () => {
    const result = await new AgentExecutor(config, provider(), noopLogger)
      .execute(agent('validator', [{ decision: 'positive', min_score: 80 }, { decision: 'conditional', min_score: 60, max_score: 79 }]), { target, artifactKind: 'spec' });
    await new SubmissionClient(config, noopLogger).submit({ project: 'p', workflowType: 'w', result, writer: 'cli@9.9.9' });
    const sent = mockSave.mock.calls[0]![0] as { writer: string; agents: Array<Record<string, unknown>> };
    expect(sent.agents[0]).toMatchObject({
      stageRole: 'review', threshold: 80,
      artifacts: [{ kind: 'spec', kindSource: 'caller', repo: 'github.com/uluops/example', path: 'spec.md', hash: sha('revision A\n'), role: 'primary' }],
    });
    expect(sent.writer).toBe(`cli@9.9.9 ${CORE_WRITER_STAMP}`);
    expect(CORE_WRITER_STAMP).toBe(`core@${pkg.version}`);
  });

  it('a repository root target is path "." with a tree: hash (D65)', async () => {
    const result = await new AgentExecutor(config, provider(), noopLogger).execute(agent('analyst'), { target: repo, artifactKind: 'code' });
    expect(result.spawnArtifacts?.[0]).toMatchObject({ repo: 'github.com/uluops/example', path: '.', hash: expect.stringMatching(/^tree:[0-9a-f]{64}$/) });
  });

  it("the client's configured writer is used when the submission names none (how the CLI stamps ulu exec)", async () => {
    const result = await new AgentExecutor(config, provider(), noopLogger).execute(agent('validator'), { target });
    await new SubmissionClient({ ...config, writer: 'cli@1.2.3' }, noopLogger).submit({ project: 'p', workflowType: 'w', result });
    expect((mockSave.mock.calls[0]![0] as { writer: string }).writer).toBe(`cli@1.2.3 ${CORE_WRITER_STAMP}`);
  });

  it('no artifactKind: no artifact, but stageRole is still sent; no writer of its own: core is first', async () => {
    const result = await new AgentExecutor(config, provider(), noopLogger).execute(agent('validator'), { target });
    expect(result.spawnArtifacts).toBeUndefined();
    await new SubmissionClient(config, noopLogger).submit({ project: 'p', workflowType: 'w', result });
    const sent = mockSave.mock.calls[0]![0] as { writer: string; agents: Array<Record<string, unknown>> };
    expect(sent.agents[0]).toMatchObject({ stageRole: 'review' });
    expect(sent.agents[0]).not.toHaveProperty('artifacts');
    expect(sent.writer).toBe(CORE_WRITER_STAMP);
  });

  it.each([['executor', 'execute'], ['generator', 'generate']] as const)('a %s declares no artifact (D17) and is stageRole %s', async (type, role) => {
    const result = await new AgentExecutor(config, provider(), noopLogger).execute(agent(type), { target, artifactKind: 'code' });
    expect(result.spawnArtifacts).toBeUndefined();
    await new SubmissionClient(config, noopLogger).submit({ project: 'p', workflowType: 'w', result });
    expect((mockSave.mock.calls[0]![0] as { agents: Array<Record<string, unknown>> }).agents[0]).toMatchObject({ stageRole: role });
  });

  it('an artifactKind the tracker would refuse drops the artifact, not the run', async () => {
    const warn = vi.fn();
    const result = await new AgentExecutor(config, provider(), { ...noopLogger, warn }).execute(agent('validator'), { target, artifactKind: 'unknown' as never });
    expect(result.spawnArtifacts).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/artifactKind 'unknown' is not one of/);
    expect(result.decision).toBe('PASS');
  });

  it('a missing target is declared with hashError, and the run still runs', async () => {
    const result = await new AgentExecutor(config, provider(), noopLogger).execute(agent('validator'), { target: path.join(repo, 'gone.md'), artifactKind: 'spec' });
    expect(result.spawnArtifacts?.[0]).toMatchObject({ path: 'gone.md', hash: null, hashError: 'target does not exist at spawn' });
    expect(result.decision).toBe('PASS');
  });
});

describe('definitionPassThreshold (D55)', () => {
  it('is the lowest positive min_score, rounded to two decimals; absent otherwise', () => {
    expect(definitionPassThreshold(agent('validator', [{ decision: 'positive', min_score: 85 }, { decision: 'positive', min_score: 90 }]))).toBe(85);
    expect(definitionPassThreshold(agent('validator', [{ decision: 'positive', min_score: 66.6666 }]))).toBe(66.67);
    expect(definitionPassThreshold(agent('validator', [{ decision: 'conditional', min_score: 60 }]))).toBeUndefined();
    expect(definitionPassThreshold(agent('validator', [{ decision: 'positive', min_score: 120 }]))).toBeUndefined();
    expect(definitionPassThreshold(agent('validator'))).toBeUndefined();
  });
});
