/**
 * Submission analysis fidelity (spec v0.2.1, checklist v0.1.0). Every payload assertion here
 * validates the captured `runs.save` input against BOTH ops-sdk's `SaveRunInputSchema` (what
 * throws client-side) and the ops-api snapshot in test/fixtures/ops-api-save-schema.ts (what the
 * server rejects). The harness mocks `runs.save`, so neither schema runs unless asserted here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SaveRunInputSchema } from '@uluops/ops-sdk';
import { SubmissionClient } from '../../src/submission/SubmissionClient.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { AgentResult } from '../../src/types/agent.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import { OpsApiSaveRunAnalysisSchema } from '../fixtures/ops-api-save-schema.js';

const mockSave = vi.fn();
vi.mock('@uluops/ops-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uluops/ops-sdk')>();
  return {
    ...actual,
    OpsClient: vi.fn(() => ({ runs: { save: mockSave, validate: vi.fn(), listByProject: vi.fn(), get: vi.fn() } })),
  };
});

const warnings: string[] = [];
const testLogger = {
  warn: (msg: string) => { warnings.push(msg); },
  debug: () => {}, info: () => {}, error: () => {},
} as unknown as ConstructorParameters<typeof SubmissionClient>[1];

const baseConfig: ResolvedConfig = {
  apiKey: 'test-key',
  ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' },
  registryUrl: 'https://registry.example.com/api',
  submissionUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,
  timeout: 30000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
  maxConcurrency: 8,
  allowStageSteps: false,
};

const okSave = () => mockSave.mockResolvedValueOnce({
  run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
  agents: [], correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
});

/** The captured payload, checked against both schemas; returns the payload and both verdicts. */
function captured(): { input: Record<string, unknown>; sdkOk: boolean; apiOk: boolean; sdkIssues: unknown; apiIssues: unknown } {
  const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
  const sdk = SaveRunInputSchema.safeParse(input);
  const api = OpsApiSaveRunAnalysisSchema.safeParse(input);
  return {
    input,
    sdkOk: sdk.success, apiOk: api.success,
    sdkIssues: sdk.success ? null : sdk.error.issues.map(i => i.path.join('.')),
    apiIssues: api.success ? null : api.error.issues.map(i => i.path.join('.')),
  };
}

function agentDefinition(name = 'fence-agent'): ResolvedDefinition {
  return {
    type: 'agent', name, version: '1.0.0', hash: 'sha256:abc', yaml: '',
    definition: { agent: { interface: { name, version: '1.0.0', displayName: name, description: 'd', agentType: 'analyst', domain: 'software' } } },
    runtime: {} as ResolvedDefinition['runtime'],
  } as ResolvedDefinition;
}

/** An AgentResult whose report carries a ```json fence with `analysis` (Tier 1 source). */
function fenceAgent(analysis: Record<string, unknown>, name = 'fence-agent'): AgentResult {
  return {
    type: 'agent', agentType: 'analyst', name, version: '1.0.0', definitionHash: 'sha256:abc',
    decision: 'EXAMINED', score: 80, maxScore: 100, recommendations: [], durationMs: 1000,
    metrics: { inputTokens: 1, outputTokens: 1, totalEffectiveTokens: 2, durationMs: 1000, model: 'm' },
    rawOutput: '# Report\n\n```json\n' + JSON.stringify({ result: { decision: 'EXAMINED', score: 80 }, analysis }) + '\n```\n',
  } as AgentResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  warnings.length = 0;
});

describe('oracle fixture (checklist phase 0)', () => {
  it('control: a fractional category score passes ops-sdk and FAILS the ops-api snapshot', () => {
    const payload = {
      project: 'p', workflowType: 'agent',
      agents: [{ name: 'a', decision: 'PASS' }], recommendations: [],
      analysisSummary: { agentName: 'a', decision: 'PASS', categoryScores: [{ name: 'c', weight: 25, score: 7.5 }] },
    };
    expect(SaveRunInputSchema.safeParse(payload).success).toBe(true);
    expect(OpsApiSaveRunAnalysisSchema.safeParse(payload).success).toBe(false);
  });
});

describe('V11 — Tier-1 records are built from an allowlist (spec §1.5, D5)', () => {
  it('V11a: snake_case record_id/record_type from a template-conforming fence reaches the wire as recordId/recordType', async () => {
    okSave();
    const client = new SubmissionClient(baseConfig, testLogger);
    const result = fenceAgent({
      records: [{ record_id: 'A1', record_type: 'assumption', title: 'Something assumed', severity: 'high', data: { fragility: 7 } }],
    });
    await client.submit({ project: 'p', workflowType: 'agent', result, resolvedDefinition: agentDefinition() });

    const { input, sdkOk, apiOk, sdkIssues, apiIssues } = captured();
    const records = input.analysisRecords as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]!.recordId).toBe('A1');
    expect(records[0]!.recordType).toBe('assumption');
    expect({ sdkOk, sdkIssues }).toEqual({ sdkOk: true, sdkIssues: null });
    expect({ apiOk, apiIssues }).toEqual({ apiOk: true, apiIssues: null });
  });
});

// ─── helpers for composite runs ─────────────────────────────────────────────

function stampedAgent(name: string, opts: {
  vocab?: string | null; weights?: Record<string, number> | null; categories?: Array<{ name: string; score: number }>;
  rawOutput?: string; omitStamp?: boolean; recommendations?: AgentResult['recommendations'];
} = {}): AgentResult {
  const r: AgentResult = {
    type: 'agent', agentType: 'validator', name, version: '1.0.0', definitionHash: 'sha256:abc',
    decision: 'PASS', score: 80, maxScore: 100, recommendations: opts.recommendations ?? [], durationMs: 1000,
    metrics: { inputTokens: 1, outputTokens: 1, totalEffectiveTokens: 2, durationMs: 1000, model: 'm' },
    categories: opts.categories?.map(c => ({ name: c.name, score: c.score, maxScore: 25, findings: [] })),
    rawOutput: opts.rawOutput,
  };
  if (!opts.omitStamp) {
    r.decisionVocabulary = opts.vocab === undefined ? `${name.toUpperCase()}_OK/${name.toUpperCase()}_BAD` : opts.vocab;
    r.categoryWeights = opts.weights === undefined ? { Alpha: 30, Beta: 70 } : opts.weights;
  }
  return r;
}

const metrics = { inputTokens: 1, outputTokens: 1, totalEffectiveTokens: 2, durationMs: 1, model: 'm' };

function commandResult(name: string, agents: AgentResult[]): Record<string, unknown> {
  return { type: 'command', name, version: '1.0.0', definitionHash: 'sha256:c', decision: 'PASS', score: 80,
    recommendations: [], durationMs: 1, metrics, agentResults: agents };
}

/** inline stage, command stage, workflow stage (V3/V8 shapes). */
function threeShapePipeline(a: AgentResult, b: AgentResult, c: AgentResult): Record<string, unknown> {
  return {
    type: 'pipeline', name: 'p', version: '1.0.0', definitionHash: 'sha256:p', decision: 'PASS', score: 80,
    status: 'complete', allGatesPassed: true, warnings: [], recommendations: [], durationMs: 1,
    metrics: { ...metrics, stagesExecuted: 3, stagesPassed: 3, stagesFailed: 0, stagesWarned: 0, stagesErrored: 0, stagesSkipped: 0 },
    stages: [
      { id: 's1', name: 's1', type: 'command', status: 'completed', result: commandResult('inline-cmd', []), agentResults: [a] },
      { id: 's2', name: 's2', type: 'command', status: 'completed', result: commandResult('cmd', [b]) },
      { id: 's3', name: 's3', type: 'workflow', status: 'completed', result: {
        type: 'workflow', name: 'wf', version: '1.0.0', definitionHash: 'sha256:w', decision: 'PASS', score: 80,
        recommendations: [], durationMs: 1, metrics,
        phases: [{ name: 'ph', decision: 'PASS', commands: [commandResult('wf-cmd', [c])] }],
      } },
    ],
  };
}

describe('V2 — stamped facts, unstamped results, declared-none (D1, D2)', () => {
  it('a serialized stamped result carries its vocabulary and weights; no warning', async () => {
    okSave();
    const result = JSON.parse(JSON.stringify(stampedAgent('alpha', { categories: [{ name: 'Alpha', score: 20 }, { name: 'Beta', score: 10 }] })));
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result });
    const { input, sdkOk, apiOk } = captured();
    const summary = input.analysisSummary as Record<string, unknown>;
    expect(summary.decisionVocabulary).toBe('ALPHA_OK/ALPHA_BAD');
    expect(summary.categoryScores).toEqual([{ name: 'Alpha', weight: 30, score: 20 }, { name: 'Beta', weight: 70, score: 10 }]);
    expect(warnings.some(w => w.includes('unavailable'))).toBe(false);
    expect([sdkOk, apiOk]).toEqual([true, true]);
  });

  it('an unstamped result is still extracted, and one warning names it', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('legacy', { omitStamp: true }) });
    const summary = captured().input.analysisSummary as Record<string, unknown>;
    expect(summary.decision).toBe('PASS');
    expect(summary.decisionVocabulary).toBeNull();
    const w = warnings.filter(m => m.includes('unavailable'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"legacy"');
  });

  it('control: a definition that declares no scoring (null stamp) does NOT warn', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('scoreless', { weights: null, vocab: null }) });
    expect(warnings.some(w => w.includes('unavailable'))).toBe(false);
  });

  it('a deserialized categoryWeights with a __proto__ key or non-finite values is read safely', async () => {
    okSave();
    const result = stampedAgent('safe', { categories: [{ name: 'Alpha', score: 20 }] });
    result.categoryWeights = JSON.parse('{"__proto__": {"polluted": 1}, "Alpha": 40, "Beta": "x"}');
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result });
    const summary = captured().input.analysisSummary as { categoryScores: Array<{ weight: number }> };
    expect(summary.categoryScores[0]!.weight).toBe(40);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('V3 — composite runs: one summary per agent, each its own facts (D1, D3)', () => {
  it('inline, command and workflow stages each submit their own summary with their own vocabulary and weights', async () => {
    okSave();
    const a = stampedAgent('a', { weights: { Alpha: 30, Beta: 70 }, categories: [{ name: 'Alpha', score: 20 }, { name: 'Beta', score: 15 }] });
    const b = stampedAgent('b', { weights: { Alpha: 10, Beta: 90 }, categories: [{ name: 'Alpha', score: 5 }, { name: 'Beta', score: 50 }] });
    const c = stampedAgent('c', { rawOutput: '```json\n' + JSON.stringify({ analysis: { category_scores: [{ name: 'Own', weight: 55, score: 40 }] } }) + '\n```' });
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'pipeline', result: threeShapePipeline(a, b, c) as never });
    const { input, sdkOk, apiOk } = captured();
    const summaries = input.analysisSummary as Array<Record<string, unknown>>;
    expect(summaries.map(s => s.agentName)).toEqual(['a', 'b', 'c']);
    expect(summaries.map(s => s.decisionVocabulary)).toEqual(['A_OK/A_BAD', 'B_OK/B_BAD', 'C_OK/C_BAD']);
    expect(summaries[0]!.categoryScores).toEqual([{ name: 'Alpha', weight: 30, score: 20 }, { name: 'Beta', weight: 70, score: 15 }]);
    expect(summaries[1]!.categoryScores).toEqual([{ name: 'Alpha', weight: 10, score: 5 }, { name: 'Beta', weight: 90, score: 50 }]);
    // The agent's own block wins, weights included (spec G1).
    expect(summaries[2]!.categoryScores).toEqual([{ name: 'Own', weight: 55, score: 40 }]);
    expect([sdkOk, apiOk]).toEqual([true, true]);
  });
});

describe('V4 — summary cap at 20 (D3)', () => {
  it('21 children send 20 summaries, tally 1, warn, and add NO marker recommendation', async () => {
    okSave();
    const agents = Array.from({ length: 21 }, (_, i) => stampedAgent(`agent-${i}`));
    const client = new SubmissionClient(baseConfig, testLogger);
    const response = await client.submit({ project: 'p', workflowType: 'command', result: commandResult('wide', agents) as never });
    const { input } = captured();
    expect((input.analysisSummary as unknown[]).length).toBe(20);
    expect(response.truncated?.analysisSummaries).toBe(1);
    expect(warnings.some(w => w.includes('exceeding the wire limit of 20') && w.includes('agent-20'))).toBe(true);
    expect((input.recommendations as Array<{ title: string }>).some(r => r.title.includes('truncated'))).toBe(false);
  });
});

// V5 was "per-summary isolation (D4)": a summary that failed ops-sdk's entry schema was dropped.
// Removed in 0.58.0 (analysis-never-loses-the-run R3): the tracker judges each agent, keeps the
// run, and reports `analysisRejected`. The case below is the old V5 input. Its 101-character
// category name fails ops-sdk's AnalysisSummaryEntrySchema but passes the API's (category `name`
// has no cap there), so 0.57.0 dropped a summary the tracker stores. Control: on e1844cf
// (the 0.58.0 branch before this change) the summary is absent from the payload.
describe('V5 — summaries are sent, not pre-judged (D4 removed, 0.58.0)', () => {
  it('a summary the SDK entry schema refuses is sent unchanged; no drop is counted or logged', async () => {
    okSave();
    const bad = stampedAgent('bad', { rawOutput: '```json\n' + JSON.stringify({ analysis: {
      category_scores: [{ name: 'x'.repeat(101), weight: 50, score: 10 }],
      records: [{ recordId: 'B1', recordType: 'fear', title: 'kept', data: {} }],
    } }) + '\n```' });
    const good = stampedAgent('good', { categories: [{ name: 'Alpha', score: 5 }] });
    const response = await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'command', result: commandResult('c', [bad, good]) as never });
    const { input, sdkOk, apiOk } = captured();
    const sent = input.analysisSummary as Array<{ agentName: string; categoryScores?: Array<{ name: string }> }>;
    expect(sent.map(s => s.agentName)).toEqual(['bad', 'good']);
    expect(sent[0]?.categoryScores?.[0]?.name).toHaveLength(101);
    expect(response.truncated?.analysisSummariesInvalid).toBe(0);
    expect(warnings.some(m => m.includes('the tracker would reject'))).toBe(false);
    expect((input.analysisRecords as Array<{ recordId: string }>).some(r => r.recordId === 'B1')).toBe(true);
    // The instrument: the old proxy refuses this summary, the API's schema accepts it.
    const { AnalysisSummaryEntrySchema } = await import('@uluops/ops-sdk');
    expect(AnalysisSummaryEntrySchema.safeParse(sent[0]).success).toBe(false);
    expect([sdkOk, apiOk]).toEqual([true, true]);
  });
});

describe('V6 — record key guard (D5)', () => {
  const keysOf = () => (captured().input.analysisRecords as Array<{ recordId: string }>).map(r => r.recordId);
  const fenceRecords = (ids: string[]) => '```json\n' + JSON.stringify({ analysis: {
    records: ids.map(id => ({ recordId: id, recordType: 'finding', title: `t-${id}`, data: {} })),
  } }) + '\n```';

  it('repeated Tier-4 failure codes are suffixed; the first occurrence keeps its id', async () => {
    okSave();
    const result = stampedAgent('a', { recommendations: [
      { agent: 'a', title: 'one', priority: 'suggested', failureCode: 'STR-OMI/M' },
      { agent: 'a', title: 'two', priority: 'suggested', failureCode: 'STR-OMI/M' },
    ] as AgentResult['recommendations'] });
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result });
    expect(keysOf()).toEqual(['STR-OMI/M', 'STR-OMI/M~2']);
  });

  it('folded duplicates (A, a) are suffixed; an agent\'s own x~2 keeps its id (x, x, x~2 → x, x~3, x~2)', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('a', { rawOutput: fenceRecords(['A', 'a', 'x', 'x', 'x~2']) }) });
    expect(keysOf()).toEqual(['A', 'a~2', 'x', 'x~3', 'x~2']);
  });

  it('a 100-character id that collides is suffixed within 100 characters', async () => {
    okSave();
    const long = 'L'.repeat(100);
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('a', { rawOutput: fenceRecords([long, long]) }) });
    const ids = keysOf();
    expect(ids[1]).toHaveLength(100);
    expect(ids[1]!.endsWith('~2')).toBe(true);
    expect(captured().sdkOk).toBe(true);
  });

  it('is deterministic: the same result gives the same ids', async () => {
    const result = stampedAgent('a', { rawOutput: fenceRecords(['x', 'x', 'X', 'y']) });
    okSave(); okSave();
    const client = new SubmissionClient(baseConfig, testLogger);
    await client.submit({ project: 'p', workflowType: 'agent', result });
    await client.submit({ project: 'p', workflowType: 'agent', result });
    const ids = (n: number) => (mockSave.mock.calls[n]![0].analysisRecords as Array<{ recordId: string }>).map(r => r.recordId);
    expect(ids(0)).toEqual(ids(1));
  });
});

describe('V7 — API-only bounds repaired at assembly (D6)', () => {
  const block = (analysis: Record<string, unknown>) => '```json\n' + JSON.stringify({ analysis }) + '\n```';

  it('fractional and non-finite category scores and weights are repaired to integers', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('a', { rawOutput: block({
      category_scores: [{ name: 'A', weight: 25.4, score: 7.5 }, { name: 'B', weight: null, score: 3 }, { name: 'C', weight: 10, score: null }],
    }) }) });
    const { input, sdkOk, apiOk } = captured();
    expect((input.analysisSummary as { categoryScores: unknown }).categoryScores).toEqual([
      { name: 'A', weight: 25, score: 8 },
      { name: 'B', weight: 33, score: 3 },
    ]);
    expect([sdkOk, apiOk]).toEqual([true, true]);
  });

  it('maps over 20, sections over 50 and non-object section items are repaired', async () => {
    okSave();
    const map = (n: number) => ({ metadata: { explorerName: 'e', framework: 'f' },
      sections: Array.from({ length: n }, (_, i) => ({ type: 'inventory', label: `s${i}`, items: [{ k: i }, 'loose string'] })) });
    const result = stampedAgent('a');
    result.rawJson = { explorationMaps: [map(60), ...Array.from({ length: 20 }, () => map(1))] };
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result });
    const { input, sdkOk, apiOk } = captured();
    const maps = (input.analysisSummary as { explorationMaps: Array<{ sections: Array<{ items: unknown[] }> }> }).explorationMaps;
    expect(maps).toHaveLength(20);
    expect(maps[0]!.sections).toHaveLength(50);
    expect(maps[0]!.sections[0]!.items).toEqual([{ k: 0 }]);
    expect([sdkOk, apiOk]).toEqual([true, true]);
  });

  it('a 501-character audit implication is truncated, not the summary dropped', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('a', { rawOutput: block({ audit_implications: ['z'.repeat(501)] }) }) });
    const { input, sdkOk } = captured();
    const ai = (input.analysisSummary as { auditImplications: string[] }).auditImplications;
    expect(ai[0]).toHaveLength(500);
    expect(ai[0]!.endsWith('…')).toBe(true);
    expect(sdkOk).toBe(true);
  });

  it('oversized or over-deep blobs become null, and oversized record data a stub', async () => {
    okSave();
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('a', { rawOutput: block({
      system_metrics: { big: 'x'.repeat(70 * 1024) },
      epistemic_assessment: deep,
      records: [{ recordId: 'R1', recordType: 'finding', title: 't', data: { big: 'y'.repeat(70 * 1024) } }],
    }) }) });
    const { input, sdkOk, apiOk, apiIssues } = captured();
    const summary = input.analysisSummary as Record<string, unknown>;
    expect(summary.systemMetrics).toBeNull();
    expect(summary.epistemicAssessment).toBeNull();
    expect((input.analysisRecords as Array<{ data: Record<string, unknown> }>)[0]!.data).toHaveProperty('omitted');
    expect({ sdkOk, apiOk, apiIssues }).toEqual({ sdkOk: true, apiOk: true, apiIssues: null });
  });

  it('category names match declared weights by normalised name; an unmatched one gets the equal share and a warning', async () => {
    okSave();
    // Normalisation is lowercase + each run of non-alphanumerics → one space, so 'scale-and-scope'
    // matches 'Scale and Scope', while 'Scale & Scope' ('scale scope') does not: no synonym rules.
    const result = stampedAgent('a', { weights: { 'Scale and Scope': 60, 'Other': 40 }, categories: [{ name: 'scale-and-scope', score: 10 }, { name: 'Scale & Scope', score: 5 }] });
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result });
    const scores = (captured().input.analysisSummary as { categoryScores: Array<{ name: string; weight: number }> }).categoryScores;
    expect(scores).toEqual([{ name: 'scale-and-scope', weight: 60, score: 10 }, { name: 'Scale & Scope', weight: 50, score: 5 }]);
    expect(warnings.some(w => w.includes('matched no declared category') && w.includes('"Scale & Scope"'))).toBe(true);
  });
});

describe('V8 — analysis reaches every agent in every composite shape (D3)', () => {
  it('inline, command-stage and workflow-stage agents all get a summary; hand-written expectation', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'pipeline',
      result: threeShapePipeline(stampedAgent('inline-agent'), stampedAgent('command-stage-agent'), stampedAgent('workflow-stage-agent')) as never });
    const { input } = captured();
    expect((input.analysisSummary as Array<{ agentName: string }>).map(s => s.agentName))
      .toEqual(['inline-agent', 'command-stage-agent', 'workflow-stage-agent']);
    // The rows' agent-sourced names must agree (rows have their own traversal; this is the cross-check).
    const rowNames = (input.agents as Array<{ name: string }>).map(a => a.name);
    for (const name of ['inline-agent', 'command-stage-agent', 'workflow-stage-agent']) expect(rowNames).toContain(name);
  });

  it('a standalone workflow and a command both reach their agents', async () => {
    okSave(); okSave();
    const client = new SubmissionClient(baseConfig, testLogger);
    await client.submit({ project: 'p', workflowType: 'workflow', result: {
      type: 'workflow', name: 'wf', version: '1.0.0', definitionHash: 'sha256:w', decision: 'PASS', score: 80,
      recommendations: [], durationMs: 1, metrics,
      phases: [{ name: 'ph', decision: 'PASS', commands: [commandResult('c1', [stampedAgent('wf-a')]), commandResult('c2', [stampedAgent('wf-b')])] }],
    } as never });
    await client.submit({ project: 'p', workflowType: 'command', result: commandResult('c', [stampedAgent('cmd-a')]) as never });
    const names = (n: number) => (mockSave.mock.calls[n]![0].analysisSummary as Array<{ agentName: string }>).map(s => s.agentName);
    expect(names(0)).toEqual(['wf-a', 'wf-b']);
    expect(names(1)).toEqual(['cmd-a']);
  });
});

describe('V11 b-e — Tier-1 allowlist (D5)', () => {
  const fence = (records: unknown[]) => '```json\n' + JSON.stringify({ analysis: { records } }) + '\n```';
  it('drops agentType, coerces a numeric id, and attributes empty or foreign names to the agent', async () => {
    okSave();
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent', result: stampedAgent('me', { rawOutput: fence([
      { recordId: 'T1', recordType: 'finding', title: 't1', agentType: 'lens', data: {} },
      { record_id: 7, record_type: 'finding', title: 't2', data: {} },
      { recordId: 'T3', recordType: 'finding', title: 't3', agentName: '', data: {} },
      { recordId: 'T4', recordType: 'finding', title: 't4', agentName: 'other', data: { a: 1 } },
    ]) }) });
    const { input, sdkOk, apiOk } = captured();
    const recs = input.analysisRecords as Array<Record<string, unknown>>;
    expect(recs[0]).not.toHaveProperty('agentType');
    expect(recs[1]!.recordId).toBe('7');
    expect(recs.map(r => r.agentName)).toEqual(['me', 'me', 'me', 'me']);
    expect(recs[3]!.data).toEqual({ a: 1, declaredAgentName: 'other' });
    expect([sdkOk, apiOk]).toEqual([true, true]);
  });
});

describe('V12 — byte guard keeps the body under the tracker limit (D7)', () => {
  it('a payload over 1.9 MiB is trimmed from the tail and tallied', async () => {
    okSave();
    const big = (i: number) => stampedAgent(`big-${i}`, { rawOutput: '```json\n' + JSON.stringify({ analysis: {
      system_metrics: { pad: 'p'.repeat(60 * 1024) }, epistemic_assessment: { pad: 'q'.repeat(60 * 1024) },
    } }) + '\n```' });
    const response = await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'command',
      result: commandResult('c', Array.from({ length: 20 }, (_, i) => big(i))) as never });
    const { input } = captured();
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(Math.floor(1.9 * 1024 * 1024));
    expect(response.truncated!.analysisSummaries).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('body limit'))).toBe(true);
  });
});

describe('V13 — warning lines carry no control characters (D8)', () => {
  it('a category name with a newline and an ANSI escape is cleaned and capped', async () => {
    okSave();
    const evil = 'bad\nname\u001b[31m' + 'z'.repeat(200);
    await new SubmissionClient(baseConfig, testLogger).submit({ project: 'p', workflowType: 'agent',
      result: stampedAgent('a', { weights: { Alpha: 100 }, categories: [{ name: evil, score: 1 }] }) });
    const w = warnings.find(m => m.includes('matched no declared category'))!;
    expect(w).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(w)).toBe(false);
    expect(w).not.toContain('z'.repeat(150));
  });
});
