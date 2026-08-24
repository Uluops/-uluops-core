import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubmissionClient } from '../../src/submission/SubmissionClient.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { RunSubmission } from '../../src/types/submission.js';
import type { ExecutionResult } from '../../src/types/execution.js';
import type { AgentResult } from '../../src/types/agent.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import type { WorkflowResult } from '../../src/types/workflow.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';

// Mock the ops SDK
const mockSave = vi.fn();
const mockValidate = vi.fn();
const mockListByProject = vi.fn();
const mockGet = vi.fn();

// Spread the real module and replace only OpsClient. SubmissionClient validates
// recommendations against the SDK's own exported schemas (FailureCodeSchema,
// FailureDomainSchema, SeveritySchema, PrioritySchema); stubbing the module wholesale
// would leave those undefined and test a sanitizer that cannot actually validate.
vi.mock('@uluops/ops-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uluops/ops-sdk')>();
  return {
    ...actual,
    OpsClient: vi.fn(() => ({
      runs: {
        save: mockSave,
        validate: mockValidate,
        listByProject: mockListByProject,
        get: mockGet,
      },
    })),
  };
});

/** Captures warnings so repair-reporting can be asserted, not just assumed. */
const warnings: string[] = [];
const testLogger = {
  warn: (msg: string) => { warnings.push(msg); },
  debug: () => {},
  info: () => {},
  error: () => {},
} as unknown as ConstructorParameters<typeof SubmissionClient>[1];

const baseConfig: ResolvedConfig = {
  apiKey: 'test-key',
  ai: {
    providers: { anthropic: { apiKey: 'test-anthropic-key' } },
    defaultProvider: 'anthropic',
  },
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

function makeResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    type: 'command',
    name: 'code-validator',
    version: '1.0.0',
    definitionHash: 'sha256:abc',
    decision: 'PASS',
    score: 85,
    durationMs: 5000,
    recommendations: [
      {
        agent: 'code-validator',
        title: 'Add missing type annotation',
        priority: 'suggested',
        severity: 'medium',
        filePath: 'src/index.ts',
        lineNumber: 42,
        description: 'Missing return type',
      },
    ],
    metrics: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 100,
      // Both of these were DROPPED by extractTokens despite existing on the wire type.
      cachedInputTokens: 300,
      reasoningOutputTokens: 400,
      totalEffectiveTokens: 1300,
      durationMs: 5000,
      model: 'claude-sonnet-4-5-20250929',
      harness: 'uluops-core',
    },
    ...overrides,
  };
}

function makeSubmission(overrides?: Partial<RunSubmission>): RunSubmission {
  return {
    project: 'test-project',
    workflowType: 'post-implementation',
    result: makeResult(),
    ...overrides,
  };
}

/** Minimal AgentResult carrying N Tier-2 structured analysis records via rawJson. */
function makeAgentResultWithRecords(namePrefix: string, count: number): AgentResult {
  return {
    type: 'agent',
    agentType: 'validator',
    name: `${namePrefix}-validator`,
    version: '1.0.0',
    definitionHash: 'sha256:abc',
    decision: 'PASS',
    score: 85,
    maxScore: 100,
    recommendations: [],
    durationMs: 1000,
    metrics: {
      inputTokens: 100, outputTokens: 50, totalEffectiveTokens: 150,
      durationMs: 1000, model: 'claude-sonnet-4-5-20250929',
    },
    rawJson: {
      analysisRecords: Array.from({ length: count }, (_, i) => ({
        recordType: 'evidence_finding',
        recordId: `${namePrefix}-${i}`,
        title: `${namePrefix} finding ${i}`,
        data: {},
      })),
    },
  };
}

/** Minimal ResolvedDefinition sufficient for AnalysisSummaryExtractor.extract(). */
function makeResolvedDefinitionForAnalysis(): ResolvedDefinition {
  return {
    type: 'agent',
    name: 'test-validator',
    version: '1.0.0',
    hash: 'sha256:abc',
    yaml: '',
    definition: {
      agent: {
        interface: {
          name: 'test-validator',
          version: '1.0.0',
          displayName: 'Test Validator',
          description: 'A test validator',
          agentType: 'validator',
          domain: 'software',
        },
      },
    },
    runtime: {} as ResolvedDefinition['runtime'],
  } as ResolvedDefinition;
}

/** Minimal PipelineResult whose stages carry preserved agentResults (inline-agent stages). */
function makePipelineResultWithAgents(stageAgentCounts: number[][]): PipelineResult {
  return {
    type: 'pipeline',
    name: 'test-pipeline',
    version: '1.0.0',
    definitionHash: 'sha256:pipe',
    decision: 'PASS',
    score: 88,
    status: 'complete',
    recommendations: [],
    durationMs: 5000,
    metrics: {
      inputTokens: 2000, outputTokens: 800, totalEffectiveTokens: 2800,
      durationMs: 5000, model: 'mixed',
      stagesExecuted: stageAgentCounts.length, stagesPassed: stageAgentCounts.length,
      stagesFailed: 0, stagesWarned: 0, stagesSkipped: 0,
    },
    stages: stageAgentCounts.map((agentCounts, stageIdx) => ({
      id: `stage-${stageIdx}`,
      name: `stage-${stageIdx}`,
      type: 'command' as const,
      status: 'completed' as const,
      result: {
        type: 'command' as const,
        agentType: 'validator' as const,
        name: `stage-${stageIdx}-command`,
        version: '1.0.0',
        definitionHash: 'sha256:cmd',
        decision: 'PASS',
        score: 85,
        maxScore: 100,
        recommendations: [],
        durationMs: 1000,
        metrics: {
          inputTokens: 100, outputTokens: 50, totalEffectiveTokens: 150,
          durationMs: 1000, model: 'claude-sonnet-4-5-20250929', toolCalls: 0,
        },
      },
      agentResults: agentCounts.map((count, agentIdx) =>
        makeAgentResultWithRecords(`s${stageIdx}a${agentIdx}`, count),
      ),
    })),
  };
}

describe('SubmissionClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warnings.length = 0;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // recommendation sanitization
  //
  // RecommendationInputSchema validates CLIENT-SIDE inside ops-sdk, before any HTTP
  // call, so one malformed field on one recommendation used to abort the entire
  // runs.save payload — every agent's output and all analysis records for the run.
  // These assert the two halves of the policy together: the save survives, AND the
  // repair is reported. Asserting only "did not throw" would pass just as well on a
  // sanitizer that silently dropped everything.
  // ─────────────────────────────────────────────────────────────────────────────

  describe('recommendation sanitization', () => {
    const okSave = () => mockSave.mockResolvedValueOnce({
      run: { id: 'r', projectId: 'p', runNumber: 1, workflowType: 'w', allGatesPassed: true, averageScore: 1 },
      agents: [], correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
    });
    const sentRecs = () => mockSave.mock.calls[0]![0].recommendations[0];

    async function submitWith(rec: Record<string, unknown>) {
      okSave();
      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({
        result: makeResult({ recommendations: [rec as never] }),
      }));
      return sentRecs();
    }

    it('omits a malformed failureDomain instead of aborting the whole save', async () => {
      const sent = await submitWith({
        agent: 'a', title: 't', priority: 'high', failureDomain: 'Structural',
      });
      expect(mockSave).toHaveBeenCalledOnce();          // the save happened at all
      expect(sent.failureDomain).toBeUndefined();
      expect(warnings.join(' ')).toContain('failureDomain');
    });

    it('reports a stripped failureCode instead of dropping it silently', async () => {
      const sent = await submitWith({
        agent: 'a', title: 't', priority: 'high', failureCode: 'PRA-FRA/High',
      });
      expect(sent.failureCode).toBeUndefined();
      expect(warnings.join(' ')).toContain('PRA-FRA/High');
    });

    it('keeps an off-taxonomy failureMode the wire accepts, but says so', async () => {
      const sent = await submitWith({
        agent: 'a', title: 't', priority: 'high', failureMode: 'validation',
      });
      // Rule 2: never drop a value the wire would have accepted.
      expect(sent.failureMode).toBe('validation');
      expect(warnings.join(' ')).toContain('off-taxonomy');
    });

    it('coerces an invalid required priority rather than losing the run', async () => {
      const sent = await submitWith({ agent: 'a', title: 't', priority: 'URGENT' });
      expect(sent.priority).toBe('suggested');
      expect(warnings.join(' ')).toContain('coerced');
    });

    it('truncates an over-length title to the wire maximum', async () => {
      const sent = await submitWith({ agent: 'a', title: 'x'.repeat(600), priority: 'high' });
      expect(sent.title).toHaveLength(500);
      expect(warnings.join(' ')).toContain('truncated');
    });

    // Control. Without this, every assertion above would also pass on a sanitizer that
    // warned about and mangled everything it touched.
    it('passes a well-formed recommendation through untouched and silently', async () => {
      const clean = {
        agent: 'code-validator', title: 'Real finding', priority: 'high',
        severity: 'high', failureCode: 'STR-OMI/H', failureDomain: 'STR', failureMode: 'OMI',
      };
      const sent = await submitWith(clean);
      expect(sent).toMatchObject(clean);
      expect(warnings).toEqual([]);
    });

    // repairedRecommendations: the run-level tally on RunSubmissionResponse. Before this,
    // the cost of a repair (invented/off-taxonomy failure codes, oversize fields) was
    // recorded only as one logger.warn per recommendation and then went out of scope —
    // no counter, no metric, no payload field, no aggregation across the run.
    describe('repairedRecommendations count', () => {
      it('counts exactly the recommendations that needed repair, out of the total', async () => {
        okSave();
        const client = new SubmissionClient(baseConfig, testLogger);
        const response = await client.submit(makeSubmission({
          result: makeResult({
            recommendations: [
              { agent: 'a', title: 'ok', priority: 'high' },
              { agent: 'a', title: 'bad priority', priority: 'nonsense' as never },
              { agent: 'a', title: 'x'.repeat(600), priority: 'high' },
            ],
          }),
        }));

        expect(response.repairedRecommendations).toBe(2);
        // Per-recommendation detail warns still fire alongside the run-level tally.
        expect(warnings.some(w => w.includes('coerced'))).toBe(true);
        expect(warnings.some(w => w.includes('truncated'))).toBe(true);
        expect(warnings.some(w => w.includes('Submission repaired 2 of 3 recommendations'))).toBe(true);
      });

      // Positive control (required): without this, a counter fixed at a constant would
      // pass the test above just as well.
      it('control: an all-clean run reports 0 repaired recommendations', async () => {
        okSave();
        const client = new SubmissionClient(baseConfig, testLogger);
        const response = await client.submit(makeSubmission({
          result: makeResult({
            recommendations: [
              { agent: 'a', title: 'ok one', priority: 'high' },
              { agent: 'a', title: 'ok two', priority: 'backlog' },
            ],
          }),
        }));

        expect(response.repairedRecommendations).toBe(0);
        expect(warnings).toEqual([]);
      });

      it('reports 0 for the tracking-disabled local response when nothing needed repair', async () => {
        const client = new SubmissionClient({ ...baseConfig, trackingEnabled: false }, testLogger);
        const response = await client.submit(makeSubmission({
          result: makeResult({ recommendations: [{ agent: 'a', title: 'ok', priority: 'high' }] }),
        }));
        expect(response.repairedRecommendations).toBe(0);
      });

      it('counts repairs for the tracking-disabled local response too', async () => {
        const client = new SubmissionClient({ ...baseConfig, trackingEnabled: false }, testLogger);
        const response = await client.submit(makeSubmission({
          result: makeResult({
            recommendations: [{ agent: 'a', title: 'bad priority', priority: 'nonsense' as never }],
          }),
        }));
        expect(response.repairedRecommendations).toBe(1);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // submit()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('submit', () => {
    it('submits execution results to ops SDK', async () => {
      mockSave.mockResolvedValueOnce({
        run: {
          id: 'run-123',
          projectId: 'proj-456',
          runNumber: 7,
          workflowType: 'post-implementation',
          allGatesPassed: true,
          averageScore: 85,
        },
        agents: [],
        correlation: { newIssues: 1, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      const response = await client.submit(makeSubmission());

      expect(response.runId).toBe('run-123');
      expect(response.runNumber).toBe(7);
      expect(response.projectId).toBe('proj-456');
      expect(response.dashboardUrl).toBe('https://app.example.com/runs/run-123');
      expect(response.allGatesPassed).toBe(true);
      expect(response.averageScore).toBe(85);
      expect(response.deduplicated).toBe(false);
    });

    it('builds canonical dashboard URL with org and project slugs', async () => {
      mockSave.mockResolvedValueOnce({
        run: {
          id: 'run-abc',
          projectId: 'proj-456',
          runNumber: 9,
          workflowType: 'agent',
          allGatesPassed: true,
          averageScore: 82,
          projectSlug: '-uluops-core',
          orgSlug: 'system',
        },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      const response = await client.submit(makeSubmission());

      expect(response.dashboardUrl).toBe(
        'https://app.example.com/orgs/system/-uluops-core/runs/run-abc',
      );
    });

    it('transforms execution result to ops input format', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({
        idempotencyKey: 'idem-key',
        rawMarkdown: '# Report',
      }));

      expect(mockSave).toHaveBeenCalledOnce();
      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      expect(input.project).toBe('test-project');
      expect(input.workflowType).toBe('post-implementation');
      expect(input.idempotencyKey).toBe('idem-key');
      expect(input.rawMarkdown).toBe('# Report');

      // Validators
      const agents = input.agents as Array<Record<string, unknown>>;
      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe('code-validator');
      expect(agents[0]!.score).toBe(85);
      expect(agents[0]!.decision).toBe('PASS');
      expect(agents[0]!.model).toBe('claude-sonnet-4-5-20250929');

      const tokens = agents[0]!.tokens as Record<string, unknown>;
      expect(tokens.inputTokens).toBe(1000);
      expect(tokens.outputTokens).toBe(500);
      expect(tokens.cacheCreationTokens).toBe(200);
      expect(tokens.cacheReadTokens).toBe(100);
      expect(tokens.totalEffectiveTokens).toBe(1300);
      // POSITIVE CONTROL: remove either line from extractTokens and these fail.
      //
      // Both fields are populated on ExecutionMetrics AND declared on ops-sdk's wire
      // TokenUsage, and both were silently dropped in the mapping — so an OpenAI reasoning
      // run's entire reasoning pool never reached the tracker, and the cached-input pool
      // the engine prices was invisible to anything reading a run back. That also
      // falsified the recorded justification for not sending costUsd at all ("derivable
      // from tokens + pricing"): it is not derivable from a token set with the
      // cache-served pool removed.
      expect(tokens.cachedInputTokens).toBe(300);
      expect(tokens.reasoningOutputTokens).toBe(400);

      // harness: set by the engine on every run, declared on the wire as AgentInput.harness,
      // and never forwarded — so every run this package produced was indistinguishable on
      // the wire from one produced by any other harness. It was asserted at the PRODUCER by
      // a test that passed identically whether this mapping line existed or not.
      expect(agents[0]!.harness).toBe('uluops-core');

      // Recommendations
      const recs = input.recommendations as Array<Record<string, unknown>>;
      expect(recs).toHaveLength(1);
      expect(recs[0]!.agent).toBe('code-validator');
      expect(recs[0]!.title).toBe('Add missing type annotation');
      expect(recs[0]!.priority).toBe('suggested');
      expect(recs[0]!.severity).toBe('medium');
      expect(recs[0]!.filePath).toBe('src/index.ts');
      expect(recs[0]!.lineNumber).toBe(42);

      // Summary
      const summary = input.summary as Record<string, unknown>;
      expect(summary.allGatesPassed).toBe(true);
      expect(summary.averageScore).toBe(85);
    });

    it('sends null score and omits the scale for a scoreless result over the wire (V15)', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: false, averageScore: null },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({
        result: makeResult({ score: undefined }),
      }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const agents = input.agents as Array<Record<string, unknown>>;
      expect(agents[0]!.score).toBeNull();          // no fabricated 0
      expect(agents[0]!.maxScore).toBeUndefined();  // scale omitted when scoreless
      // averageScore omitted from the summary when scoreless (V16b)
      const summary = input.summary as Record<string, unknown>;
      expect(summary.averageScore).toBeUndefined();
    });

    it('against a bidirectional tracker that accepts null, submit succeeds and preserves null (V16)', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: false, averageScore: null },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      const response = await client.submit(makeSubmission({
        result: makeResult({ score: undefined }),
      }));

      // Tracker accepted the null payload; null is preserved end-to-end (not fabricated to 0).
      expect(response.averageScore).toBeNull();
    });

    it('against a null-rejecting tracker, submit fails fast — does not silently swallow (V16)', async () => {
      // A non-bidirectional tracker rejects the null-score payload.
      mockSave.mockRejectedValueOnce(new Error('tracker rejected: score must be a number'));

      const client = new SubmissionClient(baseConfig, testLogger);
      await expect(
        client.submit(makeSubmission({ result: makeResult({ score: undefined }) })),
      ).rejects.toThrow(/tracker rejected/);
    });

    it('passes definitionMinSubscription when result has minSubscription', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({
        result: makeResult({ minSubscription: 'plus' }),
      }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      expect(input.definitionMinSubscription).toBe('plus');
    });

    it('omits definitionMinSubscription when result has no minSubscription', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission());

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      expect(input.definitionMinSubscription).toBeUndefined();
    });

    it('defaults validator name to "unknown" when not provided', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 90 },
        agents: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const result = makeResult();
      result.recommendations = [{ title: 'no validator', priority: 'backlog' }];

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({ result }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const recs = input.recommendations as Array<Record<string, unknown>>;
      expect(recs[0]!.agent).toBe('unknown');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // analysis payload caps
  //
  // @uluops/ops-sdk's SaveRunInputSchema enforces `.max(100)` client-side, before
  // any HTTP call, on `analysisRecords` and `agents`. Core accumulates both with no
  // ceiling of its own — a pipeline with many stages/agents can produce >100 of
  // either, and the ops-sdk cap turns that into a ZodError that loses the ENTIRE
  // run's payload, not just the excess. These assert truncation-with-warning
  // instead, and (required) that a payload safely under the cap is left untouched
  // with no warning fired — without the control, a cap that truncated everything to
  // zero would pass just as well.
  // ─────────────────────────────────────────────────────────────────────────────

  describe('analysis payload caps', () => {
    const okSave = () => mockSave.mockResolvedValueOnce({
      run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
      agents: [], correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
    });

    it('caps analysisRecords at 100 and warns naming the total and the drop, for a pipeline exceeding the wire limit', async () => {
      okSave();
      const client = new SubmissionClient(baseConfig, testLogger);
      // 3 stages x 2 agents x 25 records = 150
      const pipeline = makePipelineResultWithAgents([[25, 25], [25, 25], [25, 25]]);

      await client.submit(makeSubmission({
        result: pipeline,
        resolvedDefinition: makeResolvedDefinitionForAnalysis(),
      }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const records = input.analysisRecords as unknown[];
      expect(records).toHaveLength(100);

      const capWarning = warnings.find(w => w.includes('analysis records'));
      expect(capWarning).toBeDefined();
      expect(capWarning).toMatch(/150/);
      expect(capWarning).toMatch(/50/);
    });

    it('control: 99 analysisRecords pass through untouched with no cap warning', async () => {
      okSave();
      const client = new SubmissionClient(baseConfig, testLogger);
      // 3 stages x 33 records = 99, under the 100 cap
      const pipeline = makePipelineResultWithAgents([[33], [33], [33]]);

      await client.submit(makeSubmission({
        result: pipeline,
        resolvedDefinition: makeResolvedDefinitionForAnalysis(),
      }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const records = input.analysisRecords as unknown[];
      expect(records).toHaveLength(99);

      expect(warnings.some(w => w.includes('analysis records'))).toBe(false);
    });

    it('caps agent entries at 100 for a pipeline whose stages decompose past the wire limit', async () => {
      okSave();
      const client = new SubmissionClient(baseConfig, testLogger);
      // 3 stages x 40 agents (0 records each) = 120 agent entries
      const pipeline = makePipelineResultWithAgents([
        Array(40).fill(0), Array(40).fill(0), Array(40).fill(0),
      ]);

      await client.submit(makeSubmission({ result: pipeline }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const agents = input.agents as unknown[];
      expect(agents).toHaveLength(100);
      expect(warnings.some(w => w.includes('agent entries'))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // synthesized placeholder version filtering
  //
  // PipelineExecutor/WorkflowExecutor synthesize CommandResult entries with no
  // backing definition (aggregated stages, steps-only stages, crashed steps) and
  // mark them with the non-parseable version '1.0.0-synthesized'. Without
  // filtering, a steps stage would reach the tracker as an agent at
  // definitionVersion: '1.0.0', indistinguishable from a real 1.0.0 release, and
  // a crashed workflow step would put a literal empty string on the wire.
  // ─────────────────────────────────────────────────────────────────────────────

  describe('synthesized placeholder version filtering', () => {
    const okSave = () => mockSave.mockResolvedValueOnce({
      run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
      agents: [], correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
    });

    it('omits definitionVersion for a pipeline steps stage (synthesized, no backing definition)', async () => {
      okSave();
      const pipeline: PipelineResult = {
        type: 'pipeline',
        name: 'test-pipeline',
        version: '2.0.0',
        definitionHash: 'sha256:pipe',
        decision: 'PASS',
        score: null,
        status: 'complete',
        recommendations: [],
        durationMs: 1000,
        metrics: {
          inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 1000, model: 'mixed',
          stagesExecuted: 1, stagesPassed: 1, stagesFailed: 0, stagesWarned: 0, stagesSkipped: 0,
        },
        stages: [{
          id: 'preflight',
          name: 'Preflight',
          type: 'command',
          status: 'completed',
          result: {
            type: 'command',
            agentType: 'analyst',
            name: 'Preflight',
            version: '1.0.0-synthesized',
            definitionHash: '',
            decision: 'PASS',
            score: null,
            maxScore: null,
            recommendations: [],
            durationMs: 500,
            metrics: { durationMs: 500, model: 'none', toolCalls: 0, inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0 },
          },
        }],
      };

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({ result: pipeline }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const agents = input.agents as Array<Record<string, unknown>>;
      expect(agents).toHaveLength(1);
      expect(agents[0]!.definitionVersion).toBeUndefined();
    });

    it('omits definitionVersion (not empty string) for a crashed parallel workflow step', async () => {
      okSave();
      const workflow: WorkflowResult = {
        type: 'workflow',
        name: 'test-workflow',
        version: '2.0.0',
        definitionHash: 'sha256:wf',
        decision: 'FAIL',
        score: null,
        recommendations: [],
        durationMs: 1000,
        metrics: {
          inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 1000, model: 'mixed',
          phasesExecuted: 1, phasesPassed: 0, phasesWarned: 0, phasesBlocked: 1, phasesSkipped: 0,
          phasesAborted: 0, commands: [],
        },
        phases: [{
          id: 'p1',
          name: 'Phase 1',
          decision: 'blocked',
          gateThreshold: 70,
          score: null,
          durationMs: 500,
          commands: [{
            type: 'command',
            agentType: 'validator',
            name: 'crashed-step',
            version: '1.0.0-synthesized',
            definitionHash: '',
            decision: 'FAIL',
            score: null,
            maxScore: null,
            recommendations: [],
            durationMs: 200,
            metrics: { durationMs: 200, model: 'none', toolCalls: 0, inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0 },
          }],
        }],
      };

      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({ result: workflow }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const agents = input.agents as Array<Record<string, unknown>>;
      expect(agents).toHaveLength(1);
      expect(agents[0]!.definitionVersion).toBeUndefined();
      // Not merely falsy — must not be a literal empty string either.
      expect(agents[0]!.definitionVersion).not.toBe('');
    });

    // Control: a real 1.0.0 release must NOT be treated as a placeholder — only
    // the '1.0.0-synthesized' sentinel is filtered.
    it('control: a genuine version "1.0.0" is passed through, not treated as a placeholder', async () => {
      okSave();
      const client = new SubmissionClient(baseConfig, testLogger);
      await client.submit(makeSubmission({ result: makeResult({ version: '1.0.0' }) }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const agents = input.agents as Array<Record<string, unknown>>;
      expect(agents[0]!.definitionVersion).toBe('1.0.0');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // submit() with tracking disabled
  // ─────────────────────────────────────────────────────────────────────────────

  describe('submit (tracking disabled)', () => {
    it('returns local response without calling API', async () => {
      const client = new SubmissionClient({ ...baseConfig, trackingEnabled: false }, testLogger);
      const response = await client.submit(makeSubmission());

      expect(mockSave).not.toHaveBeenCalled();
      expect(response.runId).toBe('local');
      expect(response.runNumber).toBe(0);
      expect(response.projectId).toBe('local');
      expect(response.dashboardUrl).toBe('');
      expect(response.allGatesPassed).toBe(true);
      expect(response.averageScore).toBe(85);
      expect(response.correlation.newIssues).toBe(1);
    });

    it('calculates allGatesPassed from decision', async () => {
      const client = new SubmissionClient({ ...baseConfig, trackingEnabled: false }, testLogger);

      const fail = await client.submit(makeSubmission({
        result: makeResult({ decision: 'FAIL' }),
      }));
      expect(fail.allGatesPassed).toBe(false);

      const warn = await client.submit(makeSubmission({
        result: makeResult({ decision: 'WARN' }),
      }));
      expect(warn.allGatesPassed).toBe(false);

      const pass = await client.submit(makeSubmission({
        result: makeResult({ decision: 'PASS' }),
      }));
      expect(pass.allGatesPassed).toBe(true);

      const ship = await client.submit(makeSubmission({
        result: makeResult({ decision: 'SHIP' }),
      }));
      expect(ship.allGatesPassed).toBe(true);
    });

    it('blocks low-confidence extractions even when the decision is positive', async () => {
      const client = new SubmissionClient({ ...baseConfig, trackingEnabled: false }, testLogger);

      // structured_text regex (0.5) parsed a real PASS, but it is below the trust
      // threshold — the decision is preserved on the result, gating refuses it.
      const lowConf = await client.submit(makeSubmission({
        result: { ...makeResult({ decision: 'PASS' }), decisionCategory: 'positive' as const, extractionConfidence: 0.5 },
      }));
      expect(lowConf.allGatesPassed).toBe(false);

      // At/above the threshold a positive decision passes as normal (inline JSON, 0.75).
      const highConf = await client.submit(makeSubmission({
        result: { ...makeResult({ decision: 'PASS' }), decisionCategory: 'positive' as const, extractionConfidence: 0.75 },
      }));
      expect(highConf.allGatesPassed).toBe(true);

      // Absent extractionConfidence (structured output / command path) is unaffected.
      const noConf = await client.submit(makeSubmission({
        result: makeResult({ decision: 'PASS' }),
      }));
      expect(noConf.allGatesPassed).toBe(true);
    });

    it('uses decisionCategory for non-standard positive decisions', async () => {
      const client = new SubmissionClient({ ...baseConfig, trackingEnabled: false }, testLogger);

      // Cognitive lens agents emit EXAMINED, VITAL, etc. — not PASS/SHIP
      const examined = await client.submit(makeSubmission({
        result: { ...makeResult({ decision: 'EXAMINED' }), decisionCategory: 'positive' as const },
      }));
      expect(examined.allGatesPassed).toBe(true);

      // Negative category overrides even if decision string looks unfamiliar
      const negative = await client.submit(makeSubmission({
        result: { ...makeResult({ decision: 'UNEXAMINED' }), decisionCategory: 'negative' as const },
      }));
      expect(negative.allGatesPassed).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // previewSubmission()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('previewSubmission', () => {
    it('previews submission without saving', async () => {
      mockValidate.mockResolvedValueOnce({
        wouldCreate: true,
        wouldUpdate: false,
        wouldRegress: false,
        validationErrors: [],
        preview: { newIssues: 1, recurringIssues: 0, regressions: 0 },
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      const sub = makeSubmission();
      const result = await client.previewSubmission(sub.project, sub.workflowType, sub.result);

      expect(result.wouldCreate).toBe(true);
      expect(result.wouldUpdate).toBe(false);
      expect(result.wouldRegress).toBe(false);
      expect(result.validationErrors).toEqual([]);
      expect(mockValidate).toHaveBeenCalledOnce();
    });

    it('returns validation errors', async () => {
      mockValidate.mockResolvedValueOnce({
        wouldCreate: false,
        wouldUpdate: false,
        wouldRegress: false,
        validationErrors: ['Project not found', 'Invalid workflow type'],
        preview: { newIssues: 0, recurringIssues: 0, regressions: 0 },
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      const sub = makeSubmission();
      const result = await client.previewSubmission(sub.project, sub.workflowType, sub.result);

      expect(result.validationErrors).toEqual(['Project not found', 'Invalid workflow type']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getHistory()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getHistory', () => {
    it('lists run history for a project', async () => {
      mockListByProject.mockResolvedValueOnce([
        {
          id: 'run-1',
          projectId: 'proj-1',
          runNumber: 3,
          workflowType: 'ship',
          timestamp: '2026-02-08T00:00:00Z',
          allGatesPassed: true,
          averageScore: 92,
          rawMarkdown: null,
          archivedAt: null,
          archiveReason: null,
          idempotencyKey: null,
          createdAt: '2026-02-08T00:00:00Z',
          updatedAt: '2026-02-08T00:00:00Z',
        },
      ]);

      const client = new SubmissionClient(baseConfig, testLogger);
      const history = await client.getHistory('test-project', { workflowType: 'ship', limit: 10 });

      expect(history).toHaveLength(1);
      expect(history[0]!.id).toBe('run-1');
      expect(history[0]!.runNumber).toBe(3);
      expect(history[0]!.workflowType).toBe('ship');
      expect(history[0]!.allGatesPassed).toBe(true);
      expect(history[0]!.averageScore).toBe(92);
      expect(history[0]!.rawMarkdown).toBeUndefined();

      expect(mockListByProject).toHaveBeenCalledWith('test-project', {
        workflowType: 'ship',
        limit: 10,
      });
    });

    it('converts null fields to undefined', async () => {
      mockListByProject.mockResolvedValueOnce([
        {
          id: 'run-2',
          projectId: 'proj-1',
          runNumber: 1,
          workflowType: 'post-implementation',
          timestamp: '2026-02-07T00:00:00Z',
          allGatesPassed: false,
          averageScore: null,
          rawMarkdown: '# Report',
          archivedAt: '2026-02-08T00:00:00Z',
          archiveReason: 'old',
          idempotencyKey: 'key-1',
          createdAt: '2026-02-07T00:00:00Z',
          updatedAt: '2026-02-08T00:00:00Z',
        },
      ]);

      const client = new SubmissionClient(baseConfig, testLogger);
      const history = await client.getHistory('test-project');

      expect(history[0]!.averageScore).toBeNull(); // null preserved on read (no longer fabricated to 0)
      expect(history[0]!.rawMarkdown).toBe('# Report');
      expect(history[0]!.archivedAt).toBe('2026-02-08T00:00:00Z');
      expect(history[0]!.archiveReason).toBe('old');
      expect(history[0]!.idempotencyKey).toBe('key-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getRun()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getRun', () => {
    it('returns run details by ID', async () => {
      mockGet.mockResolvedValueOnce({
        id: 'run-xyz',
        projectId: 'proj-abc',
        runNumber: 5,
        workflowType: 'ship',
        timestamp: '2026-02-08T12:00:00Z',
        allGatesPassed: true,
        averageScore: 95,
        createdAt: '2026-02-08T12:00:00Z',
        updatedAt: '2026-02-08T12:00:00Z',
      });

      const client = new SubmissionClient(baseConfig, testLogger);
      const result = await client.getRun('run-xyz');

      expect(result.runId).toBe('run-xyz');
      expect(result.projectId).toBe('proj-abc');
      expect(result.runNumber).toBe(5);
      expect(result.dashboardUrl).toBe('https://app.example.com/runs/run-xyz');
      expect(result.allGatesPassed).toBe(true);
      expect(result.averageScore).toBe(95);
      expect(result.deduplicated).toBe(false);
    });
  });
});
