import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { AIProvider, AIGenerateResult } from '../../src/ai/AIProvider.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { ResolvedDefinition, AgentRuntime, ExecutorRuntime } from '../../src/types/registry.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// Mock token counts for AI provider responses
const MOCK_INPUT_TOKENS = 500;
const MOCK_OUTPUT_TOKENS = 200;
const MOCK_CACHE_CREATION_TOKENS = 50;
const MOCK_CACHE_READ_TOKENS = 25;
const MOCK_TOTAL_EFFECTIVE_TOKENS = MOCK_INPUT_TOKENS + MOCK_OUTPUT_TOKENS + MOCK_CACHE_CREATION_TOKENS;

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
  timeout: 30000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
};

function mockAIProvider(overrides?: Partial<AIGenerateResult>): AIProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        decision: 'PASS',
        score: 85,
        maxScore: 100,
        categories: [
          {
            name: 'Quality',
            score: 40,
            maxScore: 50,
            findings: [
              {
                criterion: 'Readability',
                pointsEarned: 20,
                pointsPossible: 25,
                issues: [
                  {
                    title: 'Long function',
                    priority: 'suggested',
                    severity: 'medium',
                    filePath: 'src/index.ts',
                    lineNumber: 10,
                    description: 'Function exceeds 50 lines',
                  },
                ],
              },
            ],
          },
        ],
      }),
      usage: {
        input_tokens: MOCK_INPUT_TOKENS,
        output_tokens: MOCK_OUTPUT_TOKENS,
        cache_creation_input_tokens: MOCK_CACHE_CREATION_TOKENS,
        cache_read_input_tokens: MOCK_CACHE_READ_TOKENS,
      },
      toolCallCount: 3,
      model: 'anthropic:claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      steps: 4,
      finishReason: 'stop',
      ...overrides,
    }),
    resolveModel: vi.fn().mockResolvedValue({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      providerModelId: 'claude-sonnet-4-5-20250929',
      tier: 'premium',
      capabilities: { tools: true },
      contextWindow: 200_000,
      resolvedFrom: 'sonnet',
    }),
  } as unknown as AIProvider;
}

function makeValidatorDef(overrides?: Partial<ResolvedDefinition>): ResolvedDefinition {
  return {
    type: 'agent',
    name: 'test-validator',
    version: '1.0.0',
    hash: 'sha256:abc123',
    yaml: '',
    definition: {} as ResolvedDefinition['definition'],
    runtime: {
      prompt: 'You are a test validator. Analyze the code.',
      defaults: { model: 'sonnet', timeout: 30000 },
      config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' },
    } as AgentRuntime,
    domain: 'software',
    agentType: 'validator',
    ...overrides,
  };
}

function makeExecutorDef(): ResolvedDefinition {
  return {
    type: 'agent',
    name: 'test-executor',
    version: '1.0.0',
    hash: 'sha256:def456',
    yaml: '',
    definition: {} as ResolvedDefinition['definition'],
    runtime: {
      prompt: 'You are a test executor. Perform the task.',
      defaults: { model: 'haiku', timeout: 60000 },
      config: { mode: 'execute', inputs: [], tasks: [], outputs: [], completionCriteria: [], outputSchema: 'json' },
    } as ExecutorRuntime,
    domain: 'software',
    agentType: 'executor',
  };
}

describe('AgentExecutor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentexec-'));
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'util.ts'), 'export function hello() { return "hi"; }\n');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('validator execution', () => {
    it('executes a validator agent and returns ValidatorAgentResult', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeValidatorDef(), { target: tmpDir });

      expect(result.type).toBe('agent');
      expect(result.agentType).toBe('validator');
      expect(result.name).toBe('test-validator');
      expect(result.version).toBe('1.0.0');
      expect(result.definitionHash).toBe('sha256:abc123');

      // Validator-specific fields
      if (result.agentType === 'validator') {
        expect(result.decision).toBe('PASS');
        expect(result.score).toBe(85);
        expect(result.maxScore).toBe(100);
        expect(result.categories).toHaveLength(1);
        expect(result.categories![0]!.name).toBe('Quality');
      }
    });

    it('flattens recommendations from parsed categories', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeValidatorDef(), { target: tmpDir });

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0]!.agent).toBe('test-validator');
      expect(result.recommendations[0]!.title).toBe('Long function');
      expect(result.recommendations[0]!.priority).toBe('suggested');
      expect(result.recommendations[0]!.filePath).toBe('src/index.ts');
      expect(result.recommendations[0]!.lineNumber).toBe(10);
    });

    it('computes metrics from AI SDK usage', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeValidatorDef(), { target: tmpDir });

      expect(result.metrics.inputTokens).toBe(MOCK_INPUT_TOKENS);
      expect(result.metrics.outputTokens).toBe(MOCK_OUTPUT_TOKENS);
      expect(result.metrics.cacheCreationTokens).toBe(MOCK_CACHE_CREATION_TOKENS);
      expect(result.metrics.cacheReadTokens).toBe(MOCK_CACHE_READ_TOKENS);
      expect(result.metrics.totalEffectiveTokens).toBe(MOCK_TOTAL_EFFECTIVE_TOKENS);
      expect(result.metrics.model).toBe('anthropic:claude-sonnet-4-5-20250929');
      expect(result.metrics.durationMs).toBeGreaterThan(0);
    });

    it('includes thinking_tokens in totalEffectiveTokens for Google models', async () => {
      const THINKING_TOKENS = 100;
      const ai = mockAIProvider({
        usage: {
          input_tokens: MOCK_INPUT_TOKENS,
          output_tokens: MOCK_OUTPUT_TOKENS,
          cache_creation_input_tokens: MOCK_CACHE_CREATION_TOKENS,
          cache_read_input_tokens: MOCK_CACHE_READ_TOKENS,
          thinking_tokens: THINKING_TOKENS,
        },
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeValidatorDef(), { target: tmpDir });

      // thinking_tokens are charged separately by Google, so they are added to effective total
      expect(result.metrics.totalEffectiveTokens).toBe(
        MOCK_INPUT_TOKENS + MOCK_OUTPUT_TOKENS + MOCK_CACHE_CREATION_TOKENS + THINKING_TOKENS,
      );
    });

    it('passes threshold from options', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(
        makeValidatorDef(),
        { target: tmpDir },
        { thresholds: { pass: 80, warn: 60 } },
      );

      if (result.agentType === 'validator') {
        expect(result.threshold).toBe(80);
      }
    });

    it('propagates threshold from definition defaults when no options override', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const def = makeValidatorDef({
        runtime: {
          prompt: 'You are a test validator.',
          defaults: { model: 'sonnet', timeout: 30000, thresholds: { pass: 70, warn: 50 } },
          config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' },
        } as AgentRuntime,
      });

      const result = await executor.execute(def, { target: tmpDir });

      expect(result.threshold).toBe(70);
    });
  });

  describe('executor execution', () => {
    it('executes an executor agent and returns ExecutorAgentResult', async () => {
      const ai = mockAIProvider({
        text: JSON.stringify({
          decision: 'COMPLETE',
          artifacts: [
            { name: 'report.md', type: 'file', content: '# Report' },
          ],
        }),
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeExecutorDef(), { target: tmpDir });

      expect(result.type).toBe('agent');
      expect(result.agentType).toBe('executor');
      expect(result.name).toBe('test-executor');

      if (result.agentType === 'executor') {
        expect(result.decision).toBe('COMPLETE');
        expect(result.artifacts).toHaveLength(1);
        expect(result.artifacts![0]!.name).toBe('report.md');
      }
    });
  });

  describe('context resolution', () => {
    it('uses agent defaults when no options provided', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(generateCall.model).toBe('sonnet');
      expect(generateCall.maxTokens).toBe(16384);
      expect(generateCall.timeoutMs).toBe(30000);
    });

    it('options override agent defaults', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir },
        { model: 'opus', maxTokens: 16384, timeoutMs: 60000 },
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(generateCall.model).toBe('opus');
      expect(generateCall.maxTokens).toBe(16384);
      expect(generateCall.timeoutMs).toBe(60000);
    });

    it('config modelOverride used when no agent/option model', async () => {
      const ai = mockAIProvider();
      const config: ResolvedConfig = {
        ...baseConfig,
        ai: { ...baseConfig.ai, modelOverride: 'opus' },
      };
      const executor = new AgentExecutor(config, ai, noopLogger);

      const defWithoutModel = makeValidatorDef({
        runtime: {
          prompt: 'test',
          defaults: { model: undefined as unknown as string, timeout: 30000 },
          config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' },
        } as AgentRuntime,
      });

      await executor.execute(defWithoutModel, { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(generateCall.model).toBe('opus');
    });
  });

  describe('initial message', () => {
    it('includes project structure in initial message', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;

      expect(prompt).toContain('Target:');
      expect(prompt).toContain('Project Structure:');
      expect(prompt).toContain('index.ts');
      expect(prompt).toContain('util.ts');
      expect(prompt).toContain('TypeScript');
      expect(prompt).toContain('Files: 2');
    });

    it('passes options in initial message', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir, options: { verbose: true } },
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toContain('"verbose":true');
    });

    it('suppresses Options line when options is empty', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).not.toContain('Options:');
    });

    it('includes operator prompt as Directive when provided', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir, prompt: 'Focus on the authentication module' },
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toContain('Directive:');
      expect(prompt).toContain('Focus on the authentication module');
    });

    it('places Directive before project context', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir, prompt: 'Focus on auth' },
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      const directiveIndex = prompt.indexOf('Directive:');
      const targetIndex = prompt.indexOf('Target:');
      expect(directiveIndex).toBeLessThan(targetIndex);
    });

    it('omits Directive section when no prompt provided', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).not.toContain('Directive:');
    });

    it('uses "Analyze" preamble for validator agents', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toMatch(/^Analyze the following project:/);
    });

    it('uses "Generate" preamble for generator agents', async () => {
      const ai = mockAIProvider({
        text: JSON.stringify({ decision: 'ACTUALIZED', score: 91 }),
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const generatorDef = makeValidatorDef({
        name: 'test-generator',
        agentType: 'generator',
        runtime: {
          prompt: 'You are a generator.',
          defaults: { model: 'opus', timeout: 60000 },
          config: { mode: 'execute', inputs: [], tasks: [], outputs: [], completionCriteria: [], outputSchema: 'json' },
        } as ExecutorRuntime,
      });

      await executor.execute(generatorDef, { target: tmpDir, prompt: 'Create a REST endpoint' });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toMatch(/^Generate the requested artifact/);
      expect(prompt).toContain('Directive:');
      expect(prompt).toContain('Create a REST endpoint');
    });

    it('uses "Execute" preamble for executor agents', async () => {
      const ai = mockAIProvider({
        text: JSON.stringify({ decision: 'COMPLETE' }),
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeExecutorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toMatch(/^Execute the requested operation/);
    });

    it('uses "Explore" preamble for explorer agents', async () => {
      const ai = mockAIProvider({
        text: JSON.stringify({ decision: 'EXPLORED' }),
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const explorerDef = makeValidatorDef({
        name: 'test-explorer',
        agentType: 'explorer',
      });

      await executor.execute(explorerDef, { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toMatch(/^Explore the following project:/);
    });

    it('uses "Forecast" preamble for forecaster agents', async () => {
      const ai = mockAIProvider({
        text: JSON.stringify({ decision: 'HIGH_CONFIDENCE' }),
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const forecasterDef = makeValidatorDef({
        name: 'test-forecaster',
        agentType: 'forecaster',
      });

      await executor.execute(forecasterDef, { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toMatch(/^Forecast trends for the following project:/);
    });

    it('uses "Analyze" preamble for analyst agents', async () => {
      const ai = mockAIProvider({
        text: JSON.stringify({ decision: 'COHERENT', score: 75 }),
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const analystDef = makeValidatorDef({
        name: 'test-analyst',
        agentType: 'analyst',
      });

      await executor.execute(analystDef, { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      const prompt = generateCall.prompt as string;
      expect(prompt).toMatch(/^Analyze the following project:/);
    });
  });

  describe('error handling', () => {
    it('propagates AI provider errors', async () => {
      const ai = {
        generate: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
        resolveModel: vi.fn().mockResolvedValue({
          provider: 'anthropic',
          modelId: 'claude-sonnet-4-5-20250929',
          providerModelId: 'claude-sonnet-4-5-20250929',
          tier: 'premium',
          capabilities: { tools: true },
          contextWindow: 200_000,
          resolvedFrom: 'sonnet',
        }),
      } as unknown as AIProvider;
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await expect(
        executor.execute(makeValidatorDef(), { target: tmpDir }),
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('handles empty response gracefully', async () => {
      const ai = mockAIProvider({
        text: '{}',
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeValidatorDef(), { target: tmpDir });

      // Should still return a result with defaults
      if (result.agentType === 'validator') {
        expect(result.score).toBe(0);
        expect(result.decision).toBeDefined();
      }
    });

    it('handles non-JSON AI response gracefully', async () => {
      const ai = mockAIProvider({
        text: 'This is not JSON at all, just plain text analysis.',
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      const result = await executor.execute(makeValidatorDef(), { target: tmpDir });

      // Should still return a result with fallback defaults
      expect(result.type).toBe('agent');
      expect(result.name).toBe('test-validator');
      if (result.agentType === 'validator') {
        expect(result.score).toBe(0);
      }
    });

    it('handles non-existent target directory gracefully', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      // Non-existent target should still produce a result (tools handle missing dirs)
      const result = await executor.execute(
        makeValidatorDef(),
        { target: '/tmp/nonexistent-dir-xyz-99999' },
      );

      expect(result.type).toBe('agent');
      expect(result.name).toBe('test-validator');
    });
  });

  // ── v0.1.1: reportMode gating ──────────────────────────────────────────
  // Report mode disables AI SDK structured-output enforcement so a publication-
  // mode prompt directive (@uluops/cli's --report flag) can take effect.
  // See agent-reporting-spec-v0_1_1.md Phase 4.3 for the full rationale.

  describe('context budget reconciliation (Cluster A)', () => {
    it('passes the model-window-derived effective budget to generate (sub-200k model)', async () => {
      const ai = mockAIProvider();
      // Model with a 128k window — below the 200k operator config → effective 128k.
      (ai.resolveModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: 'openai',
        modelId: 'gpt-4.1-mini',
        providerModelId: 'gpt-4.1-mini',
        tier: 'standard',
        capabilities: { tools: true },
        contextWindow: 128_000,
        resolvedFrom: 'gpt-4.1-mini',
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(generateCall.contextBudget).toBe(128_000);
    });

    it('falls back to the operator budget when the model window is unknown', async () => {
      const ai = mockAIProvider();
      (ai.resolveModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: 'anthropic',
        modelId: 'unregistered',
        providerModelId: 'unregistered',
        tier: 'standard',
        capabilities: { tools: true },
        contextWindow: undefined,
        resolvedFrom: 'unregistered',
      });
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      // baseConfig.contextBudget = 200_000
      expect(generateCall.contextBudget).toBe(200_000);
    });
  });

  describe('reportMode (v0.1.1)', () => {
    it('passes output schema to aiProvider.generate by default (non-report-mode)', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(makeValidatorDef(), { target: tmpDir });

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(generateCall).toBeDefined();
      expect(generateCall).toHaveProperty('output');
      expect(generateCall.output).toMatchObject({ name: 'AgentResult' });
    });

    it('omits output schema from aiProvider.generate when reportMode is true', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir },
        { reportMode: true },
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(generateCall).toBeDefined();
      expect(generateCall).not.toHaveProperty('output');
    });

    it('passes output schema when reportMode is explicitly false', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir },
        { reportMode: false },
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(generateCall).toHaveProperty('output');
    });

    it('passes output schema when reportMode is undefined (default)', async () => {
      const ai = mockAIProvider();
      const executor = new AgentExecutor(baseConfig, ai, noopLogger);

      await executor.execute(
        makeValidatorDef(),
        { target: tmpDir },
        {}, // no reportMode field
      );

      const generateCall = (ai.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(generateCall).toHaveProperty('output');
    });
  });
});
