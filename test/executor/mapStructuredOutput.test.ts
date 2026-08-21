import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { ExecutionError } from '../../src/errors/index.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { ResolvedDefinition, AgentRuntime } from '../../src/types/registry.js';
import type { AgentDefinition } from '../../src/types/agent.js';
import type { Logger } from '@uluops/sdk-core';

/**
 * FIRST COVERAGE OF mapStructuredOutput.
 *
 * Until now `mockAIProvider` returned only `text`, never `structuredOutput`, so the
 * structured-output branch of parseOutput had NEVER executed under test. That gap is
 * why the nullable→optional schema conversion could have shipped a regression: with
 * bare `.optional()`, a model emitting `"summary": null` — which the previous all-nullable
 * schema actively taught it to do — would fail safeParse and throw ExecutionError,
 * turning a working run into a hard failure. Nothing would have caught it.
 *
 * The null-tolerance case below is the standing guard for that.
 */
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const baseConfig = {
  apiKey: 'k', registryUrl: 'https://r', submissionUrl: 'https://s', dashboardUrl: 'https://d',
  trackingEnabled: false, timeout: 30000, debug: false, maxConcurrency: 8, allowStageSteps: false,
  defaultThinkingBudget: 0, contextBudget: 100000,
  ai: { providers: { anthropic: { apiKey: 'k' } }, defaultProvider: 'anthropic' },
} as unknown as ResolvedConfig;

function defWithVocab(): ResolvedDefinition {
  return {
    type: 'agent', name: 'sut', version: '1.0.0', hash: 'sha256:x', yaml: '',
    definition: { agent: {} } as Partial<AgentDefinition>,
    runtime: {
      prompt: 'p',
      defaults: { model: 'sonnet', timeout: 30000 },
      config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' },
    } as AgentRuntime,
    domain: 'software', agentType: 'validator',
  } as ResolvedDefinition;
}

/** Injects a parsed object on the structuredOutput channel (never exercised before). */
function structuredProvider(output: unknown): AIProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: '', structuredOutput: output, finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'anthropic:claude-haiku-4-5', costUsd: 0,
    }),
    resolveModel: vi.fn().mockResolvedValue({ contextWindow: 200000, capabilities: {} }),
  } as unknown as AIProvider;
}

describe('mapStructuredOutput (structured-output path)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'mso-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const run = (output: unknown) =>
    new AgentExecutor(baseConfig, structuredProvider(output), noopLogger)
      .execute(defWithVocab(), { target: dir });

  it('parses when every optional field is ABSENT', async () => {
    const r = await run({ decision: 'PASS', score: 85, maxScore: 100 });
    expect(r.decision).toBe('PASS');
    expect(r.score).toBe(85);
  });

  it('parses when optional fields are explicit NULL — the strict-off regression guard', async () => {
    // A model taught by the OLD all-nullable schema still sends nulls. Bare .optional()
    // would reject this and throw; optionalNullTolerant coerces null -> absent.
    const r = await run({
      decision: 'PASS', score: 85, maxScore: 100,
      summary: null, categories: null, artifacts: null,
      explorationMaps: null, epistemicAssessment: null, auditImplications: null,
      analysisRecords: null, domainMetrics: null,
    });
    expect(r.decision).toBe('PASS');
    expect(r.score).toBe(85);
  });

  it('PRESERVES null score/maxScore rather than fabricating 0 (score-nullability spec)', async () => {
    const r = await run({ decision: 'COMPLETE', score: null, maxScore: null });
    expect(r.score).toBeNull();
    expect(r.maxScore).toBeNull();
    expect(r.score).not.toBe(0);
  });

  it('reports confidence 1.0 and method structured_output', async () => {
    const r = await run({ decision: 'PASS', score: 85, maxScore: 100 });
    expect(r.extractionConfidence).toBe(1.0);
    expect(r.extractionMethod).toBe('structured_output');
  });

  it('applies ?? defaults to nested issue optionals', async () => {
    const r = await run({
      decision: 'FAIL', score: 10, maxScore: 100,
      categories: [{
        name: 'C', score: 1, maxScore: 10,
        findings: [{ criterion: 'x', pointsEarned: null, pointsPossible: null,
          issues: [{ title: 'bare issue' }] }],
      }],
    });
    const issue = r.categories?.[0]?.findings?.[0]?.issues?.[0];
    expect(issue?.severity).toBe('medium');
    expect(issue?.priority).toBe('suggested');
  });

  // Negative control: the parser must still REJECT genuinely malformed output,
  // or "it accepts null" would be indistinguishable from "it accepts anything".
  it('throws ExecutionError on schema-invalid output', async () => {
    await expect(run({ decision: 123, score: 'not a number' })).rejects.toBeInstanceOf(ExecutionError);
  });
});
