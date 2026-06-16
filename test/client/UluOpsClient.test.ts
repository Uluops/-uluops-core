import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Setup ──────────────────────────────────────────────────────────────
// Module mocks for collaborators. This is appropriate for an orchestrator class.
// We verify constructor WIRING (args passed) not just "was the mock called".

const mockRegistryResolve = vi.fn();
const mockRegistryList = vi.fn();
const mockExecutionsRecord = vi.fn();
const mockRegistrySdk = {
  models: { resolveAlias: vi.fn(), get: vi.fn(), list: vi.fn() },
  executions: { record: mockExecutionsRecord },
};
const mockSubmissionSubmit = vi.fn();
const mockSubmissionGetHistory = vi.fn();
const mockAgentExecutorExecute = vi.fn();
const mockCommandExecutorExecute = vi.fn();
const mockWorkflowExecutorExecute = vi.fn();
const mockPipelineExecutorExecute = vi.fn();
const mockPipelineExecutorStart = vi.fn();
const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@uluops/sdk-core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@uluops/sdk-core')>();
  return {
    ...orig,
    createLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('../../src/registry/RegistryClient.js', () => ({
  RegistryClient: vi.fn(() => ({
    resolve: mockRegistryResolve,
    list: mockRegistryList,
    registrySdk: mockRegistrySdk,
  })),
}));

vi.mock('../../src/submission/SubmissionClient.js', () => ({
  SubmissionClient: vi.fn(() => ({
    submit: mockSubmissionSubmit,
    getHistory: mockSubmissionGetHistory,
  })),
}));

vi.mock('../../src/ai/ModelCatalog.js', () => ({
  ModelCatalog: vi.fn(() => ({})),
}));

vi.mock('../../src/ai/AIProvider.js', () => ({
  AIProvider: vi.fn(() => ({})),
}));

vi.mock('../../src/executor/AgentExecutor.js', () => ({
  AgentExecutor: vi.fn(() => ({
    execute: mockAgentExecutorExecute,
  })),
}));

vi.mock('../../src/executor/CommandExecutor.js', () => ({
  CommandExecutor: vi.fn(() => ({
    execute: mockCommandExecutorExecute,
  })),
}));

vi.mock('../../src/executor/WorkflowExecutor.js', () => ({
  WorkflowExecutor: vi.fn(() => ({
    execute: mockWorkflowExecutorExecute,
  })),
}));

vi.mock('../../src/executor/PipelineExecutor.js', () => ({
  PipelineExecutor: vi.fn(() => ({
    execute: mockPipelineExecutorExecute,
    start: mockPipelineExecutorStart,
  })),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { UluOpsClient, resolveConfig, resolveAIConfig } from '../../src/client/UluOpsClient.js';
import { RegistryClient } from '../../src/registry/RegistryClient.js';
import { SubmissionClient } from '../../src/submission/SubmissionClient.js';
import { ModelCatalog } from '../../src/ai/ModelCatalog.js';
import { AIProvider } from '../../src/ai/AIProvider.js';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { createLogger } from '@uluops/sdk-core';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { ValidatorAgentResult } from '../../src/types/agent.js';
import type { CommandResult } from '../../src/types/command.js';
import type { WorkflowResult } from '../../src/types/workflow.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// ─── Test Data Factories ─────────────────────────────────────────────────────

function makeResolvedDef(type: string, name = 'test-def'): ResolvedDefinition {
  return {
    type: type as ResolvedDefinition['type'],
    name,
    version: '1.0.0',
    hash: 'sha256:test',
    yaml: '',
    definition: {
      [type]: { interface: { name, version: '1.0.0', displayName: name, description: 'Test', domain: 'software' } },
    } as ResolvedDefinition['definition'],
    runtime: {} as ResolvedDefinition['runtime'],
    domain: 'software',
    agentType: type === 'agent' ? 'validator' : undefined,
  };
}

function makeAgentResult(): ValidatorAgentResult {
  return {
    type: 'agent',
    agentType: 'validator',
    name: 'test-agent',
    version: '1.0.0',
    definitionHash: 'sha256:agent',
    decision: 'PASS',
    score: 85,
    maxScore: 100,
    recommendations: [],
    durationMs: 1000,
    metrics: { inputTokens: 500, outputTokens: 200, totalEffectiveTokens: 700, durationMs: 1000, model: 'sonnet' },
  };
}

function makeCommandResult(): CommandResult {
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
    metrics: { inputTokens: 500, outputTokens: 200, totalEffectiveTokens: 700, durationMs: 1000, model: 'sonnet', toolCalls: 2 },
  };
}

function makeWorkflowResult(): WorkflowResult {
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
      inputTokens: 1000, outputTokens: 400, totalEffectiveTokens: 1400,
      durationMs: 2000, model: 'mixed',
      phasesExecuted: 2, phasesPassed: 2, phasesWarned: 0, phasesBlocked: 0, phasesSkipped: 0, commands: [],
    },
  };
}

function makePipelineResult(): PipelineResult {
  return {
    type: 'pipeline',
    name: 'test-pipeline',
    version: '1.0.0',
    definitionHash: 'sha256:pipe',
    decision: 'PASS',
    score: 88,
    status: 'complete',
    stages: [],
    recommendations: [],
    durationMs: 5000,
    metrics: {
      inputTokens: 2000, outputTokens: 800, totalEffectiveTokens: 2800,
      durationMs: 5000, model: 'mixed',
      stagesExecuted: 3, stagesPassed: 3, stagesFailed: 0, stagesSkipped: 0,
    },
  };
}

function makeSubmissionResponse(overrides?: Record<string, unknown>) {
  return {
    runId: 'run-123',
    runNumber: 1,
    projectId: 'proj-123',
    dashboardUrl: 'https://app.uluops.ai/runs/run-123',
    allGatesPassed: true,
    averageScore: 85,
    correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
    deduplicated: false,
    ...overrides,
  };
}

// Helper to get constructor args from mocked class
function constructorArgs(MockClass: ReturnType<typeof vi.fn>): unknown[] {
  return MockClass.mock.calls[0] ?? [];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UluOpsClient', () => {
  // Save and restore env vars to prevent cross-test pollution
  const savedEnv: Record<string, string | undefined> = {};
  const envVars = [
    'ULUOPS_API_KEY', 'ULU_API_KEY', 'ULUOPS_REGISTRY_URL',
    'ULUOPS_SUBMISSION_URL', 'ULUOPS_DASHBOARD_URL', 'ULUOPS_LOCAL_DEFINITIONS',
    'ULUOPS_TRACKING_ENABLED', 'ULUOPS_PROJECT', 'ULUOPS_DEBUG',
    'ANTHROPIC_API_KEY',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmissionSubmit.mockResolvedValue(makeSubmissionResponse());

    // Snapshot env vars
    for (const key of envVars) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const key of envVars) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // ─── Config Resolution ───────────────────────────────────────────────────

  // resolveConfig is the pure config-resolution unit. Tests assert its return value
  // directly with an explicit env object — observable behavior, not the args the
  // constructor happens to pass to a collaborator (was: constructorArgs(RegistryClient)).
  describe('resolveConfig', () => {
    it('throws when no API key is provided from any source', () => {
      expect(() => resolveConfig({}, {})).toThrow('API key is required');
    });

    it('throws ConfigurationError when API key lacks ulr_ prefix', () => {
      expect(() => resolveConfig({ apiKey: 'bad-prefix-key' }, {})).toThrow('keys must begin with "ulr_"');
    });

    it('accepts API key from config', () => {
      expect(() => resolveConfig({ apiKey: 'ulr_from-config' }, {})).not.toThrow();
    });

    it('reads API key from ULUOPS_API_KEY env var', () => {
      const config = resolveConfig({}, { ULUOPS_API_KEY: 'ulr_from-env' });
      expect(config.apiKey).toBe('ulr_from-env');
    });

    it('falls back to ULU_API_KEY env var', () => {
      const config = resolveConfig({}, { ULU_API_KEY: 'ulr_from-ulu-env' });
      expect(config.apiKey).toBe('ulr_from-ulu-env');
    });

    it('config apiKey takes precedence over env vars', () => {
      const config = resolveConfig(
        { apiKey: 'ulr_from-config' },
        { ULUOPS_API_KEY: 'ulr_from-env', ULU_API_KEY: 'ulr_from-ulu-env' },
      );
      expect(config.apiKey).toBe('ulr_from-config');
    });

    it('reads URL overrides from env vars', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, {
        ULUOPS_REGISTRY_URL: 'https://custom-registry/api',
        ULUOPS_SUBMISSION_URL: 'https://custom-ops/api',
        ULUOPS_DASHBOARD_URL: 'https://custom-dash',
      });
      expect(config.registryUrl).toBe('https://custom-registry/api');
      expect(config.submissionUrl).toBe('https://custom-ops/api');
      expect(config.dashboardUrl).toBe('https://custom-dash');
    });

    it('uses production defaults when no URL env vars set', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, {});
      expect(config.registryUrl).toBe('https://api.uluops.ai/api/v1/registry');
      expect(config.submissionUrl).toBe('https://api.uluops.ai/api/v1');
      expect(config.dashboardUrl).toBe('https://app.uluops.ai');
    });

    it('rejects non-HTTPS URLs when a real API key is present', () => {
      expect(() => resolveConfig(
        { apiKey: 'ulr_test-key', registryUrl: 'http://insecure/api' }, {},
      )).toThrow('must use HTTPS');
    });

    it('allows non-HTTPS localhost URLs even with an API key', () => {
      const config = resolveConfig(
        { apiKey: 'ulr_test-key', registryUrl: 'http://localhost:3001', submissionUrl: 'http://127.0.0.1:3100' }, {},
      );
      expect(config.registryUrl).toBe('http://localhost:3001');
      expect(config.submissionUrl).toBe('http://127.0.0.1:3100');
    });

    it('defaults trackingEnabled to true', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, {});
      expect(config.trackingEnabled).toBe(true);
    });

    it('disables tracking via ULUOPS_TRACKING_ENABLED=false', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, { ULUOPS_TRACKING_ENABLED: 'false' });
      expect(config.trackingEnabled).toBe(false);
    });

    it('config trackingEnabled overrides env var', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key', trackingEnabled: true }, { ULUOPS_TRACKING_ENABLED: 'false' });
      expect(config.trackingEnabled).toBe(true);
    });

    it('defaults timeout to 300000ms', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, {});
      expect(config.timeout).toBe(300_000);
    });

    it('defaults defaultThinkingBudget to 10000', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, {});
      expect(config.defaultThinkingBudget).toBe(10_000);
    });

    it('reads debug from config', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key', debug: true }, {});
      expect(config.debug).toBe(true);
    });

    it('reads debug from ULUOPS_DEBUG env var', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, { ULUOPS_DEBUG: 'true' });
      expect(config.debug).toBe(true);
    });

    it('reads defaultProject from ULUOPS_PROJECT env var', () => {
      const config = resolveConfig({ apiKey: 'ulr_test-key' }, { ULUOPS_PROJECT: 'env-project' });
      expect(config.defaultProject).toBe('env-project');
    });

    it('reads localDefinitions from env var, config overrides', () => {
      expect(resolveConfig({ apiKey: 'ulr_test-key' }, { ULUOPS_LOCAL_DEFINITIONS: '/from/env' }).localDefinitions)
        .toBe('/from/env');
      expect(resolveConfig({ apiKey: 'ulr_test-key', localDefinitions: '/from/config' }, { ULUOPS_LOCAL_DEFINITIONS: '/from/env' }).localDefinitions)
        .toBe('/from/config');
    });

    it('allows a missing API key when localDefinitions is set and tracking is disabled', () => {
      const config = resolveConfig({ localDefinitions: '/local', trackingEnabled: false }, {});
      expect(config.apiKey).toBeUndefined();
      expect(config.localDefinitions).toBe('/local');
    });
  });

  // ─── AI Config Resolution ────────────────────────────────────────────────

  // resolveAIConfig tested directly against its return value with explicit env.
  describe('resolveAIConfig', () => {
    it('defaults to anthropic provider when no ai config', () => {
      const ai = resolveAIConfig(undefined, { ANTHROPIC_API_KEY: 'test-anthropic-key' });
      expect(ai.defaultProvider).toBe('anthropic');
      expect(ai.providers.anthropic).toEqual({ apiKey: 'test-anthropic-key' });
    });

    it('excludes providers without API keys', () => {
      const ai = resolveAIConfig(undefined, {});
      expect(ai.providers.anthropic).toBeUndefined();
    });

    it('uses explicit provider config with env var fallback', () => {
      const ai = resolveAIConfig(
        {
          providers: {
            anthropic: { apiKey: 'explicit-anthropic' },
            openai: {}, // No apiKey — falls back to OPENAI_API_KEY env var
          },
          defaultProvider: 'anthropic',
        },
        { OPENAI_API_KEY: 'openai-key-from-env' },
      );
      expect(ai.providers.anthropic).toEqual({ apiKey: 'explicit-anthropic' });
      expect(ai.providers.openai).toEqual({ apiKey: 'openai-key-from-env' });
    });

    it('detects google via GOOGLE_GENERATIVE_AI_API_KEY fallback in auto-detect', () => {
      const ai = resolveAIConfig(undefined, { GOOGLE_GENERATIVE_AI_API_KEY: 'google-alt-key' });
      expect(ai.providers.google).toEqual({ apiKey: 'google-alt-key' });
    });

    it('detects google via GOOGLE_GENERATIVE_AI_API_KEY fallback in explicit config', () => {
      const ai = resolveAIConfig(
        { providers: { google: {} }, defaultProvider: 'anthropic' }, // No apiKey — env fallback
        { GOOGLE_GENERATIVE_AI_API_KEY: 'google-alt-key' },
      );
      expect(ai.providers.google).toEqual({ apiKey: 'google-alt-key' });
    });

    it('passes through modelOverride', () => {
      const ai = resolveAIConfig({ providers: { anthropic: { apiKey: 'key' } }, modelOverride: 'haiku' }, {});
      expect(ai.modelOverride).toBe('haiku');
    });
  });

  // ─── Constructor Wiring ──────────────────────────────────────────────────

  describe('constructor wiring', () => {
    it('creates logger with debug flag from config', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key', debug: true });

      expect(createLogger).toHaveBeenCalledWith('[core]', true);
    });

    it('passes resolved config and logger to RegistryClient', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(RegistryClient as unknown as ReturnType<typeof vi.fn>);
      expect(args[0]).toHaveProperty('apiKey', 'ulr_test-key');
      expect(args[1]).toBe(mockLogger);
    });

    it('passes resolved config to SubmissionClient', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(SubmissionClient as unknown as ReturnType<typeof vi.fn>);
      expect(args[0]).toHaveProperty('apiKey', 'ulr_test-key');
    });

    it('passes registrySdk from RegistryClient to ModelCatalog', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(ModelCatalog as unknown as ReturnType<typeof vi.fn>);
      expect(args[0]).toBe(mockRegistrySdk);
    });

    it('passes config, modelCatalog, and logger to AIProvider', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(AIProvider as unknown as ReturnType<typeof vi.fn>);
      expect(args).toHaveLength(3);
      expect(args[0]).toHaveProperty('apiKey', 'ulr_test-key'); // config
      // args[1] is the ModelCatalog instance (mocked)
      expect(args[2]).toBe(mockLogger); // logger
    });

    it('passes config, aiProvider, and logger to AgentExecutor', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(AgentExecutor as unknown as ReturnType<typeof vi.fn>);
      expect(args).toHaveLength(3);
      expect(args[0]).toHaveProperty('apiKey', 'ulr_test-key'); // config
      expect(args[2]).toBe(mockLogger); // logger
    });

    it('passes agentExecutor and registry to CommandExecutor', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(CommandExecutor as unknown as ReturnType<typeof vi.fn>);
      expect(args).toHaveLength(2);
      // Both are mock instances — we verify the count and structure
      expect(args[0]).toHaveProperty('execute'); // agentExecutor
      expect(args[1]).toHaveProperty('resolve'); // registry
    });

    it('passes commandExecutor, registry, and agentExecutor to WorkflowExecutor', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(WorkflowExecutor as unknown as ReturnType<typeof vi.fn>);
      expect(args).toHaveLength(3);
      expect(args[0]).toHaveProperty('execute'); // commandExecutor
      expect(args[1]).toHaveProperty('resolve'); // registry
      expect(args[2]).toHaveProperty('execute'); // agentExecutor
    });

    it('passes workflowExecutor, commandExecutor, agentExecutor, and registry to PipelineExecutor', () => {
      new UluOpsClient({ apiKey: 'ulr_test-key' });

      const args = constructorArgs(PipelineExecutor as unknown as ReturnType<typeof vi.fn>);
      expect(args).toHaveLength(5);
      expect(args[0]).toHaveProperty('execute'); // workflowExecutor
      expect(args[1]).toHaveProperty('execute'); // commandExecutor
      expect(args[2]).toHaveProperty('execute'); // agentExecutor
      expect(args[3]).toHaveProperty('resolve'); // registry
      expect(args[4]).toHaveProperty('warn');    // logger
    });
  });

  // ─── runAgent ────────────────────────────────────────────────────────────

  describe('runAgent', () => {
    it('resolves via registry with parsed ref and type hint', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('code-validator', undefined, 'agent');
    });

    it('parses versioned ref (name@version)', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator@1.2.0', '/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('code-validator', '1.2.0', 'agent');
    });

    it('passes resolved def, input, and options to AgentExecutor.execute', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('agent');
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test', {
        model: 'opus',
        thresholds: { pass: 80 },
      });

      expect(mockAgentExecutorExecute).toHaveBeenCalledWith(
        resolved,
        { target: '/tmp/test' },
        { model: 'opus', thresholds: { pass: 80 } },
      );
    });

    it('throws when resolved type is not agent', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));

      await expect(client.runAgent('validate', '/tmp/test')).rejects.toThrow('not an agent');
    });

    it('returns the AgentResult from executor', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      const agentResult = makeAgentResult();
      mockAgentExecutorExecute.mockResolvedValue(agentResult);

      const result = await client.runAgent('code-validator', '/tmp/test');

      // Verify executor result is forwarded unmodified through the facade
      expect(result).toBe(agentResult);
      expect(result.type).toBe('agent');
      expect(result.agentType).toBe('validator');
      expect(result.score).toBe(85);
    });

    it('accepts ExecutionInput object with prompt', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('agent');
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('aristotle-generator', {
        target: '/tmp/test',
        prompt: 'Create an auth middleware',
      });

      expect(mockAgentExecutorExecute).toHaveBeenCalledWith(
        resolved,
        { target: '/tmp/test', prompt: 'Create an auth middleware' },
        undefined,
      );
    });

    it('normalizes string target to ExecutionInput', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('agent');
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test');

      expect(mockAgentExecutorExecute).toHaveBeenCalledWith(
        resolved,
        { target: '/tmp/test' },
        undefined,
      );
    });

    it('passes ExecutionInput with prompt alongside ExecutionOptions', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('agent');
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent(
        'aristotle-generator',
        { target: '/tmp/test', prompt: 'Create a health check' },
        { model: 'opus' },
      );

      expect(mockAgentExecutorExecute).toHaveBeenCalledWith(
        resolved,
        { target: '/tmp/test', prompt: 'Create a health check' },
        { model: 'opus' },
      );
    });
  });

  // ─── runAgent tracking ───────────────────────────────────────────────────

  describe('runAgent tracking', () => {
    it('submits to submission service when trackingEnabled=true', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      const agentResult = makeAgentResult();
      mockAgentExecutorExecute.mockResolvedValue(agentResult);

      const result = await client.runAgent('code-validator', '/tmp/test');

      // trackIfEnabled infers project from target dir basename (not agent name)
      // workflowType uses definition name (not generic 'agent') for single-agent runs
      expect(mockSubmissionSubmit).toHaveBeenCalledWith(expect.objectContaining({
        project: 'test',
        workflowType: 'code-validator',
        result: expect.objectContaining({
          name: agentResult.name,
          decision: agentResult.decision,
          score: agentResult.score,
          metrics: agentResult.metrics,
        }),
        resolvedDefinition: expect.any(Object),
      }));
      expect(result.dashboardUrl).toBe('https://app.uluops.ai/runs/run-123');
    });

    it('skips submission when trackingEnabled=false', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test');

      expect(mockSubmissionSubmit).not.toHaveBeenCalled();
    });

    it('options.trackResults=true overrides config trackingEnabled=false', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test', { trackResults: true });

      expect(mockSubmissionSubmit).toHaveBeenCalled();
    });

    it('options.trackResults=false overrides config trackingEnabled=true', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test', { trackResults: false });

      expect(mockSubmissionSubmit).not.toHaveBeenCalled();
    });

    it('uses options.project when provided', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true, defaultProject: 'default-proj' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test', { project: 'custom-project' });

      const submitCall = mockSubmissionSubmit.mock.calls[0]![0] as Record<string, unknown>;
      expect(submitCall.project).toBe('custom-project');
    });

    it('falls back to defaultProject from config', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true, defaultProject: 'default-proj' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test');

      const submitCall = mockSubmissionSubmit.mock.calls[0]![0] as Record<string, unknown>;
      expect(submitCall.project).toBe('default-proj');
    });

    it('falls back to target directory basename when no project specified', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'my-agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('my-agent', '/tmp/test');

      const submitCall = mockSubmissionSubmit.mock.calls[0]![0] as Record<string, unknown>;
      expect(submitCall.project).toBe('test');
    });

    it('records execution in registry after submission', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test');

      expect(mockExecutionsRecord).toHaveBeenCalledWith(
        'agent',
        'code-validator',
        '1.0.0',
        { source: 'core-sdk', runId: 'run-123' },
      );
    });

    it('skips execution recording when tracking disabled', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test');

      expect(mockExecutionsRecord).not.toHaveBeenCalled();
    });

    it('execution recording failure does not propagate', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());
      mockExecutionsRecord.mockRejectedValue(new Error('registry down'));

      const result = await client.runAgent('code-validator', '/tmp/test');

      expect(result).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Execution recording failed'),
      );
    });

    it('skips execution recording for unknown version', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      const resolved = makeResolvedDef('agent', 'local-agent');
      resolved.version = 'unknown';
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('local-agent', '/tmp/test');

      expect(mockExecutionsRecord).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping execution recording for unversioned local definition',
      );
    });
  });

  // ─── runCommand ──────────────────────────────────────────────────────────

  describe('runCommand', () => {
    it('resolves command and delegates to CommandExecutor', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('command', 'validate');
      mockRegistryResolve.mockResolvedValue(resolved);
      const cmdResult = makeCommandResult();
      mockCommandExecutorExecute.mockResolvedValue(cmdResult);

      const result = await client.runCommand('validate', { target: '/tmp/test' });

      expect(mockRegistryResolve).toHaveBeenCalledWith('validate', undefined, 'command');
      expect(mockCommandExecutorExecute).toHaveBeenCalledWith(resolved, { target: '/tmp/test' }, undefined);
      expect(result).toBe(cmdResult);
      expect(result.type).toBe('command');
    });

    it('parses versioned ref', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.runCommand('validate@2.0.0', { target: '/tmp/test' });

      expect(mockRegistryResolve).toHaveBeenCalledWith('validate', '2.0.0', 'command');
    });

    it('throws when resolved type is not command', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));

      await expect(client.runCommand('code-validator', { target: '/tmp' })).rejects.toThrow('not a command');
    });

    it('submits to submission service when tracking enabled', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.runCommand('validate', { target: '/tmp/test' });

      expect(mockSubmissionSubmit).toHaveBeenCalledWith(expect.objectContaining({
        project: 'test',
        workflowType: 'validate',
        result: expect.objectContaining({ type: 'command' }),
        resolvedDefinition: expect.any(Object),
      }));
      expect(result.dashboardUrl).toBe('https://app.uluops.ai/runs/run-123');
    });
  });

  // ─── runWorkflow ─────────────────────────────────────────────────────────

  describe('runWorkflow', () => {
    it('resolves workflow and delegates to WorkflowExecutor', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('workflow', 'ship');
      mockRegistryResolve.mockResolvedValue(resolved);
      const wfResult = makeWorkflowResult();
      mockWorkflowExecutorExecute.mockResolvedValue(wfResult);

      const result = await client.runWorkflow('ship', { target: '/tmp/test' });

      expect(result).toBe(wfResult);
      expect(mockRegistryResolve).toHaveBeenCalledWith('ship', undefined, 'workflow');
      expect(mockWorkflowExecutorExecute).toHaveBeenCalledWith(resolved, { target: '/tmp/test' });
      expect(result.type).toBe('workflow');
    });

    it('throws when resolved type is not workflow', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));

      await expect(client.runWorkflow('validate', { target: '/tmp' })).rejects.toThrow('not a workflow');
    });
  });

  // ─── run (auto-routing) ──────────────────────────────────────────────────

  describe('run (auto-routing)', () => {
    it('routes to AgentExecutor for agents', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('agent');
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      const result = await client.run('code-validator', { target: '/tmp/test' });

      expect(result.type).toBe('agent');
      expect(mockAgentExecutorExecute).toHaveBeenCalledWith(resolved, { target: '/tmp/test' });
      expect(mockCommandExecutorExecute).not.toHaveBeenCalled();
      expect(mockWorkflowExecutorExecute).not.toHaveBeenCalled();
      expect(mockPipelineExecutorExecute).not.toHaveBeenCalled();
    });

    it('routes to CommandExecutor for commands', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.run('validate', { target: '/tmp/test' });

      expect(result.type).toBe('command');
      expect(mockCommandExecutorExecute).toHaveBeenCalled();
      expect(mockAgentExecutorExecute).not.toHaveBeenCalled();
    });

    it('routes to WorkflowExecutor for workflows', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('workflow'));
      mockWorkflowExecutorExecute.mockResolvedValue(makeWorkflowResult());

      const result = await client.run('ship', { target: '/tmp/test' });

      expect(result.type).toBe('workflow');
      expect(mockWorkflowExecutorExecute).toHaveBeenCalled();
      expect(mockAgentExecutorExecute).not.toHaveBeenCalled();
    });

    it('routes to PipelineExecutor for pipelines', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('pipeline'));
      mockPipelineExecutorExecute.mockResolvedValue(makePipelineResult());

      const result = await client.run('ci-pipeline', { target: '/tmp/test' });

      expect(result.type).toBe('pipeline');
      expect(mockPipelineExecutorExecute).toHaveBeenCalled();
    });

    it('throws for unknown definition type', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('unknown'));

      await expect(client.run('mystery', { target: '/tmp' })).rejects.toThrow('Unknown definition type');
    });

    it('resolves without type hint (auto-detect)', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.run('validate@1.0.0', { target: '/tmp/test' });

      // run() does NOT pass a type hint — registry auto-detects
      expect(mockRegistryResolve).toHaveBeenCalledWith('validate', '1.0.0');
    });

    it('submits to submission service when tracking enabled', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.run('validate', { target: '/tmp/test' });

      expect(mockSubmissionSubmit).toHaveBeenCalledWith(expect.objectContaining({
        project: 'test',
        workflowType: 'validate',
        result: expect.objectContaining({ type: 'command' }),
        resolvedDefinition: expect.any(Object),
      }));
      expect(result.dashboardUrl).toBe('https://app.uluops.ai/runs/run-123');
    });
  });

  // ─── startPipeline ───────────────────────────────────────────────────────

  describe('startPipeline', () => {
    it('resolves pipeline and delegates to PipelineExecutor.start', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      const resolved = makeResolvedDef('pipeline');
      mockRegistryResolve.mockResolvedValue(resolved);
      const mockHandle = { executionId: 'pipe_123', wait: vi.fn(), cancel: vi.fn(), status: vi.fn() };
      mockPipelineExecutorStart.mockResolvedValue(mockHandle);

      const handle = await client.startPipeline('ci-pipeline', { target: '/tmp/test' });

      expect(handle.executionId).toBe('pipe_123');
      expect(mockPipelineExecutorStart).toHaveBeenCalledWith(resolved, { target: '/tmp/test' });
    });

    it('throws when resolved type is not pipeline', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));

      await expect(client.startPipeline('validate', { target: '/tmp/test' })).rejects.toThrow('not a pipeline');
    });
  });

  // ─── Convenience Methods ─────────────────────────────────────────────────

  describe('convenience methods', () => {
    it('validate() resolves "validate" as command', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.validate('/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('validate', undefined, 'command');
    });

    it('validate() passes options to input', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.validate('/tmp/test', { strict: true });

      expect(mockCommandExecutorExecute).toHaveBeenCalledWith(
        expect.anything(),
        { target: '/tmp/test', options: { strict: true } },
        undefined,
      );
    });

    it('ship() resolves "ship" as workflow', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('workflow', 'ship'));
      mockWorkflowExecutorExecute.mockResolvedValue(makeWorkflowResult());

      await client.ship('/tmp/test', { skip_security: false });

      expect(mockRegistryResolve).toHaveBeenCalledWith('ship', undefined, 'workflow');
      expect(mockWorkflowExecutorExecute).toHaveBeenCalledWith(
        expect.anything(),
        { target: '/tmp/test', options: { skip_security: false } },
      );
    });

    it('security() resolves "security" as command', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'security'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.security('/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('security', undefined, 'command');
    });

    it('optimize() resolves "optimize" as command', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'optimize'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.optimize('/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('optimize', undefined, 'command');
    });

    it('postImplementation() resolves "post-implementation" as workflow', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('workflow', 'post-implementation'));
      mockWorkflowExecutorExecute.mockResolvedValue(makeWorkflowResult());

      await client.postImplementation('/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('post-implementation', undefined, 'workflow');
    });
  });

  // ─── Discovery ───────────────────────────────────────────────────────────

  describe('discovery', () => {
    it('list() passes filter to registry.list', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryList.mockResolvedValue([
        { type: 'command', name: 'validate', version: '1.0.0' },
      ]);

      const results = await client.list({ type: 'command' });

      expect(mockRegistryList).toHaveBeenCalledWith({ type: 'command' });
      expect(results).toHaveLength(1);
    });

    it('describe() resolves and returns interface metadata', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));

      const info = await client.describe('validate');

      expect(info.type).toBe('command');
      expect(info.name).toBe('validate');
      expect(info.version).toBe('1.0.0');
      expect(info.hash).toBe('sha256:test');
      expect(info.interface).toEqual({
        name: 'validate',
        version: '1.0.0',
        displayName: 'validate',
        description: 'Test',
        domain: 'software',
      });
    });

    it('describe() extracts agent interface', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      const def = makeResolvedDef('agent', 'code-validator');
      mockRegistryResolve.mockResolvedValue(def);

      const info = await client.describe('code-validator');

      expect(info.type).toBe('agent');
      expect(info.interface).toHaveProperty('name', 'code-validator');
    });

    it('describe() forwards version and type to registry.resolve for disambiguation', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue(
        makeResolvedDef('command', 'socrates-explorer'),
      );

      await client.describe('socrates-explorer', '1.0.0', 'command');

      expect(mockRegistryResolve).toHaveBeenCalledWith(
        'socrates-explorer',
        '1.0.0',
        'command',
      );
    });

    it('describe() returns {} for malformed definition', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockRegistryResolve.mockResolvedValue({
        ...makeResolvedDef('command'),
        definition: {} as ResolvedDefinition['definition'], // No known keys
      });

      const info = await client.describe('validate');
      expect(info.interface).toEqual({});
    });
  });

  // ─── Submission Delegation ──────────────────────────────────────────────

  describe('submission delegation', () => {
    it('getHistory() passes project and options to SubmissionClient', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockSubmissionGetHistory.mockResolvedValue([]);

      const result = await client.getHistory('my-project', { workflowType: 'ship', limit: 5 });

      expect(mockSubmissionGetHistory).toHaveBeenCalledWith('my-project', { workflowType: 'ship', limit: 5 });
      expect(result).toEqual([]);
    });

    it('getHistory() passes undefined options when not provided', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockSubmissionGetHistory.mockResolvedValue([]);

      await client.getHistory('my-project');

      expect(mockSubmissionGetHistory).toHaveBeenCalledWith('my-project', undefined);
    });

    it('submitResults() delegates to submission.submit', async () => {
      const client = new UluOpsClient({ apiKey: 'ulr_test-key' });
      mockSubmissionSubmit.mockResolvedValue(makeSubmissionResponse());
      const cmdResult = makeCommandResult();

      const response = await client.submitResults('my-project', 'command', cmdResult);

      expect(mockSubmissionSubmit).toHaveBeenCalledWith({
        project: 'my-project',
        workflowType: 'command',
        result: cmdResult,
      });
      expect(response.runId).toBe('run-123');
    });
  });
});
