/**
 * Extended thinking: capability, opt-in, per-provider gate, thrown-path carrier, run conditions
 * (thinking-capability-restore spec v0.7.0 §3, §5.2, §6, §7.3; tests T6-Anthropic, T7, T8, T9, T12,
 * T15 (provider half), T16).
 *
 * Capability fixtures go through the REAL registry-sdk 0.61.0 `modelSchema` and the exported
 * `normalizeCapabilities`, from a payload captured from the live registry (test/fixtures/wire,
 * 2026-10-08). A hand-built `{ extendedThinking: true }` is the self-consistent fixture that let the
 * capability defect pass review: it passes whether or not the SDK strips the wire name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { APICallError } from 'ai';
import { modelSchema } from '@uluops/registry-sdk/types';
import { normalizeCapabilities } from '@uluops/registry-sdk';
import { AIProvider } from '../../src/ai/AIProvider.js';
import { resolveAIConfig } from '../../src/client/UluOpsClient.js';
import {
  canThink, planThinking, perRunThinking, resolveThinkingMode, attachThinking, thinkingOutcomeOf,
  buildRunConditions, thinkingNotice, reasonsByDefault, hasNativeThinking, MIN_THINKING_BUDGET,
  type ThinkingGateInput,
} from '../../src/ai/thinking.js';
import { ProviderCreditError, CapabilityError } from '../../src/errors/index.js';
import type { ModelCatalog, ResolvedModel } from '../../src/ai/ModelCatalog.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Logger } from '@uluops/sdk-core';

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
  tool: vi.fn((t: unknown) => t),
  Output: { object: vi.fn((schema: unknown) => ({ type: 'output-object', schema })) },
}));
const { fakeFactory } = vi.hoisted(() => ({
  fakeFactory: (kind: string) => vi.fn(() => {
    const p = vi.fn((modelId: string) => ({ modelId, type: kind })) as unknown as Record<string, unknown>;
    p['tools'] = {};
    return p;
  }),
}));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: fakeFactory('anthropic') }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: fakeFactory('openai') }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: fakeFactory('google') }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: fakeFactory('openrouter') }));

const { generateText } = await import('ai');
const mockGenerateText = vi.mocked(generateText);

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const config: ResolvedConfig = {
  apiKey: 'k',
  ai: {
    providers: {
      anthropic: { apiKey: 'a' }, openai: { apiKey: 'o' }, google: { apiKey: 'g' }, openrouter: { apiKey: 'r' },
    },
    defaultProvider: 'anthropic',
  },
  registryUrl: 'https://registry.example.com',
  submissionUrl: 'https://ops.example.com/api',
  dashboardUrl: 'https://app.example.com',
  trackingEnabled: false,
  timeout: 300_000,
  debug: false,
  defaultThinkingBudget: 10_000,
  contextBudget: 200_000,
  maxConcurrency: 8,
  allowStageSteps: false,
};

/** A model as ModelCatalog builds it from a live payload, through the real schema + normalizer. */
function fromWire(file: string, provider: string, overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/wire/${file}`, import.meta.url), 'utf8')) as { data: unknown };
  const m = modelSchema.parse(raw.data);
  return {
    provider,
    modelId: m.modelId,
    providerModelId: m.providerModelId ?? m.modelId,
    tier: m.tier,
    capabilities: normalizeCapabilities(m.capabilities),
    registered: true,
    resolvedFrom: m.modelId,
    contextWindow: m.limits?.context,
    maxOutputTokens: m.limits?.output,
    ...overrides,
  } as ResolvedModel;
}
const claude = (o: Partial<ResolvedModel> = {}) => fromWire('models-get.json', 'anthropic', o);
const routedClaude = (o: Partial<ResolvedModel> = {}) => fromWire('models-get-openrouter.json', 'openrouter', o);

function providerFor(resolved: ResolvedModel, cfg: ResolvedConfig = config): AIProvider {
  vi.spyOn(AIProvider, 'readInstalledVersion').mockReturnValue('2.10.0');
  const catalog = { resolve: vi.fn().mockResolvedValue(resolved) } as unknown as ModelCatalog;
  return new AIProvider(cfg, catalog, noopLogger);
}

function ok() {
  mockGenerateText.mockResolvedValueOnce({
    text: 'done', usage: { inputTokens: 10, outputTokens: 5 }, steps: [], finishReason: 'stop', providerMetadata: {},
  } as never);
}
const lastCall = () => mockGenerateText.mock.calls.at(-1)![0] as Record<string, any>;

beforeEach(() => { vi.clearAllMocks(); });

describe('wire fixtures (control)', () => {
  it('the live payload carries reasoning, and the real schema + normalizer surface it under both names', () => {
    const m = claude();
    expect(m.capabilities).toMatchObject({ reasoning: true, extendedThinking: true });
    expect(canThink(m)).toBe(true);
    expect(routedClaude().capabilities).toMatchObject({ reasoning: true, structuredOutputWithTools: false });
  });
});

describe('planThinking — the per-provider gate', () => {
  const base: ThinkingGateInput = {
    requested: true, provider: 'google', providerModelId: 'gemini-2.5-flash', capable: true,
    callerNative: false, budget: 10_000, maxTokens: 16_384,
  };

  it('reasons, first that applies wins: not-requested → not-capable → no-mapping → invalid-budget', () => {
    expect(planThinking({ ...base, requested: false, capable: false, provider: 'mistral' })).toEqual({ applied: false, reason: 'not-requested' });
    expect(planThinking({ ...base, capable: false, provider: 'mistral' })).toEqual({ applied: false, reason: 'not-capable' });
    expect(planThinking({ ...base, provider: 'mistral', budget: Number.NaN })).toEqual({ applied: false, reason: 'no-mapping' });
    // Direct Anthropic is unmapped in 0.51.0 (OD-13).
    expect(planThinking({ ...base, provider: 'anthropic' })).toEqual({ applied: false, reason: 'no-mapping' });
    for (const bad of [Number.NaN, 0, -1, '8000', undefined]) {
      expect(planThinking({ ...base, budget: bad })).toEqual({ applied: false, reason: 'invalid-budget' });
    }
  });

  it("a caller's provider-native block is applied as native, requested or not (T9)", () => {
    expect(planThinking({ ...base, requested: false, callerNative: true })).toEqual({ applied: true, native: true });
    expect(planThinking({ ...base, provider: 'anthropic', callerNative: true })).toEqual({ applied: true, native: true });
  });

  it("a native block that turns thinking OFF is recorded as not applied, reason 'caller-native' (review P2/F4)", () => {
    expect(planThinking({ ...base, callerNative: true, callerNativeOff: true }))
      .toEqual({ applied: false, reason: 'caller-native', native: true });
  });

  it('OpenAI takes an effort, not a budget', () => {
    expect(planThinking({ ...base, provider: 'openai', budget: Number.NaN })).toEqual({ applied: true, native: false, kind: 'effort' });
  });

  it('Google: budget capped at half of maxTokens; below the 1024 floor sends nothing, never a capped 0 (T16)', () => {
    // 8192 = floor(16384 / 2): the default budget 10000 exceeds half the default maxTokens.
    expect(planThinking(base)).toEqual({ applied: true, native: false, kind: 'budget', budget: 8192, capped: true });
    expect(planThinking({ ...base, budget: 5000 })).toEqual({ applied: true, native: false, kind: 'budget', budget: 5000 });
    expect(planThinking({ ...base, maxTokens: 2000 })).toEqual({ applied: false, reason: 'invalid-budget' });
    expect(planThinking({ ...base, budget: 5000.9 })).toMatchObject({ budget: 5000 });
  });

  it('the 1024 floor is inclusive at exactly 1024, on both floors (boundary — test-architect mutation <→<=)', () => {
    // Google: maxTokens 2048 → cap 1024 → accepted; 2046 → cap 1023 → refused.
    expect(planThinking({ ...base, maxTokens: 2048 })).toMatchObject({ applied: true, budget: 1024 });
    expect(planThinking({ ...base, maxTokens: 2046 })).toEqual({ applied: false, reason: 'invalid-budget' });
    // OpenRouter non-anthropic (OD-25 half floor): 2048 − ceil(2048/2) = 1024 accepted; 2047 − 1024 = 1023 refused.
    const or = { ...base, provider: 'openrouter', providerModelId: 'deepseek/deepseek-r1', budget: 5000 };
    expect(planThinking({ ...or, maxTokens: 2048 })).toMatchObject({ applied: true, budget: 1024 });
    expect(planThinking({ ...or, maxTokens: 2047 })).toEqual({ applied: false, reason: 'invalid-budget' });
  });

  it('OpenRouter anthropic/: max_tokens raised by the budget, capped at the model limit, beta sent (T16, probes P4/P6F)', () => {
    const or = { ...base, provider: 'openrouter', providerModelId: 'anthropic/claude-sonnet-4.5' };
    expect(planThinking({ ...or, maxOutputTokens: 64_000 }))
      .toEqual({ applied: true, native: false, kind: 'budget', budget: 10_000, maxOutputTokens: 26_384, interleaved: true });
    expect(planThinking({ ...or, maxOutputTokens: 20_000 })).toMatchObject({ budget: 10_000, maxOutputTokens: 20_000 });
    // Unknown limit: raised uncapped.
    expect(planThinking(or)).toMatchObject({ maxOutputTokens: 26_384 });
    // The model limit caps the raise: the BUDGET shrinks, not the answer — 12000 − 8192 = 3808 (OD-25, P9).
    expect(planThinking({ ...or, maxOutputTokens: 12_000 }))
      .toMatchObject({ budget: 3808, maxOutputTokens: 12_000, capped: true });
  });

  it('OpenRouter other upstreams: max_tokens untouched, the answer keeps half (OD-25), no beta', () => {
    // NC (review: code-auditor, P7, F1): the old rule kept only budget < max_tokens — 20000 → 16383,
    // one visible token. Now budget ≤ 16384 − 8192 = 8192.
    const or = { ...base, provider: 'openrouter', providerModelId: 'deepseek/deepseek-r1' };
    expect(planThinking(or)).toEqual({ applied: true, native: false, kind: 'budget', budget: 8192, capped: true });
    expect(planThinking({ ...or, budget: 20_000 })).toMatchObject({ budget: 8192 });
    expect(planThinking({ ...or, budget: 4000 })).toEqual({ applied: true, native: false, kind: 'budget', budget: 4000 });
    // Probe P4's case: budget 1024 over max_tokens 800 — OpenRouter would silently raise the cap and bill past it.
    expect(planThinking({ ...or, budget: 1024, maxTokens: 800 })).toEqual({ applied: false, reason: 'invalid-budget' });
    expect(MIN_THINKING_BUDGET).toBe(1024);
  });
});

describe('nativeThinkingDisabled — the explicit-off shapes', () => {
  it('reads each provider\'s documented off shape; anything else present is on', async () => {
    const { nativeThinkingDisabled } = await import('../../src/ai/thinking.js');
    expect(nativeThinkingDisabled('anthropic', { anthropic: { thinking: { type: 'disabled' } } })).toBe(true);
    expect(nativeThinkingDisabled('anthropic', { anthropic: { thinking: { type: 'enabled', budgetTokens: 2000 } } })).toBe(false);
    expect(nativeThinkingDisabled('openai', { openai: { reasoningEffort: 'none' } })).toBe(true);
    expect(nativeThinkingDisabled('openai', { openai: { reasoningEffort: 'minimal' } })).toBe(false);
    expect(nativeThinkingDisabled('google', { google: { thinkingConfig: { thinkingBudget: 0 } } })).toBe(true);
    expect(nativeThinkingDisabled('openrouter', { openrouter: { reasoning: { enabled: false } } })).toBe(true);
    expect(nativeThinkingDisabled('openrouter', { openrouter: { reasoning: { effort: 'none' } } })).toBe(true);
    expect(nativeThinkingDisabled('openrouter', { openrouter: { reasoning: { effort: 'low' } } })).toBe(false);
    expect(nativeThinkingDisabled('openai', undefined)).toBe(false);
  });

  it('through generate(): a disabled native block records caller-native, native, not applied', async () => {
    const provider = providerFor(routedClaude());
    ok();
    const r = await provider.generate({
      model: 'or', system: 's', prompt: 'p', extendedThinking: true,
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    });
    expect(r.thinking).toEqual({ applied: false, notAppliedReason: 'caller-native', native: true });
    expect(buildRunConditions({ requested: true, mode: 'off', source: 'request' }, r.thinking, 0, false))
      .toMatchObject({ thinkingApplied: false, thinkingNotAppliedReason: 'caller-native', extendedThinkingSource: 'native' });
  });
});

describe('hasNativeThinking', () => {
  it('reads the key each builder honours; reasoning: null on OpenRouter is unset', () => {
    expect(hasNativeThinking('anthropic', { anthropic: { thinking: { type: 'disabled' } } })).toBe(true);
    expect(hasNativeThinking('openai', { openai: { reasoningEffort: 'low' } })).toBe(true);
    expect(hasNativeThinking('google', { google: { thinkingConfig: {} } })).toBe(true);
    expect(hasNativeThinking('openrouter', { openrouter: { reasoning: { effort: 'low' } } })).toBe(true);
    expect(hasNativeThinking('openrouter', { openrouter: { reasoning: null } })).toBe(false);
    expect(hasNativeThinking('openai', { anthropic: { thinking: {} } })).toBe(false);
    expect(hasNativeThinking('openai', 'nonsense')).toBe(false);
  });
});

describe('T8: switch precedence and fail-safe', () => {
  const mode = (cfg: unknown, env: unknown) => {
    const r = resolveAIConfig(cfg === undefined ? undefined : { providers: {}, extendedThinking: cfg as 'on' },
      env === undefined ? {} : { ULUOPS_EXTENDED_THINKING: env as string });
    return [r.extendedThinkingMode, r.extendedThinkingSource, r.extendedThinkingMalformed?.layer] as const;
  };

  it('defaults off; config wins over env; case and space ignored', () => {
    expect(mode(undefined, undefined)).toEqual(['off', 'default', undefined]);
    expect(mode('on', undefined)).toEqual(['on', 'config', undefined]);
    expect(mode(undefined, ' ON ')).toEqual(['on', 'env', undefined]);
    expect(mode('off', 'on')).toEqual(['off', 'config', undefined]);
    expect(mode('', 'on')).toEqual(['on', 'env', undefined]);
  });

  it('a malformed value is off AT THAT LAYER and does not fall through — booleans included', () => {
    for (const bad of ['garbage', 'true', '1', 'yes']) expect(mode(undefined, bad)).toEqual(['off', 'env', 'env']);
    expect(mode(true, 'on')).toEqual(['off', 'config', 'config']);
    expect(mode('garbage', 'on')).toEqual(['off', 'config', 'config']);
  });

  it('per-run: a boolean wins; the string "false" is OFF and flagged, not truthy', () => {
    expect(perRunThinking(undefined)).toEqual({ set: false });
    expect(perRunThinking(true)).toEqual({ set: true, value: true, malformed: false });
    expect(perRunThinking('false')).toEqual({ set: true, value: false, malformed: true });
    expect(perRunThinking('true')).toEqual({ set: true, value: false, malformed: true });
    expect(resolveThinkingMode(undefined, undefined)).toEqual({ mode: 'off', source: 'default' });
  });
});

describe('thrown-path carrier', () => {
  it('round-trips, non-enumerable, invisible to JSON and to Object.keys', () => {
    const err = new Error('boom');
    attachThinking(err, { applied: true, budget: 10_000 });
    expect(thinkingOutcomeOf(err)).toEqual({ applied: true, budget: 10_000 });
    expect(Object.keys(err)).not.toContain('thinking');
    expect(JSON.stringify(err)).not.toContain('thinking');
  });

  it('uses a STRING key, so a second copy of core in one tree reads it (control for a Symbol switch)', () => {
    const err = new Error('boom');
    attachThinking(err, { applied: false, notAppliedReason: 'no-mapping' });
    expect(Object.getOwnPropertyNames(err)).toContain('thinking');
  });

  it('never throws and never replaces the error: frozen, primitive, non-configurable', () => {
    const frozen = Object.freeze(new Error('frozen'));
    expect(() => attachThinking(frozen, { applied: true })).not.toThrow();
    expect(thinkingOutcomeOf(frozen)).toBeUndefined();
    expect(() => attachThinking('a string', { applied: true })).not.toThrow();
    expect(() => attachThinking(undefined, { applied: true })).not.toThrow();
    const locked = new Error('locked');
    Object.defineProperty(locked, 'thinking', { value: 1, configurable: false });
    expect(() => attachThinking(locked, { applied: true })).not.toThrow();
    expect(thinkingOutcomeOf(locked)).toBeUndefined();
  });

  it('never overwrites a foreign `thinking` property, but does replace its own carrier', () => {
    const foreign = Object.assign(new Error('x'), { thinking: 'theirs' });
    attachThinking(foreign, { applied: true });
    expect((foreign as unknown as { thinking: unknown }).thinking).toBe('theirs');
    const ours = new Error('y');
    attachThinking(ours, { applied: false, notAppliedReason: 'no-mapping' });
    attachThinking(ours, { applied: true, budget: 2000 });
    expect(thinkingOutcomeOf(ours)).toEqual({ applied: true, budget: 2000 });
  });

  it('validates shape, not presence: a foreign `thinking` property reads as undefined', () => {
    const foreign = Object.assign(new Error('x'), { thinking: { applied: true } });
    expect(thinkingOutcomeOf(foreign)).toBeUndefined();
    const err = new Error('y');
    attachThinking(err, { applied: false, notAppliedReason: 'bogus' as never });
    expect(thinkingOutcomeOf(err)).toBeUndefined();
  });
});

describe('run conditions and the notice', () => {
  const decision = { requested: true, mode: 'on' as const, source: 'env' as const };

  it('requested, not applied: reason recorded, offMeans when the model reasons by default', () => {
    const rc = buildRunConditions(decision, { applied: false, notAppliedReason: 'no-mapping' }, 0, true);
    expect(rc).toMatchObject({
      extendedThinking: true, thinkingApplied: false, thinkingNotAppliedReason: 'no-mapping',
      offMeans: 'provider-default', thinkingObserved: 'no', extendedThinkingSource: 'env',
    });
    expect(thinkingNotice(rc)).toEqual({ level: 'warn', text: expect.stringContaining('not applied: no-mapping') });
  });

  it('no outcome (the run threw before a builder ran) is pre-build-failure when requested', () => {
    expect(buildRunConditions(decision, undefined, undefined, false))
      .toMatchObject({ thinkingApplied: false, thinkingNotAppliedReason: 'pre-build-failure', thinkingObserved: 'unknown' });
    expect(buildRunConditions({ ...decision, requested: false }, undefined, undefined, false))
      .toMatchObject({ thinkingNotAppliedReason: 'not-requested' });
  });

  it('applied: budget, interleave and observation recorded; env source warns, config informs; native is its own source', () => {
    const rc = buildRunConditions(decision, { applied: true, budget: 10_000, interleaved: true }, 812, true);
    expect(rc).toMatchObject({ thinkingApplied: true, thinkingBudget: 10_000, thinkingInterleaved: true, thinkingObserved: 'yes' });
    expect(rc).not.toHaveProperty('offMeans');
    expect(rc).not.toHaveProperty('thinkingNotAppliedReason');
    expect(thinkingNotice(rc)?.level).toBe('warn');
    expect(thinkingNotice({ ...rc, extendedThinkingSource: 'config' })?.level).toBe('info');
    expect(buildRunConditions(decision, { applied: true, native: true }, undefined, false).extendedThinkingSource).toBe('native');
  });

  it('no notice when thinking was not requested — unless the caller\'s native options turned it on (review P3)', () => {
    expect(thinkingNotice(buildRunConditions({ ...decision, requested: false }, { applied: false, notAppliedReason: 'not-requested' }, 0, false))).toBeUndefined();
    const native = thinkingNotice(buildRunConditions({ ...decision, requested: false }, { applied: true, native: true }, 50, false));
    expect(native).toEqual({ level: 'info', text: expect.stringContaining('provider-native options; not capped by core') });
  });

  it('reasonsByDefault: OpenAI and always-thinking Claude yes; Sonnet 4.5 direct and via OpenRouter no', () => {
    const m = (provider: string, providerModelId: string, reasoning = true) =>
      ({ provider, providerModelId, tier: 'premium', capabilities: { reasoning } }) as unknown as ResolvedModel;
    expect(reasonsByDefault(m('openai', 'gpt-5'))).toBe(true);
    expect(reasonsByDefault(m('anthropic', 'claude-opus-5-5'))).toBe(true);
    expect(reasonsByDefault(m('anthropic', 'claude-sonnet-4-5-20250929'))).toBe(false);
    expect(reasonsByDefault(m('openrouter', 'anthropic/claude-sonnet-4.5'))).toBe(false);
    expect(reasonsByDefault(m('openrouter', 'openai/gpt-5.5'))).toBe(true);
    expect(reasonsByDefault(m('openai', 'gpt-4o', false))).toBe(false);
  });
});

describe('AIProvider gates, through generate()', () => {
  it('T6-Anthropic: a capable Claude row (real schema) sends NO anthropic.thinking under on or off', async () => {
    // NC: core 0.50.0's capability-keyed block fires on this row once the SDK stops stripping
    // `reasoning` — thinking plus the forced json tool, a 400 on agent runs (probe P1).
    const provider = providerFor(claude());
    ok();
    const on = await provider.generate({ model: 'sonnet', system: 's', prompt: 'p', extendedThinking: true });
    expect(lastCall()['providerOptions']?.anthropic?.thinking).toBeUndefined();
    expect(on.thinking).toEqual({ applied: false, notAppliedReason: 'no-mapping' });
    ok();
    await provider.generate({ model: 'sonnet', system: 's', prompt: 'p' });
    expect(lastCall()['providerOptions']?.anthropic?.thinking).toBeUndefined();
  });

  it('T7: temperature is stripped by capability (real schema) even on a non-reasoning tier', async () => {
    const provider = providerFor(claude({ tier: 'standard' }));
    ok();
    await provider.generate({ model: 'sonnet', system: 's', prompt: 'p', temperature: 0.3 });
    expect(lastCall()).not.toHaveProperty('temperature');
  });

  it('OpenRouter anthropic/ on: reasoning budget, raised max_tokens, interleave header; data_collection still deny', async () => {
    const provider = providerFor(routedClaude());
    ok();
    const r = await provider.generate({ model: 'or', system: 's', prompt: 'p', extendedThinking: true });
    const call = lastCall();
    expect(call['providerOptions'].openrouter.reasoning).toEqual({ max_tokens: 10_000 });
    expect(call['providerOptions'].openrouter.provider.data_collection).toBe('deny');
    // 26384 = maxTokens 16384 + budget 10000, under the model's 64000 output limit.
    expect(call['maxOutputTokens']).toBe(26_384);
    expect(call['headers']).toEqual({ 'x-anthropic-beta': 'interleaved-thinking-2025-05-14' });
    expect(r.thinking).toEqual({ applied: true, budget: 10_000, interleaved: true, maxTokensSent: 26_384 });
    // OD-26: the record says how much room the run had (review P1).
    expect(buildRunConditions({ requested: true, mode: 'off', source: 'request' }, r.thinking, 812, false).maxTokensSent).toBe(26_384);
  });

  it('OpenRouter off: no reasoning, default max_tokens, no header', async () => {
    const provider = providerFor(routedClaude());
    ok();
    await provider.generate({ model: 'or', system: 's', prompt: 'p' });
    const call = lastCall();
    expect(call['providerOptions'].openrouter.reasoning).toBeUndefined();
    expect(call['maxOutputTokens']).toBe(16_384);
    expect(call).not.toHaveProperty('headers');
  });

  it('a malformed agent max_tokens is planned safely but NOT repaired on the wire (same failure as thinking off)', async () => {
    // NC (core 0.51.0 review, code-auditor + anxiety F10): the plan seamed "8000" to the 16384 default and
    // the raise then SENT 26384 — a cap the definition never set, on the one path where thinking was on.
    const provider = providerFor(routedClaude());
    for (const bad of ['8000', 8000.5]) {
      ok();
      const r = await provider.generate({ model: 'or', system: 's', prompt: 'p', extendedThinking: true, maxTokens: bad as never });
      expect(r.thinking?.budget).toBe(10_000);
      expect(lastCall()['maxOutputTokens']).toBe(bad);
    }
  });

  it('client config on (no per-call value): a direct AIProvider caller gets the same rule', async () => {
    const provider = providerFor(routedClaude(), { ...config, ai: { ...config.ai, extendedThinkingMode: 'on' } });
    ok();
    const r = await provider.generate({ model: 'or', system: 's', prompt: 'p' });
    expect(r.thinking?.applied).toBe(true);
  });

  it('T15 (provider half): a thrown 402 carries the outcome and names the max_tokens sent', async () => {
    const provider = providerFor(routedClaude());
    mockGenerateText.mockRejectedValueOnce(new APICallError({
      message: 'This request requires more credits, or fewer max_tokens. You requested up to 26384 tokens, but can only afford 900.',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: { max_tokens: 26_384, reasoning: { max_tokens: 10_000 } },
      statusCode: 402,
    }));
    const err = await provider.generate({ model: 'or', system: 's', prompt: 'p', extendedThinking: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCreditError);
    expect((err as Error).message).toContain('max_tokens sent: 26384, which includes the extended-thinking budget');
    expect(thinkingOutcomeOf(err)).toEqual({ applied: true, budget: 10_000, interleaved: true, maxTokensSent: 26_384 });
  });

  it('T15 (provider half): a thrown no-endpoint carries the outcome and names reasoning and the lever', async () => {
    const provider = providerFor(routedClaude());
    mockGenerateText.mockRejectedValueOnce(new APICallError({
      message: 'No endpoints found',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: { max_tokens: 26_384, reasoning: { max_tokens: 10_000 }, provider: { require_parameters: true } },
      statusCode: 404,
      data: { error: { message: 'No endpoints found', code: 404, metadata: { failed_routing_step: 'Filter by Parameters' } } },
    }));
    const err = await provider.generate({ model: 'or', system: 's', prompt: 'p', extendedThinking: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as Error).message).toMatch(/reasoning \(extended thinking is on.*max_tokens 26384.*ULUOPS_EXTENDED_THINKING/);
    expect(thinkingOutcomeOf(err)?.applied).toBe(true);
  });

  it('an error thrown before any builder runs carries nothing (AgentExecutor records pre-build-failure)', async () => {
    const catalog = { resolve: vi.fn().mockRejectedValue(new Error('registry down')) } as unknown as ModelCatalog;
    const err = await new AIProvider(config, catalog, noopLogger)
      .generate({ model: 'x', system: 's', prompt: 'p', extendedThinking: true }).catch((e: unknown) => e);
    expect(thinkingOutcomeOf(err)).toBeUndefined();
  });
});
