/**
 * Run conditions on every AgentExecutor path (thinking-capability-restore spec v0.7.0 §3 items 1-4,
 * §7.3; T15 executor half, T8 per-run layer).
 *
 * AgentExecutor had no catch before 0.51.0. It now has one, around the whole run, and it is the only
 * place holding both halves of the record: the decision (per-run > config > env > off) and what the
 * provider's gate did (AIProvider's carrier on the result or the thrown error). It attaches the full
 * record to the SAME error object and rethrows it unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { MaxStepsExhaustedError, hasBilledMetrics } from '../../src/errors/index.js';
import { attachThinking, thinkingOutcomeOf } from '../../src/ai/thinking.js';
import { crashPlaceholder, abortedPlaceholder } from '../../src/utils/crashPlaceholder.js';
import type { AIProvider } from '../../src/ai/AIProvider.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { ResolvedDefinition, AgentRuntime } from '../../src/types/registry.js';
import type { Logger } from '@uluops/sdk-core';

const baseConfig: ResolvedConfig = {
  apiKey: 'k',
  ai: { providers: { openrouter: { apiKey: 'r' } }, defaultProvider: 'openrouter' },
  registryUrl: 'https://registry.example.com',
  submissionUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: false,
  timeout: 30_000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
  maxConcurrency: 8,
  allowStageSteps: false,
};

const def = {
  type: 'agent', name: 'test-validator', version: '1.0.0', hash: 'sha256:abc', yaml: '', definition: {},
  runtime: {
    prompt: 'You are a test validator.',
    defaults: { model: 'or', timeout: 30_000 },
    config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' },
  } as AgentRuntime,
  domain: 'software', agentType: 'validator',
} as ResolvedDefinition;

const routedClaude = {
  provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', providerModelId: 'anthropic/claude-sonnet-4.5',
  tier: 'reasoning', capabilities: { tools: true, reasoning: true, extendedThinking: true },
  contextWindow: 1_000_000, maxOutputTokens: 64_000, registered: true, resolvedFrom: 'or',
};

const passing = {
  text: JSON.stringify({ decision: 'PASS', score: 90, maxScore: 100, categories: [] }),
  usage: { input_tokens: 10, output_tokens: 900, reasoning_tokens: 812 },
  toolCallCount: 0, model: 'openrouter:anthropic/claude-sonnet-4.5', provider: 'openrouter', steps: 3, finishReason: 'stop',
  thinking: { applied: true, budget: 10_000, interleaved: true },
};

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function ai(generate: () => Promise<unknown>, resolveModel: () => Promise<unknown> = async () => routedClaude): AIProvider {
  return {
    generate: vi.fn(generate),
    resolveModel: vi.fn(resolveModel),
    createProviderShellTool: vi.fn().mockReturnValue(undefined),
  } as unknown as AIProvider;
}

const sentThinking = (p: AIProvider) =>
  ((p.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { extendedThinking?: boolean }).extendedThinking;

describe('AgentExecutor — run conditions and the thinking decision', () => {
  let target: string;
  beforeEach(async () => {
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'thinking-rc-'));
    await fs.writeFile(path.join(target, 'index.ts'), 'export const x = 1;\n');
  });
  afterEach(async () => { await fs.rm(target, { recursive: true, force: true }); });

  it('success: the record joins the decision and the provider outcome; the notice says on', async () => {
    const log = logger();
    const p = ai(async () => passing);
    const cfg = { ...baseConfig, ai: { ...baseConfig.ai, extendedThinkingMode: 'on' as const, extendedThinkingSource: 'config' as const } };
    const result = await new AgentExecutor(cfg, p, log).execute(def, { target });
    expect(sentThinking(p)).toBe(true);
    expect(result.runConditions).toEqual({
      extendedThinking: true, extendedThinkingMode: 'on', extendedThinkingSource: 'config',
      thinkingApplied: true, thinkingBudget: 10_000, thinkingInterleaved: true, thinkingObserved: 'yes',
    });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Extended thinking on (set by ai.extendedThinking'));
  });

  it('nothing set: off, not requested, no notice', async () => {
    const log = logger();
    const p = ai(async () => ({ ...passing, usage: { input_tokens: 1, output_tokens: 1 }, thinking: { applied: false, notAppliedReason: 'not-requested' } }));
    const result = await new AgentExecutor(baseConfig, p, log).execute(def, { target });
    expect(sentThinking(p)).toBe(false);
    expect(result.runConditions).toMatchObject({
      extendedThinking: false, extendedThinkingSource: 'default', thinkingApplied: false,
      thinkingNotAppliedReason: 'not-requested', thinkingObserved: 'unknown',
    });
    expect(JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls)).not.toContain('Extended thinking');
  });

  it('T8 per-run: true wins over config off; the string "false" is OFF with a warning, not truthy', async () => {
    const p1 = ai(async () => passing);
    const r1 = await new AgentExecutor(baseConfig, p1, logger()).execute(def, { target }, { extendedThinking: true });
    expect(sentThinking(p1)).toBe(true);
    expect(r1.runConditions?.extendedThinkingSource).toBe('request');

    const log = logger();
    const p2 = ai(async () => passing);
    const cfgOn = { ...baseConfig, ai: { ...baseConfig.ai, extendedThinkingMode: 'on' as const, extendedThinkingSource: 'env' as const } };
    await new AgentExecutor(cfgOn, p2, log).execute(def, { target }, { extendedThinking: 'false' as never });
    expect(sentThinking(p2)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Extended thinking is OFF for this run'));
  });

  it('requested but not applied warns, naming the reason', async () => {
    const log = logger();
    const p = ai(async () => ({ ...passing, thinking: { applied: false, notAppliedReason: 'no-mapping' } }));
    const result = await new AgentExecutor(baseConfig, p, log).execute(def, { target }, { extendedThinking: true });
    expect(result.runConditions).toMatchObject({ thinkingApplied: false, thinkingNotAppliedReason: 'no-mapping' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('requested (by this run\'s extendedThinking option) but not applied: no-mapping'));
  });

  it('OD-27: env-sourced "thinking on" warns once per executor, then debug; not-applied warnings stay per run', async () => {
    const log = logger();
    const cfg = { ...baseConfig, ai: { ...baseConfig.ai, extendedThinkingMode: 'on' as const, extendedThinkingSource: 'env' as const } };
    const exec = new AgentExecutor(cfg, ai(async () => passing), log);
    await exec.execute(def, { target });
    await exec.execute(def, { target });
    const onWarns = log.warn.mock.calls.filter(([m]) => String(m).includes('Extended thinking on'));
    expect(onWarns).toHaveLength(1);
    expect(log.debug.mock.calls.filter(([m]) => String(m).includes('Extended thinking on'))).toHaveLength(1);

    const notApplied = new AgentExecutor(cfg, ai(async () => ({ ...passing, thinking: { applied: false, notAppliedReason: 'no-mapping' } })), log);
    await notApplied.execute(def, { target });
    await notApplied.execute(def, { target });
    expect(log.warn.mock.calls.filter(([m]) => String(m).includes('not applied: no-mapping'))).toHaveLength(2);
  });

  it('native thinking options in effect without a request warn once per executor (visible at the default level)', async () => {
    const log = logger();
    const exec = new AgentExecutor(baseConfig, ai(async () => ({ ...passing, thinking: { applied: true, native: true } })), log);
    await exec.execute(def, { target });
    await exec.execute(def, { target });
    expect(log.warn.mock.calls.filter(([m]) => String(m).includes("provider-native options"))).toHaveLength(1);
    expect(log.debug.mock.calls.filter(([m]) => String(m).includes("provider-native options"))).toHaveLength(1);
  });

  it("T12: requested but 'invalid-budget' warns end-to-end, naming the reason", async () => {
    const log = logger();
    const p = ai(async () => ({ ...passing, thinking: { applied: false, notAppliedReason: 'invalid-budget' } }));
    const result = await new AgentExecutor(baseConfig, p, log).execute(def, { target }, { extendedThinking: true });
    expect(result.runConditions).toMatchObject({ thinkingApplied: false, thinkingNotAppliedReason: 'invalid-budget' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('but not applied: invalid-budget'));
  });

  it('thrown provider error: rethrown as the SAME object, with the full record attached', async () => {
    const provErr = new Error('No endpoints found');
    attachThinking(provErr, { applied: true, budget: 10_000, interleaved: true });
    const p = ai(async () => { throw provErr; });
    const caught = await new AgentExecutor(baseConfig, p, logger()).execute(def, { target }, { extendedThinking: true }).catch((e: unknown) => e);
    expect(caught).toBe(provErr);
    expect(thinkingOutcomeOf(caught)?.runConditions).toMatchObject({
      extendedThinking: true, thinkingApplied: true, thinkingBudget: 10_000, thinkingObserved: 'unknown',
    });
    // The crash placeholder an executor builds from it carries the record (NC: 0.50.0 had no field).
    expect(crashPlaceholder('test-validator', caught).runConditions?.thinkingApplied).toBe(true);
    expect(abortedPlaceholder('test-validator', caught).runConditions?.thinkingApplied).toBe(true);
  });

  it('a throw before any builder ran is pre-build-failure when thinking was requested', async () => {
    const early = new Error('registry down');
    const p = ai(async () => passing, async () => { throw early; });
    const caught = await new AgentExecutor(baseConfig, p, logger()).execute(def, { target }, { extendedThinking: true }).catch((e: unknown) => e);
    expect(caught).toBe(early);
    expect(thinkingOutcomeOf(caught)?.runConditions).toMatchObject({ thinkingApplied: false, thinkingNotAppliedReason: 'pre-build-failure' });
  });

  it('a frozen error passes through unchanged — the attach never throws or replaces it', async () => {
    const frozen = Object.freeze(new Error('frozen'));
    const p = ai(async () => { throw frozen; });
    const caught = await new AgentExecutor(baseConfig, p, logger()).execute(def, { target }, { extendedThinking: true }).catch((e: unknown) => e);
    expect(caught).toBe(frozen);
    expect(thinkingOutcomeOf(caught)).toBeUndefined();
  });

  it('MaxStepsExhaustedError carries BOTH billed metrics and the run conditions', async () => {
    const p = ai(async () => ({ ...passing, text: '', finishReason: 'tool-calls' }));
    const caught = await new AgentExecutor(baseConfig, p, logger()).execute(def, { target }, { extendedThinking: true }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(MaxStepsExhaustedError);
    expect(hasBilledMetrics(caught)).toBe(true);
    expect(thinkingOutcomeOf(caught)?.runConditions).toMatchObject({ thinkingApplied: true, thinkingObserved: 'yes' });
  });
});

describe("T10 (0.51.0 form): the agent's own preference is not read; 'declared' is not a mode yet", () => {
  let target: string;
  beforeEach(async () => {
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'thinking-t10-'));
    await fs.writeFile(path.join(target, 'index.ts'), 'export const x = 1;\n');
  });
  afterEach(async () => { await fs.rm(target, { recursive: true, force: true }); });

  it('defaults.extended_thinking: true in the definition changes nothing under on or off (OD-18)', async () => {
    const declaring = {
      ...def,
      yaml: 'agent:\n  defaults:\n    extended_thinking: true\n',
      runtime: { ...(def.runtime as AgentRuntime), defaults: { model: 'or', timeout: 30_000, extended_thinking: true } as never },
    } as ResolvedDefinition;
    for (const [mode, expected] of [['off', false], ['on', true]] as const) {
      const p = ai(async () => passing);
      const cfg = { ...baseConfig, ai: { ...baseConfig.ai, extendedThinkingMode: mode, extendedThinkingSource: 'config' as const } };
      await new AgentExecutor(cfg, p, logger()).execute(declaring, { target });
      expect(sentThinking(p)).toBe(expected);
    }
  });

  it("'declared' is malformed in 0.51.0: off, with the layer reported for a warning", async () => {
    const { resolveAIConfig } = await import('../../src/client/UluOpsClient.js');
    const r = resolveAIConfig({ providers: {}, extendedThinking: 'declared' as never }, {});
    expect(r.extendedThinkingMode).toBe('off');
    expect(r.extendedThinkingMalformed).toEqual({ layer: 'config', value: 'declared' });
  });
});
