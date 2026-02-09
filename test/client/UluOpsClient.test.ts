import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all internal dependencies
const mockRegistryResolve = vi.fn();
const mockRegistryList = vi.fn();
const mockValidationSubmit = vi.fn();
const mockValidationGetHistory = vi.fn();
const mockAgentExecutorExecute = vi.fn();
const mockCommandExecutorExecute = vi.fn();
const mockWorkflowExecutorExecute = vi.fn();
const mockPipelineExecutorExecute = vi.fn();
const mockPipelineExecutorStart = vi.fn();

vi.mock('../../src/registry/RegistryClient.js', () => ({
  RegistryClient: vi.fn(() => ({
    resolve: mockRegistryResolve,
    list: mockRegistryList,
  })),
}));

vi.mock('../../src/validation/ValidationClient.js', () => ({
  ValidationClient: vi.fn(() => ({
    submit: mockValidationSubmit,
    getHistory: mockValidationGetHistory,
  })),
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

import { UluOpsClient } from '../../src/client/UluOpsClient.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { AgentResult, ValidatorAgentResult } from '../../src/types/agent.js';
import type { CommandResult } from '../../src/types/command.js';
import type { WorkflowResult } from '../../src/types/workflow.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

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

function makeSubmissionResponse() {
  return {
    runId: 'run-123',
    runNumber: 1,
    projectId: 'proj-123',
    dashboardUrl: 'https://app.uluops.ai/runs/run-123',
    allGatesPassed: true,
    averageScore: 85,
    newIssues: [],
    recurringIssues: [],
    regressions: [],
    deduplicated: false,
  };
}

describe('UluOpsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidationSubmit.mockResolvedValue(makeSubmissionResponse());
  });

  describe('config validation', () => {
    it('throws when no API key is provided', () => {
      // Clear env vars
      const origApi = process.env['ULUOPS_API_KEY'];
      const origUlu = process.env['ULU_API_KEY'];
      delete process.env['ULUOPS_API_KEY'];
      delete process.env['ULU_API_KEY'];

      try {
        expect(() => new UluOpsClient({})).toThrow('API key is required');
      } finally {
        if (origApi) process.env['ULUOPS_API_KEY'] = origApi;
        if (origUlu) process.env['ULU_API_KEY'] = origUlu;
      }
    });

    it('accepts API key from config', () => {
      expect(() => new UluOpsClient({ apiKey: 'test-key' })).not.toThrow();
    });

    it('applies default values', () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      expect(client).toBeDefined();
    });
  });

  describe('runAgent', () => {
    it('resolves agent from registry and delegates to AgentExecutor', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      const resolved = makeResolvedDef('agent', 'code-validator');
      mockRegistryResolve.mockResolvedValue(resolved);
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      const result = await client.runAgent('code-validator', '/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('code-validator', undefined, 'agent');
      expect(mockAgentExecutorExecute).toHaveBeenCalled();
      expect(result.type).toBe('agent');
      expect(result.agentType).toBe('validator');
    });

    it('parses versioned ref', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator@1.2.0', '/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('code-validator', '1.2.0', 'agent');
    });

    it('passes execution options', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      await client.runAgent('code-validator', '/tmp/test', {
        model: 'opus',
        thresholds: { pass: 80 },
      });

      const executeCall = mockAgentExecutorExecute.mock.calls[0]!;
      expect(executeCall[2]).toEqual({ model: 'opus', thresholds: { pass: 80 } });
    });

    it('submits to validation service when tracking enabled', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent', 'code-validator'));
      const agentResult = makeAgentResult();
      mockAgentExecutorExecute.mockResolvedValue(agentResult);

      const result = await client.runAgent('code-validator', '/tmp/test');

      expect(mockValidationSubmit).toHaveBeenCalledWith({
        project: 'code-validator',
        workflowType: 'agent',
        result: agentResult,
      });
      expect(result.dashboardUrl).toBe('https://app.uluops.ai/runs/run-123');
    });

    it('throws when resolved type is not agent', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));

      await expect(client.runAgent('validate', '/tmp/test')).rejects.toThrow('not an agent');
    });
  });

  describe('runCommand', () => {
    it('resolves command and delegates to CommandExecutor', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.runCommand('validate', { target: '/tmp/test' });

      expect(mockRegistryResolve).toHaveBeenCalledWith('validate', undefined, 'command');
      expect(result.type).toBe('command');
    });

    it('submits to validation when tracking enabled', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.runCommand('validate', { target: '/tmp/test' });

      expect(mockValidationSubmit).toHaveBeenCalled();
      expect(result.dashboardUrl).toBeDefined();
    });
  });

  describe('runWorkflow', () => {
    it('resolves workflow and delegates to WorkflowExecutor', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('workflow', 'ship'));
      mockWorkflowExecutorExecute.mockResolvedValue(makeWorkflowResult());

      const result = await client.runWorkflow('ship', { target: '/tmp/test' });

      expect(mockRegistryResolve).toHaveBeenCalledWith('ship', undefined, 'workflow');
      expect(result.type).toBe('workflow');
    });
  });

  describe('run (auto-routing)', () => {
    it('routes to AgentExecutor for agents', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('agent'));
      mockAgentExecutorExecute.mockResolvedValue(makeAgentResult());

      const result = await client.run('code-validator', { target: '/tmp/test' });

      expect(result.type).toBe('agent');
      expect(mockAgentExecutorExecute).toHaveBeenCalled();
    });

    it('routes to CommandExecutor for commands', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.run('validate', { target: '/tmp/test' });

      expect(result.type).toBe('command');
      expect(mockCommandExecutorExecute).toHaveBeenCalled();
    });

    it('routes to WorkflowExecutor for workflows', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('workflow'));
      mockWorkflowExecutorExecute.mockResolvedValue(makeWorkflowResult());

      const result = await client.run('ship', { target: '/tmp/test' });

      expect(result.type).toBe('workflow');
      expect(mockWorkflowExecutorExecute).toHaveBeenCalled();
    });

    it('routes to PipelineExecutor for pipelines', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('pipeline'));
      mockPipelineExecutorExecute.mockResolvedValue(makePipelineResult());

      const result = await client.run('ci-pipeline', { target: '/tmp/test' });

      expect(result.type).toBe('pipeline');
      expect(mockPipelineExecutorExecute).toHaveBeenCalled();
    });

    it('submits to validation when tracking enabled', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: true });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      const result = await client.run('validate', { target: '/tmp/test' });

      expect(mockValidationSubmit).toHaveBeenCalled();
      expect(result.dashboardUrl).toBeDefined();
    });
  });

  describe('startPipeline', () => {
    it('resolves pipeline and delegates to PipelineExecutor.start', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('pipeline'));
      const mockHandle = { executionId: 'pipe_123', wait: vi.fn(), cancel: vi.fn(), status: vi.fn() };
      mockPipelineExecutorStart.mockResolvedValue(mockHandle);

      const handle = await client.startPipeline('ci-pipeline', { target: '/tmp/test' });

      expect(handle.executionId).toBe('pipe_123');
      expect(mockPipelineExecutorStart).toHaveBeenCalled();
    });

    it('throws when resolved type is not pipeline', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command'));

      await expect(client.startPipeline('validate', { target: '/tmp/test' })).rejects.toThrow('not a pipeline');
    });
  });

  describe('convenience methods', () => {
    it('validate() delegates to runCommand with "validate"', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));
      mockCommandExecutorExecute.mockResolvedValue(makeCommandResult());

      await client.validate('/tmp/test');

      expect(mockRegistryResolve).toHaveBeenCalledWith('validate', undefined, 'command');
    });

    it('ship() delegates to runWorkflow with "ship"', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key', trackingEnabled: false });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('workflow', 'ship'));
      mockWorkflowExecutorExecute.mockResolvedValue(makeWorkflowResult());

      await client.ship('/tmp/test', { skip_security: false });

      expect(mockRegistryResolve).toHaveBeenCalledWith('ship', undefined, 'workflow');
    });
  });

  describe('discovery', () => {
    it('list() delegates to registry.list', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      mockRegistryList.mockResolvedValue([
        { type: 'command', name: 'validate', version: '1.0.0' },
      ]);

      const results = await client.list({ type: 'command' });

      expect(mockRegistryList).toHaveBeenCalledWith({ type: 'command' });
      expect(results).toHaveLength(1);
    });

    it('describe() resolves and extracts interface', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      mockRegistryResolve.mockResolvedValue(makeResolvedDef('command', 'validate'));

      const info = await client.describe('validate');

      expect(info.type).toBe('command');
      expect(info.name).toBe('validate');
      expect(info.hash).toBe('sha256:test');
    });
  });

  describe('validation delegation', () => {
    it('getHistory() delegates to ValidationClient', async () => {
      const client = new UluOpsClient({ apiKey: 'test-key' });
      mockValidationGetHistory.mockResolvedValue([]);

      const result = await client.getHistory('my-project');

      expect(mockValidationGetHistory).toHaveBeenCalledWith('my-project', undefined);
      expect(result).toEqual([]);
    });
  });
});
