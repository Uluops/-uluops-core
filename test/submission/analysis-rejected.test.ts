/**
 * `analysisRejected` (ops-uluops-api analysis-never-loses-the-run spec v0.2.3 §3.5, phase R3).
 *
 * Since ops-api R2 the tracker keeps the run and rejects one agent's analysis as a unit,
 * reported in the save echo's `analysisWrite.rejected`. Until core 0.58.0 `submit()` built its
 * response field by field and dropped the echo, so a fully rejected save left
 * `trackingFailed` unset and said nothing anywhere (spec perverse read P1).
 *
 * Negative control: on 0.57.0 (16cb6db) the "maps" and "warns" tests fail
 * (`analysisRejected` is undefined and no warning is logged).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubmissionClient } from '../../src/submission/SubmissionClient.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { RunSubmission } from '../../src/types/submission.js';

const mockSave = vi.fn();
vi.mock('@uluops/ops-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uluops/ops-sdk')>();
  return { ...actual, OpsClient: vi.fn(() => ({ runs: { save: mockSave } })) };
});

const warnings: string[] = [];
const logger = { warn: (m: string) => { warnings.push(m); }, debug: () => {}, info: () => {}, error: () => {} } as unknown as ConstructorParameters<typeof SubmissionClient>[1];
const config = {
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
} as ResolvedConfig;

const submission: RunSubmission = {
  project: 'test-project',
  workflowType: 'post-implementation',
  result: { type: 'command', name: 'code-validator', version: '1.0.0', decision: 'PASS', score: 85, durationMs: 1, recommendations: [],
    metrics: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, durationMs: 1, model: 'claude-sonnet-5-5', harness: 'uluops-core' } } as never,
};

const REJECTED_A = { agentName: 'agent-a', reason: 'entry_invalid', recordsRejected: 2, summariesRejected: 1, detail: { issues: [], issuesTotal: 1 } };
const OWN_UNIT = { agentName: null, reason: 'entry_invalid', recordsRejected: 1, summariesRejected: 0, detail: {} };

function reply(analysisWrite: unknown) {
  return {
    run: { id: 'run-uuid-7', projectId: 'p', runNumber: 7, workflowType: 'w', allGatesPassed: true, averageScore: 85 },
    agents: [],
    correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
    deduplicated: false,
    analysisWrite,
  };
}
const echo = (rejected?: unknown[]) => ({ recordMode: 'initial', supersededRecords: 0, supersededSummaries: 0, createdRecords: 0, createdSummaries: 0, ...(rejected === undefined ? {} : { rejected }) });

describe('SubmissionClient.submit: analysisRejected', () => {
  beforeEach(() => { vi.clearAllMocks(); warnings.length = 0; });

  it('maps analysisWrite.rejected onto the response', async () => {
    mockSave.mockResolvedValueOnce(reply(echo([REJECTED_A, OWN_UNIT])));
    const res = await new SubmissionClient(config, logger).submit(submission);
    expect(res.runNumber).toBe(7); // the save succeeded: nothing threw
    expect(res.analysisRejected).toEqual([REJECTED_A, OWN_UNIT]);
  });

  it('warns once per rejected agent, naming the run, the repair, and the duplicate-run hazard', async () => {
    mockSave.mockResolvedValueOnce(reply(echo([REJECTED_A, OWN_UNIT])));
    await new SubmissionClient(config, logger).submit(submission);
    const mine = warnings.filter(w => w.includes('rejected the analysis'));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toContain('Run #7 saved, but the tracker rejected the analysis of "agent-a" (entry_invalid; 2 records, 1 summaries not stored)');
    expect(mine[0]).toContain('runs.update on run run-uuid-7');
    expect(mine[0]).toContain('do not submit again');
    expect(mine[1]).toContain('(an entry that is its own unit)');
  });

  it('an empty rejected[] is kept as [] (the server reported: nothing rejected) and warns nothing', async () => {
    mockSave.mockResolvedValueOnce(reply(echo([])));
    const res = await new SubmissionClient(config, logger).submit(submission);
    expect(res.runNumber).toBe(7);
    expect(res.analysisRejected).toEqual([]);
    expect(warnings.filter(w => w.includes('rejected the analysis'))).toEqual([]);
  });

  it.each([
    ['a server before R2 (echo without rejected)', echo()],
    ['no analysis sent (analysisWrite null)', null],
  ])('absent for %s', async (_l, aw) => {
    mockSave.mockResolvedValueOnce(reply(aw));
    const res = await new SubmissionClient(config, logger).submit(submission);
    expect(res.runNumber).toBe(7);
    expect(res).not.toHaveProperty('analysisRejected');
  });
});
