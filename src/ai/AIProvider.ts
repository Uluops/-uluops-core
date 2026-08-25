import {
  generateText,
  Output,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  APICallError,
  RetryError,
  stepCountIs,
  type LanguageModel,
  type ToolSet,
  type CallWarning,
} from 'ai';
import type { LanguageModelUsage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';

import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { UsageMetrics } from '../types/ai.js';
import { formatErrorMessage } from '../utils/formatError.js';
import type { ResolvedConfig, ResolvedAIConfig } from '../types/config.js';
import type { ModelCatalog, ResolvedModel } from './ModelCatalog.js';
import { TokenBudgetTracker } from './TokenBudgetTracker.js';
import { Semaphore } from './Semaphore.js';
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, ANTHROPIC_BASH_TOOL_VERSION, ANTHROPIC_CONTEXT_MANAGEMENT_TYPE, ANTHROPIC_CONTEXT_KEEP_TOOL_USES, DEFAULT_DYNAMIC_PROVIDERS, DEFAULT_CONTEXT_BUDGET, DEFAULT_MAX_CONCURRENCY } from '../constants.js';
import { executeShellAsString, executeShellAsOpenAIResult } from './shellExecutor.js';
import {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  TimeoutError,
  CancelledError,
  ConfigurationError,
} from '../errors/index.js';
import type { ModelCapabilities } from '@uluops/registry-sdk';
import type { Logger } from '@uluops/sdk-core';
import { usableBudget, finitePositive } from '../utils/externalValue.js';

/**
 * What `mapUsage` accepts — DERIVED from the AI SDK's own `LanguageModelUsage`
 * rather than hand-copying its field names.
 *
 * That derivation is the point. The defect this whole module was corrected for was
 * core reading a v5-shaped `usage` under v6, and a hand-written structural type gives
 * the compiler nothing to check: if the SDK renames `noCacheTokens` again, a duck type
 * keeps compiling, `usage.inputTokenDetails?.noCacheTokens` silently reads `undefined`,
 * the normalization falls back to the pre-fix subtraction, and the cache-inclusive
 * inflation returns with no signal. Deriving from the real type makes that rename a
 * BUILD failure instead of a silent numeric regression.
 *
 * The two detail objects are widened to optional on purpose: the SDK declares them
 * required, but this method is also called internally with a minimal
 * `{ inputTokens, outputTokens }` on error-fallback paths where no usage was reported.
 * That is a deliberate, narrow widening of a real type — not a re-declaration of it.
 */
type MappableUsage =
  Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'>
  & Partial<Pick<LanguageModelUsage, 'inputTokenDetails' | 'outputTokenDetails'>>;

/**
 * Per-step totals accumulated during the tool loop.
 *
 * Exists because the ERROR paths cannot reach `result.totalUsage`: when the SDK throws
 * NoObjectGeneratedError, the result object never materializes, and the error carries
 * only `lastStep.usage`. Reporting that as the run total understated a real 7-step run
 * by 96% ($0.00987 against $0.2556) and zeroed steps/toolCalls. The SDK computes
 * `totalUsage` by summing per-step usage, so summing the same values here reproduces it
 * on the path where the result is gone.
 */
interface StepTotals {
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /**
   * True only when a step reported an actual token NUMBER.
   *
   * It previously tested `if (step.usage)`, which is a tautology: `usage` is a REQUIRED
   * field on StepResult (ai/dist/index.d.ts `readonly usage: LanguageModelUsage`) and the
   * SDK materializes it via `createNullLanguageModelUsage()` — an object whose every
   * member is `undefined` — whenever a provider response carries no usage block. All
   * three bundled providers do this. So the flag meant "a step finished", and the
   * "nothing reported -> undefined, not a fabricated $0" contract at buildFallbackResult
   * held only in the ZERO-STEP case, which was the only case its test covered. Measured:
   * three steps with the SDK's null-usage shape reported a real `costUsd: 0`, which then
   * passes sumCostUsd's finiteness check and sums cleanly into a pipeline total.
   */
  sawUsage: boolean;
  /**
   * Per-pool presence. ABSENT IS NOT ZERO, and the accumulator's `?? 0` destroys the
   * distinction — so the fact of a report has to be carried separately from its value.
   *
   * This is what made stepTotalsToUsage emit `noCacheTokens: 0` unconditionally, which
   * sent mapUsage down its EXACT normalization branch on a fabricated zero and priced the
   * whole input pool at $0 for any provider reporting `inputTokens` without details — the
   * `ai.additionalProviders` population the legacy branch exists for. Measured: $0.045
   * against a true $0.495 on usage the success path gets right.
   */
  sawNoCache: boolean;
  sawCacheRead: boolean;
  sawCacheWrite: boolean;
  sawReasoning: boolean;
  /**
   * Last step's provider metadata and accumulated warnings, so the error path can build
   * its result through the SAME extraction the success path uses. Without these,
   * buildFallbackResult called mapUsage with one of three arguments: all four provider
   * extract tiers were dead, Google thinking tokens landed in `reasoning_tokens`, an
   * unknown provider's cache pool went unpriced, and both drift instruments this release
   * added (providerWarnings, usageShapeDrift) were absent from every degraded result —
   * dark precisely where drift bites.
   */
  providerMetadata?: Record<string, unknown>;
  warnings: CallWarning[];
}

/**
 * Coerce a provider-reported token count to a finite, non-negative number.
 * Absent, NaN, Infinity and negative values all collapse to 0 — a wrong-but-bounded
 * figure that cannot poison arithmetic downstream, in preference to propagating a
 * value that silently nulls an entire pipeline's cost.
 */
function safeTokenCount(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** As safeTokenCount, but preserves "the provider did not report this" as undefined. */
function optionalTokenCount(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  return safeTokenCount(n);
}

/**
 * Render the SDK's own report of settings it could not honor into flat strings.
 *
 * Narrows on the discriminant rather than casting. `CallWarning` is a union whose
 * 'unsupported' and 'compatibility' members carry `feature`/`details` and NO `message`
 * (verified against @ai-sdk/provider's SharedV3Warning) — casting to `{message?: string}`
 * reads undefined for those and throws away the only two fields that say what the
 * provider actually refused.
 *
 * Shared by the success and fallback paths deliberately. Provider option schemas parse in
 * Zod STRIP mode, so warnings are the only channel that reports a setting not taking
 * effect; a formatter that existed on one path only meant degraded runs reported none.
 */
function formatCallWarnings(warnings: readonly CallWarning[] | undefined): string[] {
  return (warnings ?? []).map((w) =>
    w.type === 'other'
      ? w.message
      : `${w.type}: ${w.feature}${w.details ? ` — ${w.details}` : ''}`,
  );
}

function emptyStepTotals(): StepTotals {
  return {
    // FABRICATION-OK: accumulator SEEDS. Presence is carried by the sawUsage/sawNoCache/sawCacheRead/
    // sawCacheWrite/sawReasoning flags, and stepTotalsToUsage emits undefined for any pool
    // whose flag is false.
    steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
    // FABRICATION-OK: accumulator SEEDS, not reported values. Presence is carried
    // separately by the sawNoCache/sawCacheRead/sawCacheWrite flags, and
    // stepTotalsToUsage emits undefined for any pool whose flag is false.
    noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    // FABRICATION-OK: accumulator seed, gated by sawReasoning (see above).
    reasoningTokens: 0, sawUsage: false,
    sawNoCache: false, sawCacheRead: false, sawCacheWrite: false, sawReasoning: false,
    warnings: [],
  };
}

/**
 * StepTotals -> the shape mapUsage consumes. Only meaningful when sawUsage is true.
 *
 * Every pool is emitted as `undefined` unless a step actually reported it. That is not
 * cosmetic: mapUsage branches on `noCacheTokens !== undefined` to choose between its
 * EXACT normalization (trust the SDK's uncached figure) and its LEGACY one (subtract the
 * cache pools from a cache-inclusive total). Emitting a fabricated 0 forced the exact
 * branch and zeroed the input pool. The all-undefined members mirror the SDK's own
 * `createNullLanguageModelUsage()` shape, so mapUsage sees exactly what it would have
 * seen from a provider that reported nothing.
 */
function stepTotalsToUsage(t: StepTotals): MappableUsage {
  return {
    inputTokens: t.sawUsage ? t.inputTokens : undefined,
    outputTokens: t.sawUsage ? t.outputTokens : undefined,
    inputTokenDetails: {
      noCacheTokens: t.sawNoCache ? t.noCacheTokens : undefined,
      cacheReadTokens: t.sawCacheRead ? t.cacheReadTokens : undefined,
      cacheWriteTokens: t.sawCacheWrite ? t.cacheWriteTokens : undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: t.sawReasoning ? t.reasoningTokens : undefined,
    },
  };
}

/**
 * Result from AI provider generation
 */
export interface AIGenerateResult<TOutput = unknown> {
  /** Final text content after tool loop completion */
  text: string;

  /** Total usage across all steps */
  usage: UsageMetrics;

  /** Number of tool calls made */
  toolCallCount: number;

  /** Resolved provider:modelId that was used */
  model: string;

  /** Provider name (e.g., 'anthropic', 'openai') */
  provider: string;

  /** Number of steps (LLM calls) in the tool loop */
  steps: number;

  /** Finish reason */
  finishReason: string;

  /**
   * Estimated cost in USD, computed here — the only seam where both usage and
   * the ResolvedModel (with registry pricing) are in hand. Undefined when the
   * resolved model carries no cost (unpriced registry row, unregistered
   * model, offline fallback, alias without model) — never 0 for "unknown".
   * A real computed 0 (zero-usage result on a priced model) is meaningful.
   */
  costUsd?: number;

  /**
   * Providers whose usage metadata arrived in an unrecognized shape (issue
   * adaaa4b9). mapUsage reaches into undocumented provider-metadata fields via
   * casts; when a provider-SDK renames them, the casts silently resolve
   * undefined and token/cache/thinking metrics read zero. This field converts
   * that silent-zero into a signal — AgentExecutor emits an info-severity
   * `usage.provider-metadata-shape-drift` degradation marker from it.
   * Absent/empty means no drift detected.
   */
  usageShapeDrift?: string[];

  /** Provider warnings the AI SDK emitted for this call — unsupported settings, clamped
   *  values, silently-dropped parameters. This is the SDK's OWN drift channel and core
   *  used to discard it entirely, which is why a stale request option produced no signal
   *  anywhere: provider option schemas STRIP unknown keys rather than rejecting them, so
   *  a warning is the only evidence a setting did not take effect. Absent when empty. */
  providerWarnings?: string[];

  /** Structured output object, if output schema was provided and model supports it.
   *  When present, this is already validated against the schema — no extraction needed.
   *  Generic type parameter allows callers to preserve Zod schema output types. */
  structuredOutput?: TOutput;
}

/**
 * Options for generation
 */
export interface AIGenerateOptions {
  /** Model alias (e.g., 'sonnet'), tier (e.g., 'premium'), or full provider:modelId */
  model: string;

  /** System prompt */
  system: string;

  /** Initial user message */
  prompt: string;

  /** Available tools (AI SDK ToolSet format) */
  tools?: ToolSet;

  /** Maximum response tokens per step */
  maxTokens?: number;

  /** Maximum tool loop iterations */
  maxSteps?: number;

  /** Timeout in milliseconds */
  timeoutMs?: number;

  /**
   * Caller-supplied cancellation signal. Combined with the `timeoutMs` signal rather than
   * replacing it — whichever fires first wins, and the run can still time out normally
   * while remaining cancellable. An abort attributable to THIS signal raises
   * `CancelledError`; a timeout still raises `TimeoutError`.
   */
  abortSignal?: AbortSignal;

  /** Temperature (0-1) */
  temperature?: number;

  /** Required capabilities (validated before execution) */
  requiredCapabilities?: Array<keyof ModelCapabilities>;

  /** Provider-specific options (thinking, effort, etc.) passed through to generateText */
  providerOptions?: ProviderOptions;

  /** Token budget for context window management. When set, forces wrap-up at 80% usage. */
  contextBudget?: number;

  /** Optional budget tracker for sharing state with tools (e.g., get_token_budget) */
  budgetTracker?: TokenBudgetTracker;

  /** Structured output schema. When provided and the model supports it,
   *  constrains the final response to match this schema exactly. */
  output?: Parameters<typeof Output.object>[0];

  /** Maximum retries for transient LLM errors (429, 5xx). Passed to AI SDK's generateText().
   *  Default: 2 (3 total attempts with exponential backoff). The AI SDK respects Retry-After headers. */
  maxRetries?: number;
}

/**
 * Multi-provider AI SDK wrapper with registry-backed model resolution.
 *
 * Wraps Vercel AI SDK v6 to provide:
 * - Registry-backed model alias resolution (sonnet → anthropic:claude-sonnet-4-5-20250929)
 * - Multi-provider support (Anthropic + OpenAI + Google bundled, others via dynamic import)
 * - Capability pre-flight checks (tools, vision, streaming, extendedThinking)
 * - Unified generation with automatic tool loops
 * - Automatic prompt caching for Anthropic system messages
 * - Extended thinking auto-enabled for capable Anthropic models
 * - Reasoning effort auto-set for capable OpenAI models
 * - Provider-defined tool support (Anthropic bash, OpenAI shell)
 * - Error mapping to UluOps error types
 * - Usage metrics in UluOps format (including OpenAI reasoning + Google thinking tokens)
 */
export class AIProvider {
  /** Factory name overrides for providers that don't follow the `create<Name>` convention */
  private static readonly FACTORY_NAME_OVERRIDES: Record<string, string> = {
    google: 'createGoogleGenerativeAI',
  };

  /**
   * Allowlist of valid provider names for dynamic import.
   * Prevents path traversal via crafted provider strings (CWE-829).
   * Built from defaults + any additional providers from config.
   */
  private validProviders: Set<string>;

  /** Initialized AI SDK provider factories, keyed by provider name */
  private providers = new Map<string, (modelId: string) => LanguageModel>();

  /** Anthropic provider instance for accessing provider-defined tools */
  private anthropicInstance?: AnthropicProvider;

  /** OpenAI provider instance for accessing provider-defined tools */
  private openaiInstance?: OpenAIProvider;

  /**
   * Ceiling on concurrent in-flight generate() calls for THIS AIProvider
   * instance. Shared across every executor (workflow phases, parallel steps,
   * inline pipeline agents) that holds this instance, so no single fan-out
   * can overrun it. See DEFAULT_MAX_CONCURRENCY.
   *
   * This bound is per AIProvider, NOT per process. There is exactly one
   * construction site workspace-wide (`client/UluOpsClient.ts`), so today one
   * `UluOpsClient` means one AIProvider means one effective ceiling — but
   * nothing in this package coordinates across instances. N `UluOpsClient`s
   * constructed in one host process (e.g. one per tenant or per request) admit
   * N × maxConcurrency, not maxConcurrency. A host fanning out over multiple
   * clients must budget accordingly — this is a rate-limit guarantee, and
   * overrunning it gets 429s from the provider.
   */
  private readonly concurrencyLimiter: Semaphore;

  constructor(
    private config: ResolvedConfig,
    private catalog: ModelCatalog,
    private logger: Logger,
  ) {
    // EXTERNAL-OK: finitePositive is applied INSIDE the Semaphore constructor, where it also protects every
    // other caller; guarding here as well would leave two places to keep in step.
    this.concurrencyLimiter = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    // Validate additionalProviders are safe alphanumeric names before adding
    // to the dynamic import allowlist (CWE-829 defense)
    const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
    for (const name of config.ai.additionalProviders ?? []) {
      if (!PROVIDER_NAME_PATTERN.test(name)) {
        throw new ConfigurationError(`Invalid provider name "${name}": must be lowercase alphanumeric with hyphens (e.g. "mistral", "deep-seek")`);
      }
    }
    this.validProviders = new Set([
      ...DEFAULT_DYNAMIC_PROVIDERS,
      ...(config.ai.additionalProviders ?? []),
    ]);
    this.initializeProviders(config.ai);
  }

  /**
   * Generate text with automatic tool loop handling.
   *
   * Resolution flow:
   * 1. Resolve model alias → provider:modelId via ModelCatalog
   * 2. Validate required capabilities (if specified)
   * 3. Get AI SDK LanguageModel from provider factory
   * 4. Build provider options (cache control, thinking, etc.)
   * 5. Call generateText with maxSteps for automatic tool loop
   *
   * Every call is gated through the shared concurrency limiter so wide fan-out
   * plus per-request retries cannot collectively overrun a provider rate limit.
   *
   * @param options - Generation options ({@link AIGenerateOptions}): `model` alias, `system`,
   *   `messages`/`prompt`, `tools`, `requiredCapabilities`, `providerOptions`, `contextBudget`, etc.
   * @returns The {@link AIGenerateResult} — generated text, tool calls, usage metrics, and finish reason.
   * @throws {ConfigurationError} If the requested provider is not configured.
   * @throws {ModelNotFoundError} If the model alias cannot be resolved by the catalog.
   * @throws {CapabilityError} If the resolved model lacks a required capability.
   * @throws {RateLimitError} If the provider returns a 429 after retries are exhausted.
   * @throws {SdkApiError} For other provider/API errors surfaced by the AI SDK.
   */
  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    // Gate every generation through the shared concurrency limiter so that
    // wide fan-out (workflow levels, parallel steps, inline pipeline agents)
    // plus per-request retries cannot collectively overrun a provider rate
    // limit. The limiter bounds total in-flight calls, not per-executor calls.
    return this.concurrencyLimiter.run(() => this.generateInner(options));
  }

  private async generateInner(options: AIGenerateOptions): Promise<AIGenerateResult> {
    // 1. Resolve model and prepare generation config
    const modelInput = this.config.ai.modelOverride ?? options.model;
    const resolved = await this.catalog.resolve(modelInput, {
      requiredCapabilities: options.requiredCapabilities,
    });
    await this.ensureProvider(resolved.provider);

    const factory = this.getProviderFactory(resolved.provider);
    const languageModel = factory(resolved.providerModelId);
    const providerOptions = this.buildProviderOptions(resolved, options.providerOptions, options.contextBudget);
    const system = this.buildSystemMessage(resolved.provider, options.system);
    // ASSUMPTION (2026-04-16): the model catalog's capability flags
    // (structuredOutput, structuredOutputWithTools, toolCalling) accurately
    // reflect current provider behavior. Capability drift is external to this
    // codebase — providers may change what their models support without notice.
    // The catalog is the single point of truth: structuredOutputWithTools=false
    // marks models that reject structured output + tool calling in the same
    // request (e.g. Google/Gemini — 400 "Function calling with a response mime
    // type: 'application/json' is unsupported", verified @ai-sdk/google@3.0.31 +
    // Gemini 2.5 Flash 2026-04-18). The constraint lives in the catalog (set at
    // model sync), not as a provider-name branch here. Absence = allowed.
    const hasTools = !!options.tools && Object.keys(options.tools).length > 0;
    const useStructuredOutput = !!options.output && !!resolved.capabilities.structuredOutput
      && !(hasTools && resolved.capabilities.structuredOutputWithTools === false);

    // Reasoning models (o1, o3, o4-mini, gpt-5.x) don't support temperature —
    // strip it to suppress repeated AI SDK warnings. Check capabilities
    // (extendedThinking or reasoning) and tier ('reasoning') since the registry
    // may signal reasoning capability through any of these fields.
    const isReasoning = resolved.capabilities.extendedThinking
      || ('reasoning' in resolved.capabilities && (resolved.capabilities as Record<string, unknown>)['reasoning'] === true)
      || resolved.tier === 'reasoning';

    this.logPreGeneration(options, resolved, modelInput, useStructuredOutput);

    // 2. Execute LLM with tool loop
    // The try covers ONLY the provider call. It previously spanned buildGenerateResult
    // too, so any throw during result assembly was mistaken for a generation failure and
    // returned as a zero-cost fallback — discarding usage that had genuinely been billed.
    const stepTotals = emptyStepTotals();
    let result;
    try {
      result = await this.executeGeneration(options, languageModel, system, providerOptions, useStructuredOutput, isReasoning, stepTotals);
    } catch (error) {
      return this.handleGenerateError(error, resolved, useStructuredOutput, options.timeoutMs, stepTotals, options.abortSignal);
    }
    // Result ASSEMBLY gets its own try, separate from the provider call above.
    //
    // Narrowing the first try was correct — a throw here is not a generation failure and
    // must not be reported as a zero-cost fallback, discarding usage that was genuinely
    // billed. But leaving assembly bare traded one defect for another: `result.output` is
    // a throwing getter and mapUsage runs here too, so a throw escaped generate() WITHOUT
    // reaching mapError. Callers got a raw AI_NoOutputGeneratedError instead of a core
    // error type, and the billed usage was still lost — as a rejection this time rather
    // than as a fabricated zero. Both properties are needed: map the error, AND keep the
    // usage, which stepTotals still holds.
    try {
      return this.buildGenerateResult(result, resolved, useStructuredOutput);
    } catch (error) {
      // The log states what handleGenerateError will ACTUALLY do, which depends on the
      // run. Only the structured-output branches return a fallback result carrying
      // stepTotals; everything else falls through to mapError and RETHROWS, discarding the
      // accumulated usage. Claiming "reporting the usage that was already billed"
      // unconditionally was a false state written on the very path this try exists to
      // protect — the release's own defect, in a log line.
      const willReportUsage = useStructuredOutput;
      this.logger.warn(
        `Result assembly failed after a successful provider call: ${formatErrorMessage(error)}`
        + (willReportUsage
          ? ' — degrading to text extraction and reporting the usage already billed.'
          : ' — the error is being mapped and rethrown; usage accumulated during this run is NOT reported.'),
      );
      return this.handleGenerateError(error, resolved, useStructuredOutput, options.timeoutMs, stepTotals, options.abortSignal);
    }
  }

  /**
   * Log pre-generation context for debugging.
   */
  private logPreGeneration(
    options: AIGenerateOptions,
    resolved: ResolvedModel,
    modelInput: string,
    useStructuredOutput: boolean,
  ): void {
    this.logger.info(`Model: ${resolved.provider}:${resolved.modelId} (from "${modelInput}")`);
    this.logger.debug(`System prompt: ${options.system.length} chars`);
    this.logger.debug(`User prompt: ${options.prompt.length} chars`);
    if (options.tools) {
      this.logger.debug(`Tools: ${Object.keys(options.tools).join(', ')}`);
    }
    this.logger.debug(`Config: maxTokens=${options.maxTokens ?? DEFAULT_MAX_TOKENS}, maxSteps=${options.maxSteps ?? DEFAULT_MAX_STEPS}, temp=${options.temperature ?? DEFAULT_TEMPERATURE}`);

    if (options.output && !useStructuredOutput) {
      this.logger.info(
        `Model ${resolved.modelId} does not support structured output — falling back to free-form extraction`,
      );
    }
  }

  /**
   * Execute generateText with tool loop and step tracking.
   */
  private async executeGeneration(
    options: AIGenerateOptions,
    languageModel: ReturnType<ReturnType<typeof this.getProviderFactory>>,
    system: ReturnType<typeof this.buildSystemMessage>,
    providerOptions: ReturnType<typeof this.buildProviderOptions>,
    useStructuredOutput: boolean,
    isReasoning = false,
    stepTotals: StepTotals = emptyStepTotals(),
  ) {
    let stepCount = 0;
    const budgetTracker = options.budgetTracker;
    // Does `toolChoice: 'none'` actually reach the provider on this run?
    //
    // It does not when Anthropic runs structured output through `structuredOutputMode:
    // 'jsonTool'` — core's own default for every Anthropic structured-output call — because
    // the provider HARD-OVERRIDES toolChoice to select its json tool. The brake is a no-op
    // there, on the dominant path.
    //
    // Fixing the brake itself means changing structured-output strategy and is a separate
    // decision. What is fixed here is the REPORT: the latch no longer marks a forced
    // wrap-up that never happened, so a complete run stops being stamped `degraded` and
    // downgraded to 'partial' completeness for a non-event. The log line still fires, so
    // the budget crossing remains visible; only the false claim is withdrawn.
    const brakeIsHonored = !(useStructuredOutput && this.isAnthropicJsonToolMode(providerOptions));
    // `usableBudget`, not truthiness. AIGenerateOptions.contextBudget is PUBLIC, so a
    // library consumer is an external input source: `contextBudget: 0` is falsy, which
    // meant no prepareStep, no brake — AND markBrakeInert() never reached, so the run
    // reported `complete` with no marker at all. contextBudget.ts names this exact failure
    // and closes it at deriveContextBudget; it was open again one layer above that.
    const requestedBudget = usableBudget(options.contextBudget);
    const prepareStep = requestedBudget !== undefined
      ? this.buildBudgetPrepareStep(requestedBudget, budgetTracker, brakeIsHonored)
      : undefined;
    if (options.contextBudget !== undefined && requestedBudget === undefined) {
      // Nothing degrades silently (types/degradation.ts invariant 1): a caller who asked
      // for a budget and got none must be told, not left to infer it from behaviour.
      this.logger.warn(
        `contextBudget was supplied but is not a usable positive number (${String(options.contextBudget)}); `
        + 'no wrap-up brake will be installed for this run.',
      );
      budgetTracker?.markBrakeInert();
    }
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

    return generateText({
      model: languageModel,
      system,
      prompt: options.prompt,
      tools: options.tools,
      maxOutputTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stopWhen: stepCountIs(maxSteps + (useStructuredOutput ? 2 : 0)),
      ...(isReasoning ? {} : { temperature: options.temperature ?? DEFAULT_TEMPERATURE }),
      maxRetries: options.maxRetries,
      // EXTERNAL-OK: mergeAbortSignals IS the seam for this pair. Both `options.timeoutMs`
      // and `this.config.timeout` are external, and both are routed through finitePositive
      // inside it, which is why it takes the config value as an argument rather than
      // reading a default it cannot validate. Guarded at the callee, not waived away.
      abortSignal: mergeAbortSignals(options, this.config.timeout),
      ...(providerOptions ? { providerOptions } : {}),
      ...(prepareStep ? { prepareStep } : {}),
      ...(useStructuredOutput ? { output: Output.object(options.output!) } : {}),
      onStepFinish: (step) => {
        stepCount++;
        // EXTERNAL-OK: reads a COUNT or an enum off the SDK result, not a priced quantity. An array length and a
    // finishReason string carry no money and no threshold.
        const toolNames = step.toolCalls?.map(tc => tc.toolName) ?? [];
        const usage = step.usage;
        const textLen = step.text?.length ?? 0;
        this.logger.info(
          `Step ${stepCount}: ${step.finishReason}` +
          (toolNames.length > 0 ? ` | tools: [${toolNames.join(', ')}]` : '') +
          // FABRICATION-OK: log formatting only — this value reaches no metric, no cost,
          // and no consumer. Rendering "0in/0out" in a debug line is not a claim about spend.
          ` | usage: ${usage.inputTokens ?? 0}in/${usage.outputTokens ?? 0}out` +
          (textLen > 0 ? ` | text: ${textLen} chars` : ''),
        );
        // ABSENT IS NOT ZERO here either. This call sits three lines above the
        // StepTotals accumulator that got exactly this fix, and was fed `?? 0` from the
        // same `usage` object — the one the SDK materializes via
        // createNullLanguageModelUsage() with every member undefined when a provider
        // reports nothing. `update()` assigns currentContextTokens UNCONDITIONALLY, so a
        // null-usage step reset the tracked window to 0: `get_token_budget` then told the
        // model `usedTotal: 0, remaining: <full budget>` mid-run, `isOverThreshold` read
        // false, and an eviction spanning that step became undetectable.
        //
        // A step that reports no numbers carries no information about the window, so the
        // correct action is to leave the tracker's state alone, not to overwrite it with a
        // fabricated zero.
        // Gate on inputTokens specifically: it IS the context-window measurement that
        // update() assigns unconditionally. Gating on "either field present" was still
        // wrong — a step reporting only outputTokens would have reset the window to 0.
        if (budgetTracker && usage.inputTokens !== undefined) {
          budgetTracker.update(safeTokenCount(usage.inputTokens), safeTokenCount(usage.outputTokens));
        }
        // Accumulate real totals so an error path can still report them (see StepTotals).
        stepTotals.steps += 1;
        // FABRICATION-OK: an absent toolCalls ARRAY means the step made no tool calls —
        // absence and zero genuinely coincide for a list length, unlike a provider count.
        // EXTERNAL-OK: reads a COUNT or an enum off the SDK result, not a priced quantity. An array length and a
    // finishReason string carry no money and no threshold.
        stepTotals.toolCalls += step.toolCalls?.length ?? 0;

        // Carry the provider's own metadata and warnings forward so the error path can
        // run the SAME extraction the success path runs (see StepTotals.providerMetadata).
        // Last step wins for metadata — it mirrors what the success path reads from
        // `result.providerMetadata`; warnings accumulate because each step may raise its own.
        if (step.providerMetadata) {
          stepTotals.providerMetadata = step.providerMetadata as Record<string, unknown>;
        }
        if (step.warnings?.length) stepTotals.warnings.push(...step.warnings);

        // ABSENT IS NOT ZERO. Each pool records whether it was REPORTED separately from
        // its value, because `?? 0` below cannot tell "the provider said zero" from "the
        // provider said nothing" — and stepTotalsToUsage's consumer branches on exactly
        // that distinction. `usage` itself is never falsy (it is a required field the SDK
        // always materializes), so presence is read from the NUMBERS, not the wrapper.
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
          stepTotals.sawUsage = true;
        }
          // FABRICATION-OK: adding 0 for a field this step did not report is correct —
          // there is nothing to add — and the sawUsage flag, not the sum, is what tells a
          // consumer whether anything was measured at all.
          //
          // A previous version of this waiver said "inside the sawUsage presence guard".
          // That was FALSE: the guard opens and closes above this line, and only the
          // comment's indentation implied nesting. The behaviour was right for a different
          // reason than the one written down, which is its own defect — a waiver is only
          // worth as much as its reason.
        stepTotals.inputTokens += usage.inputTokens ?? 0;
          // FABRICATION-OK: see inputTokens above.
        stepTotals.outputTokens += usage.outputTokens ?? 0;
        if (usage.inputTokenDetails?.noCacheTokens !== undefined) {
          stepTotals.sawNoCache = true;
          stepTotals.noCacheTokens += safeTokenCount(usage.inputTokenDetails.noCacheTokens);
        }
        if (usage.inputTokenDetails?.cacheReadTokens !== undefined) {
          stepTotals.sawCacheRead = true;
          stepTotals.cacheReadTokens += safeTokenCount(usage.inputTokenDetails.cacheReadTokens);
        }
        if (usage.inputTokenDetails?.cacheWriteTokens !== undefined) {
          stepTotals.sawCacheWrite = true;
          stepTotals.cacheWriteTokens += safeTokenCount(usage.inputTokenDetails.cacheWriteTokens);
        }
        if (usage.outputTokenDetails?.reasoningTokens !== undefined) {
          stepTotals.sawReasoning = true;
          stepTotals.reasoningTokens += safeTokenCount(usage.outputTokenDetails.reasoningTokens);
        }
      },
    });
  }

  /**
   * Compute estimated USD cost from usage and the resolved model's registry
   * pricing (USD per MILLION tokens; live-pinned sonnet 3/15 — hence /1e6).
   *
   * Pricing contract: `usage.input_tokens` arrives CACHE-EXCLUSIVE (mapUsage
   * normalizes it), each cache pool is priced exactly once at its own rate, and a
   * model with no dedicated cache rate falls back to the full input rate — a
   * conservative overstatement, never an undercount. Implementation notes inline.
   */
  private computeCostUsd(usage: UsageMetrics, cost: ResolvedModel['cost']): number | undefined {
    if (!cost) return undefined;
    // FABRICATION-OK: reads UsageMetrics, which mapUsage has ALREADY clamped, not a raw provider
    // payload. The rates on the other side of this multiply are clamped by sanitizeModelCost.
    let usd = usage.input_tokens * cost.input + usage.output_tokens * cost.output;

    // The cache-SERVED portion reaches us under one of two names, never both meaning
    // different things: `cache_read_input_tokens` on the v6 details path, or
    // `cached_input_tokens` on the legacy-metadata fallback that runs when a provider
    // reports no inputTokenDetails (unknown providers via `ai.additionalProviders`).
    // Pricing only the former made the latter FREE — mapUsage removes those tokens from
    // input_tokens, so if nothing charges them here, nothing charges them at all.
    // Prefer cache_read (0 is a real value, not a miss) and fall back to cached_input,
    // so exactly one of the two is priced and neither is double-counted.
    // FABRICATION-OK: post-clamp UsageMetrics; the `?? 0` is the documented "neither pool reported"
    // case, where nothing cache-served was billed.
    const cacheServed = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0;
    usd += cacheServed * (cost.cacheRead ?? cost.input);
    // FABRICATION-OK: post-clamp UsageMetrics; absent means none was billed. The RATES on the other side
    // of this multiply are clamped by sanitizeModelCost.
    usd += (usage.cache_creation_input_tokens ?? 0) * (cost.cacheWrite ?? cost.input);
    return usd / 1e6;
  }

  /**
   * Build AIGenerateResult from successful generateText output.
   */
  private buildGenerateResult(
    result: Awaited<ReturnType<typeof generateText>>,
    resolved: ResolvedModel,
    useStructuredOutput: boolean,
  ): AIGenerateResult {
    // EXTERNAL-OK: reads a COUNT or an enum off the SDK result, not a priced quantity. An array length and a
    // finishReason string carry no money and no threshold.
    const toolCallCount = result.steps.reduce(
      // FABRICATION-OK: array length — absence and zero genuinely coincide.
      // EXTERNAL-OK: reads a COUNT or an enum off the SDK result, not a priced quantity. An array length and a
    // finishReason string carry no money and no threshold.
      (sum, step) => sum + (step.toolCalls?.length ?? 0),
      0,
    );
    // `result.usage` is the LAST STEP's usage; `result.totalUsage` is the sum across
    // every step (ai/dist/index.d.ts GenerateTextResult: "The token usage of the last
    // step" vs "The total token usage of all steps"). An agent loop runs up to
    // DEFAULT_MAX_STEPS steps, so reading `usage` reported one step and silently
    // discarded the rest — measured live 2026-08-22: a 7-tool-call run reported
    // cache_read from the final step with cache_creation 0, a cache read with no
    // corresponding write. Fall back to `usage` only for callers/mocks that predate
    // totalUsage.
    const usage = this.mapUsage(result.totalUsage ?? result.usage, result.providerMetadata, resolved.provider);

    this.logger.info(
      // EXTERNAL-OK: reads a COUNT or an enum off the SDK result, not a priced quantity. An array length and a
    // finishReason string carry no money and no threshold.
      `Complete: ${result.steps.length} steps, ${toolCallCount} tool calls, finish=${result.finishReason}`,
    );
    this.logger.info(
      `Usage: ${usage.input_tokens}in / ${usage.output_tokens}out` +
      // FABRICATION-OK: LOG FORMATTING only. These ternaries omit a zero pool from a debug line; the value
      // reaches no metric, no cost, and no consumer. Rendering "/ cache_write=0" would be
      // noise, not information.
      (usage.cache_creation_input_tokens ? ` / cache_write=${usage.cache_creation_input_tokens}` : '') +
      // FABRICATION-OK: LOG FORMATTING only — omits a zero pool from a debug line. The value reaches no
      // metric, no cost and no consumer; rendering "=0" would be noise, not information.
      (usage.cache_read_input_tokens ? ` / cache_read=${usage.cache_read_input_tokens}` : '') +
      // FABRICATION-OK: LOG FORMATTING only — omits a zero pool from a debug line. The value reaches no
      // metric, no cost and no consumer; rendering "=0" would be noise, not information.
      (usage.thinking_tokens ? ` / thinking=${usage.thinking_tokens}` : ''),
    );

    // Provider warnings — the SDK's own report of settings it could not honor
    // ("temperature is not supported when thinking is enabled", max_tokens clamped,
    // unknown context-management strategy, cache-breakpoint limit exceeded, …). Provider
    // option schemas strip unknown keys silently, so this is the ONLY channel that says a
    // request setting did not take effect. Logged at warn so it is visible without
    // requiring debug, and carried on the result for callers that record telemetry.
    // Formatting lives in formatCallWarnings so the fallback path renders warnings
    // identically — see that helper for why the discriminant is narrowed, not cast.
    const providerWarnings = formatCallWarnings(result.warnings);
    for (const w of providerWarnings) {
      this.logger.warn(`Provider warning (${resolved.provider}:${resolved.modelId}): ${w}`);
    }

    const usageShapeDrift = this.detectUsageShapeDrift(
      // EXTERNAL-OK: reads a COUNT or an enum off the SDK result, not a priced quantity. An array length and a
    // finishReason string carry no money and no threshold.
      result.providerMetadata as Record<string, unknown> | undefined,
    );

    return {
      text: result.text,
      usage,
      toolCallCount,
      model: `${resolved.provider}:${resolved.modelId}`,
      provider: resolved.provider,
      steps: result.steps.length,
      finishReason: result.finishReason,
      costUsd: this.computeCostUsd(usage, resolved.cost),
      // `result.output` is a THROWING GETTER, not a property: it raises
      // NoOutputGeneratedError unless the SDK resolved an output, and the SDK only
      // resolves one when the LAST step finished with 'stop'
      // (ai/dist/index.js: `if (lastStep.finishReason === "stop") { … }`, and
      // `get output() { if (this._output == null) throw new NoOutputGeneratedError(); }`).
      // Reading it unconditionally therefore threw on every structured-output run that
      // ended in 'tool-calls' (the step ceiling), 'length' (max output tokens),
      // 'content-filter', 'error', or 'other' — collapsing MaxStepsExhaustedError and the
      // steps.near-exhaustion marker into an opaque SdkApiError(0). Guard on the same
      // condition the SDK uses, so a non-'stop' finish degrades to text extraction
      // instead of failing the run.
      structuredOutput: useStructuredOutput && result.finishReason === 'stop'
        ? result.output
        : undefined,
      ...(usageShapeDrift.length > 0 ? { usageShapeDrift } : {}),
      ...(providerWarnings.length > 0 ? { providerWarnings } : {}),
    };
  }

  /**
   * Handle generate errors — structured output fallback or error mapping.
   */
  /**
   * The degraded-but-usable result returned when structured output could not be
   * produced and the run falls back to text extraction. Shared by both fallback
   * branches in handleGenerateError, which differ only in text, usage source, and
   * finishReason — everything else was byte-identical between them.
   *
   * costUsd here is a REAL computed value, not undefined: on a priced model a
   * zero-usage fallback is genuinely $0, whereas undefined means the model carries
   * no pricing at all. That polarity is load-bearing downstream (sumCostUsd).
   */
  private buildFallbackResult(
    resolved: ResolvedModel,
    text: string,
    stepTotals: StepTotals,
    finishReason: string,
  ): AIGenerateResult {
    // Usage comes from the accumulated per-step totals, NOT from the error's
    // last-step snapshot, and steps/toolCalls report what actually ran. When no step
    // ever reported usage there is nothing honest to price, so costUsd is left
    // undefined (absent) rather than asserted as a real 0 — sumCostUsd propagates
    // undefined as worst-child, which is the correct polarity for "unknown".
    //
    // All THREE arguments are passed, exactly as the success path passes them. This
    // method used to call `mapUsage(usage)` with the other two omitted, which made the
    // fallback a SECOND, REDUCED construction path — and a second place to be wrong. Every
    // provider extract tier was dead here, so Google thinking tokens landed in
    // `reasoning_tokens`, an unknown provider's cache pool went entirely unpriced, and
    // neither drift instrument appeared on a degraded result. The fix is not a patch at
    // each symptom; it is removing the divergence, so there is one path to keep correct.
    const usage = this.mapUsage(
      stepTotalsToUsage(stepTotals),
      stepTotals.providerMetadata,
      resolved.provider,
    );
    const providerWarnings = formatCallWarnings(stepTotals.warnings);
    const usageShapeDrift = this.detectUsageShapeDrift(stepTotals.providerMetadata);
    return {
      text,
      structuredOutput: undefined,
      usage,
      toolCallCount: stepTotals.toolCalls,
      model: `${resolved.provider}:${resolved.modelId}`,
      provider: resolved.provider,
      steps: stepTotals.steps,
      finishReason,
      costUsd: stepTotals.sawUsage ? this.computeCostUsd(usage, resolved.cost) : undefined,
      ...(usageShapeDrift.length > 0 ? { usageShapeDrift } : {}),
      ...(providerWarnings.length > 0 ? { providerWarnings } : {}),
    };
  }

  private handleGenerateError(
    error: unknown,
    resolved: ResolvedModel,
    useStructuredOutput: boolean,
    timeoutMs?: number,
    stepTotals: StepTotals = emptyStepTotals(),
    callerSignal?: AbortSignal,
  ): AIGenerateResult {
    // NoOutputGeneratedError is a DISTINCT class from NoObjectGeneratedError — its own
    // symbol marker, so NoObjectGeneratedError.isInstance() returns false for it
    // (verified live 2026-08-23). The finishReason guard at the read site should keep it
    // from being raised at all; this is the belt-and-braces catch so that if it ever is,
    // the run degrades to text extraction rather than dying as SdkApiError(0).
    if (useStructuredOutput && NoOutputGeneratedError.isInstance(error)) {
      this.logger.warn(
        'Structured output was requested but the model produced none (non-"stop" finish) — falling back to text extraction.',
      );
      return this.buildFallbackResult(resolved, '', stepTotals, 'error');
    }

    if (useStructuredOutput && NoObjectGeneratedError.isInstance(error)) {
      this.logger.warn(
        `Structured output generation failed — falling back to text extraction: ${error.message}`,
      );
      // NOTE: error.usage is deliberately NOT used — it is lastStep.usage, not the run
      // total (ai/dist/index.js builds the error context from `{ usage: lastStep.usage }`).
      return this.buildFallbackResult(
        resolved,
        error.text ?? '',
        stepTotals,
        error.finishReason ?? 'error',
      );
    }
    throw this.mapError(error, timeoutMs, resolved, callerSignal);
  }

  /**
   * Resolve model alias and ensure provider is loaded.
   * @internal Used by AgentExecutor for early provider detection.
   */
  async resolveModel(
    input: string,
    opts?: { requiredCapabilities?: Array<keyof ModelCapabilities> },
  ): Promise<ResolvedModel> {
    const resolved = await this.catalog.resolve(input, opts);
    await this.ensureProvider(resolved.provider);
    return resolved;
  }

  /**
   * Create provider-defined shell tool for the resolved model's provider.
   *
   * - Anthropic: bash_20250124 (Claude's built-in bash knowledge) — returns string
   * - OpenAI: openai.tools.shell() with local execution — returns structured output
   *
   * Returns undefined if the model's provider has no shell tool support or
   * the provider instance is not available.
   */
  createProviderShellTool(
    provider: string,
    targetDir: string,
    timeoutMs = 30_000,
  ): ToolSet | undefined {
    if (provider === 'anthropic' && this.anthropicInstance) {
      // Access bash tool by typed version constant (date-stamped, updated in constants.ts).
      // Direct property access uses the SDK's own ProviderToolFactory type — no any needed.
      const bashTool = this.anthropicInstance.tools[ANTHROPIC_BASH_TOOL_VERSION];
      if (!bashTool) {
        // Date-stamped identifiers are the fastest-decaying surface (issue
        // f90fbbbc): this fires when the constant and the installed SDK have
        // moved apart in EITHER direction — name both remedies, since the
        // likelier one (SDK bumped ahead, old tool key dropped) is fixed by
        // updating the constant, not the package.
        throw new ConfigurationError(
          `Anthropic bash tool ${ANTHROPIC_BASH_TOOL_VERSION} not found on provider instance. ` +
          `Either update ANTHROPIC_BASH_TOOL_VERSION in constants.ts to the current tool version ` +
          `exposed by the installed @ai-sdk/anthropic (SDK moved ahead of the constant), ` +
          `or update @ai-sdk/anthropic (constant moved ahead of the SDK).`,
        );
      }
      return {
        bash: bashTool({
          execute: async ({ command }) => executeShellAsString(command, targetDir, timeoutMs, this.logger),
        }),
      };
    }

    if (provider === 'openai' && this.openaiInstance) {
      // Type assertion needed: OpenAI provider-defined tool uses a specific
      // FlexibleSchema<{action: ...}> that doesn't widen to ToolSet's generic
      // Tool<any, any> due to schema symbol variance. Safe at runtime.
      return {
        shell: this.openaiInstance.tools.shell({
          execute: async ({ action }) => executeShellAsOpenAIResult(action, targetDir, timeoutMs, this.logger),
        }),
      } as unknown as ToolSet;
    }

    return undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Options
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build system message with provider-specific cache control.
   *
   * For Anthropic: wraps system text in a SystemModelMessage with
   * ephemeral cache control. The API ignores cache hints if the
   * prompt is below the minimum cacheable length (1024 tokens for Sonnet).
   *
   * For other providers: passes through as plain string.
   * OpenAI caching is automatic for prompts ≥1024 tokens — no markup needed.
   */
  private buildSystemMessage(
    provider: string,
    systemText: string,
  ): string | { role: 'system'; content: string; providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } {
    if (provider !== 'anthropic') {
      return systemText;
    }

    return {
      role: 'system' as const,
      content: systemText,
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' as const },
        },
      },
    };
  }

  /**
   * Build top-level providerOptions for generateText().
   * Dispatches to provider-specific builders.
   */
  /**
   * Provider-specific option builders. New providers add an entry here
   * instead of adding a new if-branch to buildProviderOptions.
   */
  private readonly providerOptionsBuilders: Record<
    string,
    (resolved: ResolvedModel, userOptions?: ProviderOptions, effectiveBudget?: number) => ProviderOptions | undefined
  > = {
    anthropic: (r, o, b) => this.buildAnthropicOptions(r, o, b),
    openai: (r, o) => this.buildOpenAIOptions(r, o),
    google: (r, o) => this.buildGoogleOptions(r, o),
  };

  private buildProviderOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
    effectiveBudget?: number,
  ): ProviderOptions | undefined {
    const builder = this.providerOptionsBuilders[resolved.provider];
    return builder ? builder(resolved, userOptions, effectiveBudget) : userOptions;
  }

  /**
   * Anthropic-specific provider options.
   * - Auto-enables extended thinking when model has extendedThinking capability
   * - Auto-injects context management (clear old tool uses at 100K tokens)
   */
  private buildAnthropicOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
    effectiveBudget?: number,
  ): ProviderOptions {
    const userAnthropicOpts = (userOptions?.anthropic ?? {}) as Record<string, unknown>;
    let anthropicOpts = { ...userAnthropicOpts };

    // Route structured output through a json TOOL rather than the `output_format` field.
    //
    // WHY: the provider's default `structuredOutputMode: 'auto'` prefers `output_format`, which
    // Anthropic has since DEPRECATED ("This field is deprecated. Use 'output_config'") and whose
    // grammar compiler rejects our schema alongside the 7 filesystem tools with
    // HTTP 400 "The compiled grammar is too large". Verified by capturing the real request: the
    // failing call carried `output_format` plus the tools, and the identical tools succeed without
    // it. 'jsonTool' is the provider's own supported alternative and sidesteps the retired path.
    //
    // This is the Anthropic-side counterpart to `strictJsonSchema: false` for OpenAI — both exist
    // because one schema has to satisfy two providers with incompatible structured-output rules.
    // The `in` check preserves an explicit caller override.
    if (!('structuredOutputMode' in anthropicOpts)) {
      anthropicOpts = { ...anthropicOpts, structuredOutputMode: 'jsonTool' };
    }

    // Auto-enable extended thinking if model supports it and user hasn't specified
    if (resolved.capabilities.extendedThinking && !('thinking' in anthropicOpts)) {
      // EXTERNAL-OK: passed verbatim to the Anthropic provider, which validates its own thinking budget and
    // rejects a malformed one at the API boundary. Not read arithmetically here.
      const budgetTokens = this.config.defaultThinkingBudget;
      anthropicOpts = {
        ...anthropicOpts,
        thinking: { type: 'enabled' as const, budgetTokens },
      };
    }

    // Auto-inject context management to clear old tool uses when context grows large.
    // Trigger at 50% of the effective context budget (the model's real window, or
    // the operator cap) to leave room for the final response. Keep the 5 most recent
    // tool uses so the model retains working context.
    if (!('contextManagement' in anthropicOpts)) {
      // The SECOND reader of contextBudget, and it bypassed the guard the first one got.
      // `usableBudget` guards the DERIVATION path (deriveContextBudget); this is a
      // different path reading the same config field raw, so `0` produced
      // `trigger: {value: 0}` — Anthropic context management evicting tool uses from step 1,
      // silently — and NaN serialized to `null` on the wire.
      const evictionBudget = usableBudget(effectiveBudget)
        ?? usableBudget(this.config.contextBudget)
        ?? DEFAULT_CONTEXT_BUDGET;
      const contextTrigger = Math.round(evictionBudget * 0.5);
      anthropicOpts = {
        ...anthropicOpts,
        contextManagement: {
          edits: [
            {
              type: ANTHROPIC_CONTEXT_MANAGEMENT_TYPE,
              trigger: { type: 'input_tokens', value: contextTrigger },
              keep: { type: 'tool_uses', value: ANTHROPIC_CONTEXT_KEEP_TOOL_USES },
              clearToolInputs: true,
            },
          ],
        },
      };
    }

    return {
      ...(userOptions ?? {}),
      anthropic: anthropicOpts as Record<string, unknown>,
    } as ProviderOptions;
  }

  /**
   * OpenAI-specific provider options.
   * - Auto-sets reasoningEffort for reasoning-capable models (o1, o3, o4-mini)
   * - No context management equivalent — budget wrap-up via prepareStep is the only guard
   * - systemMessageMode auto-handled by @ai-sdk/openai (system → developer for reasoning)
   */
  private buildOpenAIOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions | undefined {
    const userOpenAIOpts = (userOptions?.openai ?? {}) as Record<string, unknown>;
    let openaiOpts = { ...userOpenAIOpts };

    // Disable OpenAI strict structured-output mode unless the caller asked otherwise.
    //
    // WHY: strict mode requires every property to appear in `required`, so it rejects
    // `.optional()` outright. agentOutputSchema previously worked around that by making
    // every field `.nullable()` instead — but Zod renders each nullable as a JSON-Schema
    // union, and Anthropic hard-rejects (HTTP 400) any schema with more than 16 union
    // parameters. At 29 the schema was unusable on Anthropic while fine on OpenAI.
    //
    // Relaxing strict mode is what lets the schema use `.optional()` and stay under
    // Anthropic's budget. TRADE-OFF, stated plainly: OpenAI no longer enforces the schema
    // as rigidly, so a malformed response is caught by our own parse/normalize path rather
    // than refused by the provider. That path already exists and is exercised
    // (mapStructuredOutput re-validates via agentOutputSchema.safeParse), which is what
    // makes the trade acceptable rather than merely convenient.
    if (!('strictJsonSchema' in openaiOpts)) {
      openaiOpts = { ...openaiOpts, strictJsonSchema: false };
    }

    // Auto-set reasoningEffort for reasoning models if user hasn't specified
    if (resolved.capabilities.extendedThinking && !('reasoningEffort' in openaiOpts)) {
      openaiOpts = {
        ...openaiOpts,
        reasoningEffort: 'medium',
      };
    }

    // No options to inject — return user options unchanged
    if (Object.keys(openaiOpts).length === 0) {
      return userOptions;
    }

    return {
      ...(userOptions ?? {}),
      openai: openaiOpts as Record<string, unknown>,
    } as ProviderOptions;
  }

  /**
   * Google-specific provider options.
   * - Auto-enables thinkingConfig with thinkingBudget for thinking-capable models (Gemini 2.5+)
   * - No context management equivalent — budget wrap-up via prepareStep is the only guard
   * - No system message wrapping — Gemini caching is implicit for 2.5+ models
   */
  private buildGoogleOptions(
    resolved: ResolvedModel,
    userOptions?: ProviderOptions,
  ): ProviderOptions | undefined {
    const userGoogleOpts = (userOptions?.google ?? {}) as Record<string, unknown>;
    let googleOpts = { ...userGoogleOpts };

    // Auto-enable thinking for models with extendedThinking capability (Gemini 2.5+)
    if (resolved.capabilities.extendedThinking && !('thinkingConfig' in googleOpts)) {
      googleOpts = {
        ...googleOpts,
        // EXTERNAL-OK: passed verbatim to the Anthropic provider, which validates its own thinking budget and
    // rejects a malformed one at the API boundary. Not read arithmetically here.
        thinkingConfig: { thinkingBudget: this.config.defaultThinkingBudget },
      };
    }

    if (Object.keys(googleOpts).length === 0) {
      return userOptions;
    }

    return {
      ...(userOptions ?? {}),
      google: googleOpts as Record<string, unknown>,
    } as ProviderOptions;
  }

  /**
   * Build a prepareStep callback that forces wrap-up when budget is 80% consumed.
   *
   * Each step's `inputTokens` is the TOTAL input for that API call (the full
   * conversation including cached tokens). The last step's value represents the
   * current context window size. We check that against the budget.
   */
  /**
   * True when this run's provider options put Anthropic into `structuredOutputMode:
   * 'jsonTool'` — the mode in which the provider hard-overrides `toolChoice` to select its
   * json tool, making a `toolChoice: 'none'` wrap-up brake inert.
   *
   * Reads the options object that will actually be SENT, not the config that was intended,
   * so an explicit caller override of structuredOutputMode is respected: a caller who
   * selects a different mode gets a working brake and an honest marker.
   */
  private isAnthropicJsonToolMode(providerOptions?: ProviderOptions): boolean {
    const anthropic = providerOptions?.anthropic as Record<string, unknown> | undefined;
    return anthropic?.['structuredOutputMode'] === 'jsonTool';
  }

  private buildBudgetPrepareStep(budget: number, budgetTracker?: TokenBudgetTracker, brakeIsHonored = true) {
    // Hysteresis band: latch wrap-up on at 80% of budget, release it only once
    // context falls back below 70%. The lower release threshold prevents the
    // latch from flapping on/off around a single boundary, while still allowing
    // recovery — e.g. after provider-side context eviction (Anthropic context
    // management clears old tool uses) the input size can genuinely drop, and a
    // permanently-stuck latch would otherwise force premature wrap-up for the
    // rest of a run that has plenty of room again.
    const upperThreshold = budget * 0.80;
    const lowerThreshold = budget * 0.70;
    let wrapUpInjected = false;
    return ({ steps }: { steps: Array<{ usage: { inputTokens?: number; outputTokens?: number } }> }) => {
      if (steps.length === 0) return {};

      // Last step's inputTokens = current context window size
      const lastStep = steps[steps.length - 1]!;
      // ABSENT IS NOT ZERO — the third reader of this same object to need saying so.
      //
      // A step that reports no numbers says NOTHING about the context window, and `?? 0`
      // turned that silence into "the window is empty". Measured: after latching at
      // 85,000/100,000, one null-usage step drove contextSize to 0, released the latch,
      // withdrew the `budget.forced-wrap-up` marker (so deriveCompleteness reported
      // 'complete' for a run whose coverage really was cut), disengaged the brake so the
      // caller's cost ceiling lapsed above 80%, and logged "Context budget recovered
      // (0/100000)" — a recovery that never happened.
      //
      // The sibling reader at the budgetTracker.update call was guarded in the previous
      // commit; this one, 450+ lines away in the same file reading the same object, was
      // not. Hold the latch state rather than acting on a non-measurement.
      // EXTERNAL-OK: this IS the absent-vs-zero discriminator for the wrap-up brake — the guard itself.
      if (lastStep.usage.inputTokens === undefined) {
        return wrapUpInjected ? { toolChoice: 'none' as const } : {};
      }
      const contextSize = safeTokenCount(lastStep.usage.inputTokens);

      if (wrapUpInjected) {
        // Release the latch if context has recovered below the lower band.
        if (contextSize < lowerThreshold) {
          wrapUpInjected = false;
          if (brakeIsHonored) budgetTracker?.markForcedWrapUp(false);
          this.logger.info(
            `Context budget recovered (${contextSize}/${budget}, <70%). Releasing wrap-up — tool calls re-enabled.`,
          );
          return {};
        }
        // Still in/above the band — keep forcing output.
        return { toolChoice: 'none' as const };
      }

      if (contextSize >= upperThreshold) {
        wrapUpInjected = true;
        // Only claim a forced wrap-up when the brake can actually engage — see
        // brakeIsHonored at the call site. Latching regardless is what made every
        // Anthropic structured-output run crossing 80% report an event that never
        // occurred, and carry a 'degraded' marker and 'partial' completeness for it.
        if (brakeIsHonored) budgetTracker?.markForcedWrapUp(true);
        else budgetTracker?.markBrakeInert();
        this.logger.warn(
          brakeIsHonored
            ? `Context budget 80% used (${contextSize}/${budget}). Forcing output — no more tool calls.`
            : `Context budget 80% used (${contextSize}/${budget}). NOTE: the wrap-up brake cannot engage on this run — ` +
              `Anthropic's jsonTool structured-output mode overrides toolChoice — so tool calls continue. ` +
              `Lower contextBudget or disable structured output if you need a hard stop.`,
        );
        return { toolChoice: 'none' as const };
      }

      return {};
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize AI SDK provider factories from config.
   * @ai-sdk/anthropic, @ai-sdk/openai, and @ai-sdk/google are bundled and eagerly initialized.
   */
  private initializeProviders(aiConfig: ResolvedAIConfig): void {
    for (const [providerName, creds] of Object.entries(aiConfig.providers)) {
      if (providerName === 'anthropic') {
        const anthropic = createAnthropic({ apiKey: creds.apiKey });
        this.anthropicInstance = anthropic;
        this.providers.set('anthropic', (modelId) => anthropic(modelId));
      } else if (providerName === 'openai') {
        const openai = createOpenAI({ apiKey: creds.apiKey });
        this.openaiInstance = openai;
        this.providers.set('openai', (modelId) => openai(modelId));
      } else if (providerName === 'google') {
        const google = createGoogleGenerativeAI({ apiKey: creds.apiKey });
        this.providers.set('google', (modelId) => google(modelId));
      }
      // Other providers are loaded lazily in ensureProvider()
    }
  }

  /**
   * Ensure a provider is loaded. Dynamically imports non-bundled providers.
   */
  async ensureProvider(providerName: string): Promise<void> {
    if (this.providers.has(providerName)) return;

    const creds = this.config.ai.providers[providerName];
    if (!creds) {
      throw this.missingProviderError(providerName);
    }

    if (!this.validProviders.has(providerName)) {
      throw new ConfigurationError(
        `Unknown AI provider: "${providerName}". ` +
        `Valid providers: ${[...this.validProviders].join(', ')}`,
      );
    }

    try {
      // Dynamic import of @ai-sdk/<provider>.
      // SECURITY: additionalProviders names map to npm package names (@ai-sdk/<name>).
      // The package is resolved from the consuming project's node_modules — it carries
      // the full trust of the npm registry and the project's dependency tree. There is
      // no integrity verification beyond npm's own lockfile checksums. An attacker who
      // can write to node_modules (supply chain compromise, dependency confusion) could
      // achieve code execution via a malicious provider package.
      const mod = await import(`@ai-sdk/${providerName}`) as Record<string, unknown>;
      this.logger.info(`Loaded AI provider: @ai-sdk/${providerName}`);

      // Check override map first, then try standard naming convention (createMistral, createCohere, etc.)
      const factoryName = AIProvider.FACTORY_NAME_OVERRIDES[providerName]
        ?? `create${providerName.charAt(0).toUpperCase() + providerName.slice(1)}`;
      const createProvider = (mod[factoryName] ?? mod['default']) as
        ((opts: { apiKey: string }) => (modelId: string) => LanguageModel) | undefined;

      if (!createProvider || typeof createProvider !== 'function') {
        throw new ConfigurationError(
          `@ai-sdk/${providerName} does not export ${factoryName} or default. ` +
          `Check the package documentation.`,
        );
      }

      const provider = createProvider({ apiKey: creds.apiKey });
      this.providers.set(providerName, (modelId) => provider(modelId));
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;

      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === 'ERR_MODULE_NOT_FOUND' || errCode === 'MODULE_NOT_FOUND') {
        throw new ConfigurationError(
          `Provider "${providerName}" requires @ai-sdk/${providerName}. ` +
          `Install: npm install @ai-sdk/${providerName}`,
        );
      }
      throw error;
    }
  }

  /**
   * Get provider factory, throwing if not configured.
   */
  private getProviderFactory(providerName: string): (modelId: string) => LanguageModel {
    const factory = this.providers.get(providerName);
    if (!factory) {
      throw this.missingProviderError(providerName);
    }
    return factory;
  }

  private missingProviderError(providerName: string): ConfigurationError {
    const envVar = `${providerName.toUpperCase()}_API_KEY`;
    return new ConfigurationError(
      `AI provider "${providerName}" is not configured. ` +
      `Set the ${envVar} environment variable or add it to config.ai.providers: { ${providerName}: { apiKey: '...' } }`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Usage + Error Mapping
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Convert AI SDK usage to UluOps format
   */
  private mapUsage(
    usage: MappableUsage,
    providerMetadata?: Record<string, unknown>,
    provider?: string,
  ): UsageMetrics {
    // input_tokens is CACHE-EXCLUSIVE. AI SDK v6 flattens `inputTokens` from the
    // provider's `inputTokens.total`, which INCLUDES cache reads and cache writes
    // (ai/dist/index.js: `inputTokens: usage.inputTokens.total`). Reading it as if
    // it were the uncached input — the v5 shape — double-counts cache_creation and
    // charges cache_read at the full input rate. `noCacheTokens` carries the
    // uncached figure and is uniform across providers:
    //   anthropic  total = input + cacheCreation + cacheRead ; noCache = input_tokens
    //   openai     total = prompt_tokens                     ; noCache = prompt − cached
    //   google     total = promptTokenCount                  ; noCache = prompt − cached
    // Held as the raw flat total during extraction and normalized at the end of this
    // method, once the provider tiers have had a chance to report a cached portion.
    // Provider payloads are EXTERNAL data. `?? 0` reads like a numeric guarantee and is
    // not one: it passes NaN and Infinity straight through, and negative values arise
    // naturally because OpenAI/Google compute noCache as `prompt − cached` with
    // independently-defaulted operands. A NaN here becomes a NaN cost, which JSON
    // serializes to null and which sumCostUsd's `=== undefined` guard does not stop —
    // one malformed agent would blank an entire pipeline's recorded spend.
    const base: UsageMetrics = {
      input_tokens: safeTokenCount(usage.inputTokens),
      output_tokens: safeTokenCount(usage.outputTokens),
    };

    // 1. AI SDK standard path (works for both providers)
    // FABRICATION-OK: tests the DETAILS OBJECT for presence, not a number. The SDK either
    // sends the object or does not; its members are read with optionalTokenCount below.
    if (usage.inputTokenDetails) {
      base.cache_read_input_tokens = optionalTokenCount(usage.inputTokenDetails.cacheReadTokens);
      base.cache_creation_input_tokens = optionalTokenCount(usage.inputTokenDetails.cacheWriteTokens);
    }

    // 1b. Internal reasoning tokens, from the UNIFIED v6 field. Both providers that
    // report them route through `outputTokens.reasoning`:
    //   openai  completion_tokens_details.reasoning_tokens -> outputTokens.reasoning
    //   google  usageMetadata.thoughtsTokenCount           -> outputTokens.reasoning
    // Core keeps two separate reporting fields, so route by provider. Both remain
    // SUBSETS of output_tokens and are never added to the effective total.
    // Set before the metadata tiers so those act as fallbacks for older SDK shapes.
    // `!== undefined`, not truthiness, and clamped — the same two corrections applied to
    // the four metadata tiers below, which are this value's FALLBACKS. The guard went on
    // the fallbacks and not on the primary source.
    //
    // Truthiness was the sharper of the two bugs: a measured `reasoningTokens: 0` is
    // falsy, so the field stayed undefined and the `??=` legacy tier then won. Measured:
    // unified 0 alongside `providerMetadata.openai.reasoningTokens: 777` reported 777 — a
    // number nobody measured, on a run that explicitly reported zero. That also falsifies
    // the documented invariant that `??=` "can never override the unified value".
    const unifiedReasoning = optionalTokenCount(usage.outputTokenDetails?.reasoningTokens);
    if (unifiedReasoning !== undefined) {
      if (provider === 'google') base.thinking_tokens = unifiedReasoning;
      else base.reasoning_tokens = unifiedReasoning;
    }

    // 2-4. Extract provider-specific metadata
    this.extractAnthropicUsage(base, providerMetadata);
    this.extractOpenAIUsage(base, providerMetadata);
    this.extractGoogleUsage(base, providerMetadata);

    // 5. Generic provider metadata scan for non-bundled providers.
    // Best-effort extraction of cache tokens from unknown provider metadata.
    // Uses ??= to never override values set by provider-specific tiers above.
    // Guards on cached_input_tokens (not cache_read): the generic scan extracts
    // an unknown provider's cached *input* (cachedPromptTokens/cachedContentTokenCount),
    // which the disentangle (§3.2) routes to cached_input_tokens, not cache_read.
    if (providerMetadata && base.cached_input_tokens == null) {
      this.extractGenericUsage(base, providerMetadata);
    }

    // 6. NORMALIZE input_tokens to be CACHE-EXCLUSIVE — the contract every downstream
    // consumer assumes (UsageMetrics.input_tokens, calculateEffectiveTokens, computeCostUsd).
    // Preferred source is the SDK's own `noCacheTokens`, which is exact and uniform.
    // Otherwise fall back to subtracting the cached portion a provider tier reported,
    // which is what an unknown provider with no token details still gives us.
    // Both branches clamp. The legacy branch subtracts EVERY cache pool, not just
    // cached_input: anthropic-shaped metadata without inputTokenDetails populates
    // cache_read/cache_creation instead, and subtracting only cached_input left
    // input_tokens cache-INCLUSIVE — the pool was then charged again at its own rate
    // (measured $0.0334692 against a true $0.0037572).
    // FABRICATION-OK: this IS the absent-vs-zero discriminator — it selects the exact branch over the
    // legacy branch. Both arms clamp.
    base.input_tokens = usage.inputTokenDetails?.noCacheTokens !== undefined
      ? safeTokenCount(usage.inputTokenDetails.noCacheTokens)
      : Math.max(0, base.input_tokens
        // cache_read and cached_input are two NAMES for the one cache-served pool, so
        // exactly one is subtracted — the same `??` rule computeCostUsd prices by.
        // Summing them would double-subtract when both are populated from different
        // sources, which is as wrong in the other direction.
        - (base.cache_read_input_tokens ?? base.cached_input_tokens ?? 0)
        - (base.cache_creation_input_tokens ?? 0));

    return base;
  }

  /**
   * Recognized provider-metadata keys per provider — the fields the extract
   * tiers below reach for, plus benign envelope keys the SDKs are known to
   * send. Drift detection (issue adaaa4b9) fires when a provider's metadata
   * object is present and non-empty but contains NONE of these: the likely
   * cause is a provider-SDK rename, after which the extraction casts silently
   * resolve undefined and metrics read zero.
   */
  private static readonly RECOGNIZED_USAGE_KEYS: Record<string, readonly string[]> = {
    anthropic: ['cacheCreationInputTokens', 'cacheReadInputTokens', 'usage'],
    // v6 reality (verified against @ai-sdk/openai 3.0.33, live 2026-08-22): the openai
    // block carries `responseId`/`serviceTier` on the Responses path and
    // `acceptedPredictionTokens`/`rejectedPredictionTokens`/`logprobs` on Chat
    // Completions. It carries NO usage fields — cached input and reasoning tokens both
    // live in the unified usage shape now. Listing `cachedPromptTokens`/`reasoningTokens`
    // here previously implied this detector was watching them; it was not.
    openai: ['responseId', 'serviceTier', 'acceptedPredictionTokens', 'rejectedPredictionTokens', 'logprobs'],
    google: ['usageMetadata'],
  };

  /**
   * The subset of keys an extract tier actually READS — the only keys whose loss changes
   * a number. Empty means the tier depends on nothing in this provider's metadata block.
   *
   * This exists because the recognized-key check above is satisfied by ANY overlap, and
   * that is structurally the wrong test. `keys.some(k => recognized.includes(k))` means one
   * surviving key — including a benign envelope key like `usage` or `responseId` that no
   * tier reads — suppresses the warning for every key that vanished beside it. The
   * detector could not report the loss of the fields a tier depends on, which is the only
   * loss that matters, and that is exactly how the v6 OpenAI rename went unreported.
   *
   * openai is deliberately EMPTY: verified against @ai-sdk/openai 3.0.33, its block
   * carries no usage fields at all in v6 (cached input and reasoning both moved to the
   * unified usage shape). Its tier is a legacy fallback that must never be the sole
   * source, so there is nothing here whose absence is news. For a provider with an empty
   * set the detector falls back to the recognized-overlap test, which is all that can be
   * asserted about a block nothing depends on.
   */
  private static readonly DEPENDED_ON_USAGE_KEYS: Record<string, readonly string[]> = {
    anthropic: ['cacheCreationInputTokens', 'cacheReadInputTokens'],
    openai: [],
    google: ['usageMetadata'],
  };

  /** Providers already warned about this process — drift is chronic once present; one warn is signal, per-run warns are noise. */
  private readonly driftWarned = new Set<string>();

  /**
   * Detect provider-metadata shape drift (issue adaaa4b9). Returns the
   * providers whose metadata is present but unrecognizable. Deliberately
   * conservative: absent or empty metadata is NOT drift (fields are omitted
   * legitimately, e.g. uncached runs), only a non-empty object none of whose
   * keys we recognize. The resulting marker is info-severity — metrics
   * quality, not verdict evidence — so a false positive costs a log line,
   * not a completeness downgrade.
   *
   * FIXED, PARTIALLY — and the boundary matters, so read it before trusting this.
   *
   * The detector used to be satisfied by ANY overlap: `keys.some(k => recognized.includes(k))`
   * let a single surviving key suppress the warning for every key that vanished alongside
   * it. That is exactly how the v6 OpenAI drift went unreported — `responseId` survived and
   * was on the recognized list, while `cachedPromptTokens` and `reasoningTokens`, the only
   * two fields the extract tier consumed, were gone. The instrument reported "shape is
   * fine" about a block that no longer contained anything it read.
   *
   * It now asserts PRESENCE of the keys a tier depends on (DEPENDED_ON_USAGE_KEYS) for any
   * provider that declares them — anthropic and google.
   *
   * **`openai` still uses the old overlap test**, because its DEPENDED_ON set is
   * legitimately empty: in v6 its metadata block carries no usage fields at all, so there
   * is nothing whose absence would be news. The consequence is precise and worth stating
   * rather than leaving implied — *the exact drift that motivated this detector remains
   * undetectable for the exact provider it happened to.* Closing that needs the detector to
   * watch the UNIFIED usage shape rather than provider metadata, which is a different
   * instrument, not a tuning of this one.
   *
   * (This block previously claimed both "fixed" and "recorded as a decision to make" about
   * the same live code. Both halves were true of different providers; neither said so.)
   *
   * SCOPE WIDENED 2026-08-24. It also now reports providers that are present in the
   * payload but have NO entry in the table at all — the `ai.additionalProviders`
   * population. Those were previously invisible to it, because it iterated the table
   * rather than the payload, so the check could only ever confirm the three names it
   * already knew. They are reported as UNREAD rather than drifted; see the branch below.
   */
  private detectUsageShapeDrift(providerMetadata?: Record<string, unknown>): string[] {
    if (!providerMetadata) return [];
    const drifted: string[] = [];
    // Iterate what the PAYLOAD contains, not what the table lists.
    //
    // This walked `Object.entries(RECOGNIZED_USAGE_KEYS)` — three hardcoded names — so a
    // provider added through `ai.additionalProviders` was never looked at. That is an
    // instrument enumerating by NAME over a closed list while the population it must cover
    // is open by construction: the operator adds the names, and the table cannot grow to
    // meet them. Walking the payload's own keys is the closed enumeration — a metadata
    // block is either there or it is not.
    for (const provider of Object.keys(providerMetadata)) {
      const recognized = AIProvider.RECOGNIZED_USAGE_KEYS[provider];
      const meta = providerMetadata[provider];
      if (!meta || typeof meta !== 'object') continue;
      const keys = Object.keys(meta);
      if (keys.length === 0) continue;

      // A provider with no entry in the table has no extract tier either — mapUsage
      // dispatches to three by name (extractAnthropicUsage / OpenAI / Google). So this
      // block is not DRIFTED, it is UNREAD: whatever cache or reasoning counts it carries
      // are dropped, the metrics read zero, and computeCostUsd undercounts by exactly the
      // cache-served pool it never saw. Different diagnosis, same consequence and same
      // remedy channel as drift, so it rides the same marker — with its own message,
      // because "unrecognized shape" would send the reader to look for a rename that
      // never happened.
      if (!recognized) {
        drifted.push(provider);
        if (!this.driftWarned.has(provider)) {
          this.driftWarned.add(provider);
          this.logger.warn(
            `Provider metadata for "${provider}" is present but NO extract tier reads it ` +
            `(keys: ${keys.slice(0, 8).join(', ')}) — cache and thinking metrics for this ` +
            `provider read zero, and any cache-served tokens it reports are not priced. ` +
            `This is expected for a provider added via ai.additionalProviders; add an ` +
            `extract tier in AIProvider.mapUsage to account for it.`,
          );
        }
        continue;
      }

      // Assert PRESENCE of the keys a tier depends on, rather than mere overlap with a
      // list that also contains envelope keys. A provider that declares dependencies is
      // drifted when NONE of them survive — a surviving benign key no longer masks it.
      // Providers depending on nothing fall back to the overlap test.
      const dependedOn = AIProvider.DEPENDED_ON_USAGE_KEYS[provider] ?? [];
      const missingDependedOn = dependedOn.length > 0 && !dependedOn.some(k => keys.includes(k));
      const noOverlap = dependedOn.length === 0 && !keys.some(k => recognized.includes(k));
      if (!missingDependedOn && !noOverlap) continue;

      drifted.push(provider);
      if (!this.driftWarned.has(provider)) {
        this.driftWarned.add(provider);
        const detail = missingDependedOn
          ? `none of the fields its extract tier reads are present (expected one of: ${dependedOn.join(', ')})`
          : 'its shape is unrecognized';
        this.logger.warn(
          `Provider metadata for "${provider}" — ${detail} (keys: ${keys.slice(0, 8).join(', ')}) — ` +
          `token/cache/thinking metrics for this provider may silently read zero. ` +
          `The ${provider} provider SDK likely renamed its usage fields; update the extract tier in AIProvider.mapUsage.`,
        );
      }
    }
    return drifted;
  }

  private extractAnthropicUsage(base: UsageMetrics, providerMetadata?: Record<string, unknown>): void {
    const meta = (providerMetadata as { anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number } } | undefined)?.anthropic;
    if (!meta) return;
    // EVERY value here is external provider data and goes through the same guard the
    // SDK-standard path uses. These four tiers previously assigned raw. mapUsage's own
    // doc states the rule — "Provider payloads are EXTERNAL data; `?? 0` reads like a
    // numeric guarantee and is not one" — and enforced it only on the primary path, while
    // these tiers ARE the legacy/unknown-provider fallback route this release exists to
    // correct. Measured: `cacheReadInputTokens: -5000` against 10,000 reported input
    // produced input_tokens 15,000 (a 50% inflation) and $0.0435 against a true $0.030 —
    // finite the whole way, so both sumCostUsd's and sumTokenMetrics' finiteness guards
    // passed it through. A NaN produces a NaN cost, blanking a whole run's spend.
    base.cache_creation_input_tokens ??= optionalTokenCount(meta.cacheCreationInputTokens);
    base.cache_read_input_tokens ??= optionalTokenCount(meta.cacheReadInputTokens);
  }

  /**
   * LEGACY FALLBACK ONLY. Neither field this reads exists in `@ai-sdk/openai` 3.0.33:
   * `cachedPromptTokens` moved to `usage.inputTokenDetails.cacheReadTokens` and
   * `reasoningTokens` to `usage.outputTokenDetails.reasoningTokens`. Verified live
   * 2026-08-22 against gpt-5-nano — `providerMetadata.openai` carried only
   * `{responseId, serviceTier}` while the provider reported 512 reasoning tokens.
   * Both are now read from the unified usage shape in mapUsage; this remains only to
   * keep an older provider build working, and must never be the sole source.
   */
  private extractOpenAIUsage(base: UsageMetrics, providerMetadata?: Record<string, unknown>): void {
    const meta = (providerMetadata as { openai?: { cachedPromptTokens?: number; reasoningTokens?: number } } | undefined)?.openai;
    if (!meta) return;
    base.cached_input_tokens ??= optionalTokenCount(meta.cachedPromptTokens);
    // optionalTokenCount, not `|| undefined`: the latter maps a genuine reported 0 to
    // "not reported", which is the absent-vs-zero conflation this release corrects,
    // pointing the other way.
    base.reasoning_tokens ??= optionalTokenCount(meta.reasoningTokens);
  }

  private extractGoogleUsage(base: UsageMetrics, providerMetadata?: Record<string, unknown>): void {
    const gUsage = (providerMetadata as { google?: { usageMetadata?: { cachedContentTokenCount?: number; thoughtsTokenCount?: number } } } | undefined)?.google?.usageMetadata;
    if (!gUsage) return;
    // DISENTANGLE (§3.2): Google cachedContentTokenCount is cached *input*, not a cache read.
    base.cached_input_tokens ??= optionalTokenCount(gUsage.cachedContentTokenCount);
    // Fallback only — mapUsage prefers the unified outputTokenDetails.reasoningTokens,
    // which is where the provider now routes thoughtsTokenCount.
    base.thinking_tokens ??= optionalTokenCount(gUsage.thoughtsTokenCount);
  }

  private extractGenericUsage(base: UsageMetrics, providerMetadata: Record<string, unknown>): void {
    const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'google']);
    for (const [key, value] of Object.entries(providerMetadata)) {
      if (KNOWN_PROVIDERS.has(key) || typeof value !== 'object' || !value) continue;
      const meta = value as Record<string, unknown>;
      // FABRICATION-OK: guarded on the next line by an explicit typeof + Number.isFinite + > 0 check
      // before use, and routed through optionalTokenCount when assigned.
      const cached = meta['cachedTokens'] ?? meta['cachedContentTokenCount'] ?? meta['cachedPromptTokens'];
      if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) {
        // DISENTANGLE (§3.2): unknown-provider cached input → cached_input_tokens, not cache_read.
        // Guarded like the other three tiers — `typeof x === 'number'` admits NaN and
        // Infinity, and this tier reads a completely unvetted provider's payload.
        base.cached_input_tokens = optionalTokenCount(cached);
        break;
      }
    }
  }

  /**
   * Map AI SDK errors to sdk-core error types.
   * AI SDK normalizes all provider errors to APICallError with statusCode.
   */
  /**
   * Map a provider APICallError to the sdk-core error type its status implies.
   * Extracted from mapError so that method reads as a dispatch table rather than
   * four interleaved concerns. Pure extraction — branch order and messages are
   * unchanged; the caller still attaches `cause`.
   */
  private mapAPICallError(error: APICallError, resolved?: ResolvedModel): Error {
    const status = error.statusCode ?? 0;
    let mapped: Error;

    if (status === 429) {
      mapped = new RateLimitError(
        `Rate limit exceeded (HTTP 429). Back off and retry. Provider message: ${error.message}`,
      );
    } else if (status === 401) {
      mapped = new UnauthorizedError(
        `Authentication failed (HTTP 401). Check your provider API key. Provider message: ${error.message}`,
      );
    } else if (status === 403) {
      mapped = new ForbiddenError(
        `Forbidden (HTTP 403). Check API key permissions or billing status. Provider message: ${error.message}`,
      );
    } else if (status === 404) {
      // A provider 404 has two unrelated causes that are indistinguishable
      // from the status code alone. `resolved.registered` is the only thing
      // that separates them, which is why ModelCatalog carries it: a model
      // present in the catalog but 404-ing at the provider means the catalog
      // is stale (withdrawn upstream, local copy not yet retired); a model
      // that was never in the catalog is far more likely a wrong name.
      const modelRef = resolved ? `${resolved.provider}:${resolved.modelId}` : 'the requested model';
      const diagnosis = resolved === undefined
        ? 'Model provenance is unknown here — verify the model name against `ulu models list`.'
        : resolved.registered
          ? `${modelRef} IS in the model catalog but the provider does not recognize it — the catalog is very likely STALE (the model was retired upstream and the local catalog has not caught up). Re-sync the catalog; do not assume the name is wrong.`
          : `${modelRef} is NOT in the model catalog, so it was passed through unvalidated. Check the model name for typos, or confirm your account has access to it.`;
      mapped = new SdkApiError(
        404,
        `Provider returned HTTP 404 for ${modelRef}. ${diagnosis} Provider message: ${error.message}`,
      );
    } else if (status >= 500) {
      mapped = new ServiceUnavailableError(
        `Provider server error (HTTP ${status}). This is typically transient — retry or check the provider's status page. Provider message: ${error.message}`,
      );
    } else {
      mapped = new SdkApiError(status, `Provider returned HTTP ${status}: ${error.message}`);
    }
    return mapped;
  }

  private mapError(
    error: unknown,
    timeoutMs?: number,
    resolved?: ResolvedModel,
    callerSignal?: AbortSignal,
  ): Error {
    this.logger.error(`AI SDK error: ${formatErrorMessage(error)}`);

    const cause = error instanceof Error ? error : undefined;

    if (isAPICallError(error)) {
      const mapped = this.mapAPICallError(error, resolved);
      mapped.cause = cause;
      return mapped;
    }

    if (isRetryError(error)) {
      // A RetryError WRAPS the real cause — it carries no statusCode of its own, so
      // returning SdkApiError(0) here discarded the very thing a caller needs. A run
      // rate-limited into exhaustion must still surface as RateLimitError so backoff
      // logic can key off it. Re-map the last underlying attempt, then annotate with
      // the attempt count and reason ('maxRetriesExceeded' | 'errorNotRetryable' | 'abort').
      const attempts = Array.isArray(error.errors) ? error.errors.length : undefined;
      const last = Array.isArray(error.errors) && error.errors.length > 0
        ? error.errors[error.errors.length - 1]
        : error.lastError;
      const detail = `Retries exhausted${attempts ? ` after ${attempts} attempt(s)` : ''}`
        + `${error.reason ? ` (${error.reason})` : ''}`;

      if (last !== undefined && last !== error) {
        // Forward `callerSignal` into the unwrap. Without it, a cancel that lands during a
        // retried request comes back wrapped in a RetryError and the recursive call has no
        // way to attribute the abort — the cancel would be re-mapped as a TimeoutError,
        // which is the exact misreport this parameter exists to prevent, hidden one layer
        // down where the outer classification never sees it.
        const mapped = this.mapError(last, timeoutMs, resolved, callerSignal);
        mapped.message = `${detail}: ${mapped.message}`;
        // `cause` is the RetryError wrapper, NOT the unwrapped attempt — deliberate.
        // The message already carries the underlying failure; the wrapper is what
        // retains the attempt list and reason, which is the more useful context to
        // keep reachable from the thrown error.
        mapped.cause = cause;
        return mapped;
      }
      const mapped = new SdkApiError(0, `${detail}: ${error.message}`);
      mapped.cause = cause;
      return mapped;
    }

    // Abort / timeout. `AbortSignal.timeout()` — which is what core installs at the
    // generateText call — aborts with a DOMException named 'TimeoutError', NOT
    // 'AbortError' (verified live 2026-08-23). Matching only 'AbortError' meant every
    // timeout fell through to SdkApiError(0) and the TimeoutError branch was dead.
    // The name set mirrors the SDK's own isAbortError guard in @ai-sdk/provider-utils.
    if (error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'ResponseAborted')) {
      // Attribute the abort before naming it. A caller cancel and an elapsed timeout both
      // arrive here as a DOMException, and reporting a cancel as `TimeoutError(timeoutMs)`
      // states a duration nobody measured for an event that did not occur — the operator
      // then raises the timeout, which cannot help, and a timeout-keyed retry policy
      // retries work the user asked to stop. `callerSignal.aborted` is the discriminator:
      // it is set only by cancel() or a consumer-supplied signal, never by the SDK's own
      // timeout signal, which is a separate object.
      if (callerSignal?.aborted) {
        const mapped = new CancelledError();
        mapped.cause = cause;
        return mapped;
      }
      // EXTERNAL-OK: an HTTP/SDK timeout handed straight to a client that validates its own options; it reaches
    // no arithmetic and no threshold in this package.
      const mapped = new TimeoutError(timeoutMs ?? this.config.timeout);
      mapped.cause = cause;
      return mapped;
    }

    const mapped = new SdkApiError(0, formatErrorMessage(error));
    mapped.cause = cause;
    return mapped;
  }
}

/**
 * The signal handed to `generateText`: the run timeout, the caller's cancellation, or both.
 *
 * `AbortSignal.any` is used rather than picking one, because they answer different
 * questions and both must remain live — a cancellable run still needs to time out, and a
 * run with a timeout still needs to be cancellable. The caller's signal is kept as its own
 * object (never merged into what `mapError` inspects) so an abort can be attributed:
 * `callerSignal.aborted` distinguishes a cancel from an elapsed timeout.
 */
function mergeAbortSignals(
  options: AIGenerateOptions,
  configTimeoutMs: number,
): AbortSignal | undefined {
  // Every request gets a timeout. There is no reachable path that installs none.
  //
  // This tested `options.timeoutMs ?` — truthiness — so a `0` was dropped and the request
  // ran with NO abort signal. `0` is the conventional Node spelling of "no timeout"
  // (`execFile` means exactly that), so it arrives by reasonable intent, and it arrived
  // through three public `??` chains that all preserved it. A provider that accepts the
  // connection and never answers then leaves this promise pending forever inside
  // `concurrencyLimiter.run`, whose `finally` never runs — so the Semaphore permit is never
  // released and every other agent in the process parks behind it. No error, no log, no
  // exit.
  //
  // AgentExecutor now clamps at its resolution site, but `generate()` is PUBLIC and
  // reachable without it, so falling back to `finitePositive` alone would leave a direct
  // caller with the same hang. The fallback is the operator's configured timeout, and if
  // that is unusable too, a conservative floor — an unusable configuration degrades to a
  // real bound, never to no bound.
  const ms = finitePositive(options.timeoutMs)
    ?? finitePositive(configTimeoutMs)
    ?? FALLBACK_REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(ms);
  const caller = options.abortSignal;
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

/** Last-resort request bound when neither the call nor the operator config supplies a usable
 *  one. Deliberately generous — it exists to stop an unbounded hang, not to cut work short. */
const FALLBACK_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Type guard for AI SDK's APICallError.
 *
 * Uses the SDK's own symbol-branded guard rather than `'statusCode' in error`.
 * The structural check false-positives on anything carrying a statusCode — core's
 * OWN SdkApiError, registry/HTTP client errors, any third-party error — and it also
 * matches an APICallError whose statusCode is `undefined` (the field is assigned
 * unconditionally in the constructor), yielding "Provider returned HTTP 0".
 * `isInstance` is brand-based, which is what makes it correct across the nine copies
 * of `ai` installed in this workspace, where `instanceof` would fail across realms.
 */
function isAPICallError(error: unknown): error is APICallError {
  return APICallError.isInstance(error);
}

/**
 * Type guard for AI SDK's RetryError.
 *
 * NOT `error.name === 'RetryError'` — the SDK prefixes every error name with `AI_`,
 * so the runtime value is `'AI_RetryError'` (verified live 2026-08-23). That check
 * never matched, which meant retry exhaustion never reached its branch and surfaced
 * as SdkApiError(0) instead of the underlying RateLimit/ServiceUnavailable cause.
 */
function isRetryError(error: unknown): error is RetryError {
  return RetryError.isInstance(error);
}
