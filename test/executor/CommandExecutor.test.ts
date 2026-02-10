import { describe, it, expect, vi } from 'vitest';
import { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { RegistryClient } from '../../src/registry/RegistryClient.js';
import type { ResolvedDefinition, ValidatorRuntime } from '../../src/types/registry.js';
import type { ValidatorAgentResult, ExecutorAgentResult } from '../../src/types/agent.js';

function makeAgentExecutor(results?: Array<ValidatorAgentResult | ExecutorAgentResult>): AgentExecutor {
  const resultQueue = results ? [...results] : [];
  return {
    execute: vi.fn().mockImplementation(() => {
      if (resultQueue.length > 0) return Promise.resolve(resultQueue.shift());
      return Promise.resolve(makeValidatorResult());
    }),
  } as unknown as AgentExecutor;
}

function makeRegistry(agentDefs?: Record<string, ResolvedDefinition>): RegistryClient {
  return {
    resolve: vi.fn().mockImplementation((name: string) => {
      if (agentDefs?.[name]) return Promise.resolve(agentDefs[name]);
      return Promise.resolve(makeAgentDef(name));
    }),
  } as unknown as RegistryClient;
}

function makeAgentDef(name = 'test-agent'): ResolvedDefinition {
  return {
    type: 'agent',
    name,
    version: '1.0.0',
    hash: 'sha256:agent',
    yaml: '',
    definition: {} as ResolvedDefinition['definition'],
    runtime: {
      prompt: 'test',
      defaults: { model: 'sonnet', timeout: 30000 },
      config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' },
    } as ValidatorRuntime,
    domain: 'software',
    agentType: 'validator',
  };
}

function makeValidatorResult(overrides?: Partial<ValidatorAgentResult>): ValidatorAgentResult {
  return {
    type: 'agent',
    agentType: 'validator',
    name: 'test-agent',
    version: '1.0.0',
    definitionHash: 'sha256:agent',
    decision: 'PASS',
    score: 85,
    maxScore: 100,
    recommendations: [
      { validator: 'test-agent', title: 'Issue 1', priority: 'suggested' },
    ],
    durationMs: 1000,
    metrics: {
      inputTokens: 500,
      outputTokens: 200,
      totalEffectiveTokens: 750,
      durationMs: 1000,
      model: 'claude-sonnet-4-5-20250929',
    },
    ...overrides,
  };
}

function makeCommandDef(overrides?: Record<string, unknown>): ResolvedDefinition {
  return {
    type: 'command',
    name: 'test-command',
    version: '1.0.0',
    hash: 'sha256:cmd123',
    yaml: '',
    definition: {
      command: {
        interface: { name: 'test-command', version: '1.0.0', displayName: 'Test', description: 'A test command', domain: 'software' },
        agents: ['test-agent@1.0.0'],
        execution: {
          model: { default: 'sonnet' },
          timeout: 30000,
          thresholds: { pass: 75, warn: 50 },
        },
        ...overrides,
      },
    } as ResolvedDefinition['definition'],
    runtime: {} as ResolvedDefinition['runtime'],
    domain: 'software',
  };
}

describe('CommandExecutor', () => {
  describe('single-agent execution', () => {
    it('delegates to AgentExecutor and wraps result', async () => {
      const agentExec = makeAgentExecutor([makeValidatorResult()]);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const result = await executor.execute(makeCommandDef(), { target: '/tmp/test' });

      expect(result.type).toBe('command');
      expect(result.name).toBe('test-command');
      expect(result.version).toBe('1.0.0');
      expect(result.definitionHash).toBe('sha256:cmd123');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(85);
      expect(result.threshold).toBe(75);
      expect(result.recommendations).toHaveLength(1);
    });

    it('resolves agent from registry using ref', async () => {
      const agentExec = makeAgentExecutor([makeValidatorResult()]);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      await executor.execute(makeCommandDef(), { target: '/tmp/test' });

      expect(registry.resolve).toHaveBeenCalledWith('test-agent', '1.0.0', 'agent');
    });

    it('passes command thresholds to agent execution', async () => {
      const agentExec = makeAgentExecutor([makeValidatorResult()]);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      await executor.execute(makeCommandDef(), { target: '/tmp/test' });

      const agentCall = (agentExec.execute as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const options = agentCall[2] as Record<string, unknown>;
      expect(options.model).toBe('sonnet');
      expect(options.thresholds).toEqual({ pass: 75, warn: 50 });
    });

    it('wraps executor agent result', async () => {
      const execResult: ExecutorAgentResult = {
        type: 'agent',
        agentType: 'executor',
        name: 'exec-agent',
        version: '1.0.0',
        definitionHash: 'sha256:exec',
        decision: 'COMPLETE',
        artifacts: [{ name: 'output.md', type: 'file', content: '# Done' }],
        recommendations: [],
        durationMs: 2000,
        metrics: { inputTokens: 100, outputTokens: 50, totalEffectiveTokens: 150, durationMs: 2000, model: 'haiku' },
      };

      const agentExec = makeAgentExecutor([execResult]);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const result = await executor.execute(makeCommandDef(), { target: '/tmp/test' });

      expect(result.agentType).toBe('executor');
      expect(result.decision).toBe('COMPLETE');
      expect(result.artifacts).toHaveLength(1);
    });
  });

  describe('multi-agent execution', () => {
    it('aggregates multiple validator results with average', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 80 }),
        makeValidatorResult({ name: 'agent-b', score: 90 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
        aggregation: { method: 'average' },
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(85);
      expect(result.decision).toBe('PASS');
      expect(result.recommendations).toHaveLength(2);
    });

    it('aggregates with min method', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 60 }),
        makeValidatorResult({ name: 'agent-b', score: 90 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
        aggregation: { method: 'min' },
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(60);
      expect(result.decision).toBe('WARN'); // 60 >= 50 (warn) but < 75 (pass)
    });

    it('aggregates with weighted_average', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 100 }),
        makeValidatorResult({ name: 'agent-b', score: 50 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
        aggregation: { method: 'weighted_average', weights: { 'agent-a': 3, 'agent-b': 1 } },
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(87.5); // (100*3 + 50*1) / 4
      expect(result.decision).toBe('PASS');
    });

    it('FAIL when aggregated score below warn threshold', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 30 }),
        makeValidatorResult({ name: 'agent-b', score: 40 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(35);
      expect(result.decision).toBe('FAIL');
    });

    it('aggregates metrics across agents', async () => {
      const results = [
        makeValidatorResult({
          name: 'agent-a',
          metrics: { inputTokens: 500, outputTokens: 200, totalEffectiveTokens: 750, durationMs: 1000, model: 'sonnet' },
        }),
        makeValidatorResult({
          name: 'agent-b',
          metrics: { inputTokens: 300, outputTokens: 100, totalEffectiveTokens: 450, durationMs: 800, model: 'sonnet' },
        }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.metrics.inputTokens).toBe(800);
      expect(result.metrics.outputTokens).toBe(300);
      expect(result.metrics.totalEffectiveTokens).toBe(1200);
      expect(result.metrics.model).toBe('mixed');
    });
  });

  describe('threshold boundary conditions', () => {
    it('PASS at exact pass threshold (score=75)', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 75 }),
        makeValidatorResult({ name: 'agent-b', score: 75 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(75);
      expect(result.decision).toBe('PASS');
    });

    it('WARN at one below pass threshold (score=74)', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 74 }),
        makeValidatorResult({ name: 'agent-b', score: 74 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(74);
      expect(result.decision).toBe('WARN');
    });

    it('WARN at exact warn threshold (score=50)', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 50 }),
        makeValidatorResult({ name: 'agent-b', score: 50 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(50);
      expect(result.decision).toBe('WARN');
    });

    it('FAIL at one below warn threshold (score=49)', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 49 }),
        makeValidatorResult({ name: 'agent-b', score: 49 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(49);
      expect(result.decision).toBe('FAIL');
    });

    it('PASS at maximum score (score=100)', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 100 }),
        makeValidatorResult({ name: 'agent-b', score: 100 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(100);
      expect(result.decision).toBe('PASS');
    });

    it('FAIL at minimum score (score=0)', async () => {
      const results = [
        makeValidatorResult({ name: 'agent-a', score: 0 }),
        makeValidatorResult({ name: 'agent-b', score: 0 }),
      ];
      const agentExec = makeAgentExecutor(results);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        agents: ['agent-a@1.0.0', 'agent-b@1.0.0'],
      });

      const result = await executor.execute(cmdDef, { target: '/tmp/test' });

      expect(result.score).toBe(0);
      expect(result.decision).toBe('FAIL');
    });
  });

  describe('preflight checks', () => {
    it('runs preflight checks before execution', async () => {
      const agentExec = makeAgentExecutor([makeValidatorResult()]);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        execution: {
          model: { default: 'sonnet' },
          preflight: [
            { check: 'env_var', var: 'PATH' },
          ],
          thresholds: { pass: 75 },
        },
      });

      // Should not throw since PATH exists
      const result = await executor.execute(cmdDef, { target: '/tmp/test' });
      expect(result.decision).toBe('PASS');
    });

    it('throws PreflightError when check fails', async () => {
      const agentExec = makeAgentExecutor([makeValidatorResult()]);
      const registry = makeRegistry();
      const executor = new CommandExecutor(agentExec, registry);

      const cmdDef = makeCommandDef({
        execution: {
          model: { default: 'sonnet' },
          preflight: [
            { check: 'env_var', var: 'NONEXISTENT_VAR_XYZZY_12345' },
          ],
          thresholds: { pass: 75 },
        },
      });

      await expect(
        executor.execute(cmdDef, { target: '/tmp/test' }),
      ).rejects.toThrow('NONEXISTENT_VAR_XYZZY_12345');
    });
  });
});
