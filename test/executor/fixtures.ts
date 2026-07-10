/**
 * Shared test factory functions for executor tests.
 *
 * Provides mock builders for common types used across
 * CommandExecutor, WorkflowExecutor, and PipelineExecutor tests.
 */
import { vi } from 'vitest';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import type { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import type { RegistryClient } from '../../src/registry/RegistryClient.js';
import type { ResolvedDefinition, AgentRuntime } from '../../src/types/registry.js';
import type { AgentResult } from '../../src/types/agent.js';
import type { CommandResult } from '../../src/types/command.js';
import type { WorkflowResult } from '../../src/types/workflow.js';

// ─── Result Factories ────────────────────────────────────────────────────

export function makeValidatorResult(overrides?: Partial<AgentResult>): AgentResult {
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
      { agent: 'test-agent', title: 'Issue 1', priority: 'suggested' },
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

export function makeCommandResult(overrides?: Partial<CommandResult>): CommandResult {
  return {
    type: 'command',
    name: 'test-command',
    version: '1.0.0',
    definitionHash: 'sha256:cmd',
    agentType: 'validator',
    decision: 'PASS',
    score: 85,
    maxScore: 100,
    recommendations: [
      { agent: 'test', title: 'Issue 1', priority: 'suggested' },
    ],
    durationMs: 1000,
    metrics: {
      inputTokens: 500,
      outputTokens: 200,
      totalEffectiveTokens: 750,
      durationMs: 1000,
      model: 'claude-sonnet-4-5-20250929',
      toolCalls: 3,
    },
    ...overrides,
  };
}

export function makeWorkflowResult(overrides?: Partial<WorkflowResult>): WorkflowResult {
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
      inputTokens: 1000,
      outputTokens: 400,
      totalEffectiveTokens: 1400,
      durationMs: 2000,
      model: 'mixed',
      phasesExecuted: 2,
      phasesPassed: 2,
      phasesWarned: 0,
      phasesBlocked: 0,
      phasesSkipped: 0,
      commands: [],
    },
    ...overrides,
  };
}

// ─── Definition Factories ────────────────────────────────────────────────

export function makeAgentDef(name = 'test-agent'): ResolvedDefinition {
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
    } as AgentRuntime,
    domain: 'software',
    agentType: 'validator',
  };
}

// ─── Mock Executor/Registry Factories ────────────────────────────────────

export function makeAgentExecutor(results?: AgentResult[]): AgentExecutor {
  const resultQueue = results ? [...results] : [];
  return {
    execute: vi.fn().mockImplementation(() => {
      if (resultQueue.length > 0) return Promise.resolve(resultQueue.shift());
      return Promise.resolve(makeValidatorResult());
    }),
  } as unknown as AgentExecutor;
}

export function makeCommandExecutor(results?: CommandResult[]): CommandExecutor {
  const queue = results ? [...results] : [];
  return {
    execute: vi.fn().mockImplementation(() => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return Promise.resolve(makeCommandResult());
    }),
  } as unknown as CommandExecutor;
}

export function makeWorkflowExecutor(results?: WorkflowResult[]): WorkflowExecutor {
  const queue = results ? [...results] : [];
  return {
    execute: vi.fn().mockImplementation(() => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return Promise.resolve(makeWorkflowResult());
    }),
  } as unknown as WorkflowExecutor;
}

/**
 * Creates a CommandExecutor that dispatches results by command name.
 * Unlike the queue-based makeCommandExecutor, this returns deterministic
 * results regardless of execution order — essential for parallel tests.
 */
export function makeNamedCommandExecutor(
  resultMap: Record<string, Partial<Parameters<typeof makeCommandResult>[0]>>,
  opts?: { delayMs?: Record<string, number> },
): CommandExecutor {
  return {
    execute: vi.fn().mockImplementation(async (resolved: ResolvedDefinition) => {
      const delay = opts?.delayMs?.[resolved.name];
      if (delay) await new Promise(r => setTimeout(r, delay));
      const overrides = resultMap[resolved.name] ?? {};
      return makeCommandResult({ name: resolved.name, ...overrides });
    }),
  } as unknown as CommandExecutor;
}

export function makeRegistry(resolutions?: Record<string, ResolvedDefinition>): RegistryClient {
  return {
    resolve: vi.fn().mockImplementation((name: string, version?: string, type?: string) => {
      if (resolutions?.[name]) return Promise.resolve(resolutions[name]);
      const key = version ? `${name}@${version}` : name;
      if (resolutions?.[key]) return Promise.resolve(resolutions[key]);
      return Promise.resolve({
        type: type ?? 'command',
        name,
        version: version ?? '1.0.0',
        hash: 'sha256:resolved',
        yaml: '',
        definition: {} as ResolvedDefinition['definition'],
        runtime: {} as ResolvedDefinition['runtime'],
        domain: 'software',
      } satisfies ResolvedDefinition);
    }),
  } as unknown as RegistryClient;
}
