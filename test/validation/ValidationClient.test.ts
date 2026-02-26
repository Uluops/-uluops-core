import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ValidationClient } from '../../src/validation/ValidationClient.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { RunSubmission } from '../../src/types/validation.js';
import type { ExecutionResult } from '../../src/types/execution.js';

// Mock the ops SDK
const mockSave = vi.fn();
const mockValidate = vi.fn();
const mockListByProject = vi.fn();
const mockGet = vi.fn();

vi.mock('@uluops/ops-sdk', () => ({
  OpsClient: vi.fn(() => ({
    runs: {
      save: mockSave,
      validate: mockValidate,
      listByProject: mockListByProject,
      get: mockGet,
    },
  })),
}));

const baseConfig: ResolvedConfig = {
  apiKey: 'test-key',
  ai: {
    providers: { anthropic: { apiKey: 'test-anthropic-key' } },
    defaultProvider: 'anthropic',
  },
  registryUrl: 'https://registry.example.com/api',
  validationUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: true,
  hashVerificationEnabled: true,
  timeout: 30000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
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
        validator: 'code-validator',
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
      totalEffectiveTokens: 1300,
      durationMs: 5000,
      model: 'claude-sonnet-4-5-20250929',
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

describe('ValidationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        validators: [],
        correlation: { newIssues: 1, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new ValidationClient(baseConfig);
      const response = await client.submit(makeSubmission());

      expect(response.runId).toBe('run-123');
      expect(response.runNumber).toBe(7);
      expect(response.projectId).toBe('proj-456');
      expect(response.dashboardUrl).toBe('https://app.example.com/runs/run-123');
      expect(response.allGatesPassed).toBe(true);
      expect(response.averageScore).toBe(85);
      expect(response.deduplicated).toBe(false);
    });

    it('transforms execution result to ops input format', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 85 },
        validators: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new ValidationClient(baseConfig);
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
      const validators = input.validators as Array<Record<string, unknown>>;
      expect(validators).toHaveLength(1);
      expect(validators[0]!.name).toBe('code-validator');
      expect(validators[0]!.score).toBe(85);
      expect(validators[0]!.status).toBe('PASS');
      expect(validators[0]!.model).toBe('claude-sonnet-4-5-20250929');

      const tokens = validators[0]!.tokens as Record<string, unknown>;
      expect(tokens.inputTokens).toBe(1000);
      expect(tokens.outputTokens).toBe(500);
      expect(tokens.cacheCreationTokens).toBe(200);
      expect(tokens.cacheReadTokens).toBe(100);
      expect(tokens.totalEffectiveTokens).toBe(1300);

      // Recommendations
      const recs = input.recommendations as Array<Record<string, unknown>>;
      expect(recs).toHaveLength(1);
      expect(recs[0]!.validator).toBe('code-validator');
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

    it('defaults score to 0 when not provided', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: false, averageScore: 0 },
        validators: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const client = new ValidationClient(baseConfig);
      await client.submit(makeSubmission({
        result: makeResult({ score: undefined }),
      }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const validators = input.validators as Array<Record<string, unknown>>;
      expect(validators[0]!.score).toBe(0);
    });

    it('defaults validator name to "unknown" when not provided', async () => {
      mockSave.mockResolvedValueOnce({
        run: { id: 'r', projectId: 'p', runNumber: 1, allGatesPassed: true, averageScore: 90 },
        validators: [],
        correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
        deduplicated: false,
      });

      const result = makeResult();
      result.recommendations = [{ title: 'no validator', priority: 'backlog' }];

      const client = new ValidationClient(baseConfig);
      await client.submit(makeSubmission({ result }));

      const input = mockSave.mock.calls[0]![0] as Record<string, unknown>;
      const recs = input.recommendations as Array<Record<string, unknown>>;
      expect(recs[0]!.validator).toBe('unknown');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // submit() with tracking disabled
  // ─────────────────────────────────────────────────────────────────────────────

  describe('submit (tracking disabled)', () => {
    it('returns local response without calling API', async () => {
      const client = new ValidationClient({ ...baseConfig, trackingEnabled: false });
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
      const client = new ValidationClient({ ...baseConfig, trackingEnabled: false });

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
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateRun()
  // ─────────────────────────────────────────────────────────────────────────────

  describe('validateRun', () => {
    it('previews submission without saving', async () => {
      mockValidate.mockResolvedValueOnce({
        wouldCreate: true,
        wouldUpdate: false,
        wouldRegress: false,
        validationErrors: [],
        preview: { newIssues: 1, recurringIssues: 0, regressions: 0 },
      });

      const client = new ValidationClient(baseConfig);
      const sub = makeSubmission();
      const result = await client.validateRun(sub.project, sub.workflowType, sub.result);

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

      const client = new ValidationClient(baseConfig);
      const sub = makeSubmission();
      const result = await client.validateRun(sub.project, sub.workflowType, sub.result);

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

      const client = new ValidationClient(baseConfig);
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

      const client = new ValidationClient(baseConfig);
      const history = await client.getHistory('test-project');

      expect(history[0]!.averageScore).toBe(0); // null → 0
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

      const client = new ValidationClient(baseConfig);
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
