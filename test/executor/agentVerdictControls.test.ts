/**
 * The PDL 1.6.0 P4a negative controls named in the checklist, through the real AgentExecutor with a
 * provider that returns fixed text. Each fails on the pre-P4a tree (6f89349).
 */
import { describe, it, expect } from 'vitest';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import type { Logger } from '@uluops/sdk-core';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  apiKey: 'k', ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' }, registryUrl: 'https://r', submissionUrl: 'https://s',
  dashboardUrl: 'https://d', trackingEnabled: false, timeout: 30000, debug: false, defaultThinkingBudget: 10_000, contextBudget: 200_000, maxConcurrency: 8, allowStageSteps: false,
} as unknown as ResolvedConfig;
const provider = (text: string) => ({
  generate: async () => ({ text, usage: { input_tokens: 1, output_tokens: 1 }, toolCallCount: 0, model: 'anthropic:stub', provider: 'anthropic', steps: 1, finishReason: 'stop' }),
  resolveModel: async () => ({ provider: 'anthropic', modelId: 'stub', providerModelId: 'stub', tier: 'premium', capabilities: { tools: true }, contextWindow: 200_000, resolvedFrom: 'sonnet' }),
  createProviderShellTool: () => undefined,
}) as unknown as AIProvider;
const validator = (decisions?: unknown) => ({
  type: 'agent', name: 'v', version: '1.0.0', hash: 'h', yaml: '', domain: 'software', agentType: 'validator',
  definition: { agent: decisions ? { decisions } : {} },
  runtime: { prompt: 'p', defaults: { model: 'sonnet', timeout: 30000 }, config: { maxScore: 100, categories: [], outputSchema: 'json' } },
}) as unknown as ResolvedDefinition;
const run = (text: string, decisions?: unknown) => new AgentExecutor(config, provider(text), noopLogger).execute(validator(decisions), { target: '/tmp' });
const fence = (o: unknown) => 'Report.\n```json\n' + JSON.stringify(o) + '\n```';

describe('P4a negative controls (each fails on 6f89349)', () => {
  it('REJECT from a validator reads neutral, not FAIL (synonyms do not gate; decisions/synonym-reject-reads-neutral)', async () => {
    const r = await run(fence({ result: { decision: 'REJECT', score: 90, max_score: 100 } }));
    expect(r.decisionCategory).toBe('neutral');
    expect(r.decision).toBe('REJECT');
  });

  it('a score found only at summary.score is no score (decisions/score-fallback-only)', async () => {
    const r = await run(fence({ summary: { score: 90 }, result: { decision: 'MAYBE' } }));
    expect(r.score).toBeNull();
    expect(r.verdict?.warnings).toContainEqual({ code: 'FALLBACK_SCORE_SOURCE', agent: 'v', source: 'summary.score' });
  });

  it('prose "decision: SECURE WITH CONDITIONS" reads neutral, not SECURE (the structured-text \\w+ capture)', async () => {
    const r = await run('Analysis complete.\ndecision: SECURE WITH CONDITIONS\nscore: 90\n',
      { vocabulary: { positive: 'SECURE', negative: 'BLOCKED', conditional: 'CONDITIONAL' } });
    expect(r.decisionCategory).toBe('neutral');
    expect(r.decision).toBe('SECURE WITH CONDITIONS');
  });

  it('**REVISE** (Score: 85) reads negative through the token rule (was an unrecognised token)', async () => {
    const r = await run(fence({ result: { decision: '**REVISE** (Score: 85)', score: 85, max_score: 100 } }),
      { vocabulary: { positive: 'PROCEED', negative: 'REVISE' } });
    expect(r.decisionCategory).toBe('negative');
    expect(r.decision).toBe('REVISE');
  });
});
