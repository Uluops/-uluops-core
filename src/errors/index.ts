import { UluOpsError, type UluOpsErrorCode } from './UluOpsError.js';
import type { ExecutionMetrics } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { CommandResult } from '../types/command.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineResult } from '../types/pipeline.js';

export { UluOpsError, UluOpsErrorCodes, type UluOpsErrorCode } from './UluOpsError.js';

/**
 * Result shapes that can appear as a partial-execution result somewhere in
 * this package's error contracts. No import cycle: nothing under `src/types/*`
 * imports from `../errors`, and type-only imports are erased at emit anyway.
 * `WorkflowError`/`PipelineError` use a member of this union in their typed
 * `context.partialResult`; `ExecutionError.partialResult` stays `unknown` —
 * see its doc comment for why.
 */
export type PartialExecutionResult = AgentResult | CommandResult | WorkflowResult | PipelineResult;

/** Structural shape of an SDK API error, independent of which copy minted it. */
export interface ApiErrorLike {
  statusCode: number;
  message: string;
  code?: string;
  requestId?: string;
}

/**
 * Identity-free check for an SDK API error.
 *
 * WHY THIS EXISTS, and why `instanceof` must NOT be used at these boundaries:
 * `@uluops/core` pins `@uluops/sdk-core` at an exact version and `@uluops/registry-sdk` pins a
 * DIFFERENT exact version. Two exact pins can never dedupe, so two copies of `SdkApiError` always
 * coexist and `error instanceof SdkApiError` is structurally false for anything registry-sdk threw
 * — silently disabling 402 -> SubscriptionRequiredError, 404 handling, and 401/403 entitlement
 * messaging. `isSdkApiError()` from sdk-core is itself `instanceof`-based and is equally unusable
 * here.
 *
 * Tests `statusCode` rather than `name`: a 402 arrives as base `SdkApiError` while a 404 arrives as
 * `NotFoundError`, so a name test would silently miss whole status classes. A plain `Error` has no
 * `statusCode` and is correctly rejected.
 *
 * Prefer this over `instanceof` for ANY error that crossed a package boundary.
 */
export function isApiErrorLike(error: unknown): error is ApiErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/**
 * Thrown when agent/command/workflow execution fails.
 *
 * `partialResult` is typed `unknown` deliberately, not a member of
 * {@link PartialExecutionResult}: no producer in this package populates it
 * today. All six construction sites pass a message only (AgentExecutor.ts
 * :530,:691; CommandExecutor.ts:76,:95,:192; ToolAdapter.ts:38), and
 * {@link MaxStepsExhaustedError} explicitly passes `undefined`. Callers must
 * not rely on this field being present — see {@link WorkflowError} and
 * {@link PipelineError} for the sibling fields that ARE populated.
 */
export class ExecutionError extends UluOpsError {
  // Typed as the broader code union (not the bare literal) so subclasses such as
  // MaxStepsExhaustedError can override with a more specific code.
  override readonly code: UluOpsErrorCode = 'EXECUTION_ERROR';

  constructor(
    message: string,
    public readonly partialResult?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecutionError';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ...(this.partialResult !== undefined ? { partialResult: this.partialResult } : {}) };
  }
}

/**
 * Thrown when an agent hits the maxSteps tool-loop ceiling while still mid-tool-call,
 * leaving empty model output. Distinguishes a genuinely-incomplete run from a crash:
 * without it, an exhausted run yields zero-length text that extraction maps to a
 * low-confidence default decision (typically FAIL), indistinguishable at the result
 * layer from a real failure. Extends ExecutionError so existing `catch (ExecutionError)`
 * handlers still catch it; callers can branch on `instanceof MaxStepsExhaustedError`
 * or `error.code === 'MAX_STEPS_EXHAUSTED'` to surface "raise maxSteps / narrow scope".
 */
/**
 * Identity-free check for a MaxStepsExhaustedError carrying billed metrics.
 *
 * `instanceof` is the wrong tool at this seam for the reason `isApiErrorLike` documents
 * above: this package can coexist with a second copy of itself in one dependency tree
 * (a consumer pinning a different `@uluops/core` alongside a transitive one), and two
 * copies mean two distinct class identities. `instanceof` then silently returns false and
 * the caller falls through to the "nothing known" branch — zeroing the ONE error in this
 * package that carries real money across a crash. The failure is silent, and it is
 * exactly the identity trap this module already warns about.
 *
 * Tests the stable `code` discriminant, which is a literal on the class and survives any
 * number of copies, plus the presence of the payload itself.
 */
export function hasBilledMetrics(
  error: unknown,
): error is { code: 'MAX_STEPS_EXHAUSTED'; billedMetrics: ExecutionMetricsLike } {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'MAX_STEPS_EXHAUSTED'
    && typeof (error as { billedMetrics?: unknown }).billedMetrics === 'object'
    && (error as { billedMetrics?: unknown }).billedMetrics !== null
  );
}

export class MaxStepsExhaustedError extends ExecutionError {
  override readonly code = 'MAX_STEPS_EXHAUSTED' as const;

  constructor(
    message: string,
    public readonly steps: number,
    public readonly finishReason: string,
    /**
     * Usage and cost that were ALREADY BILLED before the ceiling was hit.
     *
     * This error is thrown after a SUCCESSFUL generate() whose usage and costUsd are in
     * hand, and it used to carry only `steps` and `finishReason` — so the numbers were
     * discarded at the throw. Downstream rejection handlers then synthesized
     * `{inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0}` placeholders and
     * continued with them. A step-ceiling run is BY CONSTRUCTION the longest run the
     * engine produces — the maximum-cost class — so the money that vanished was the most
     * money there was to lose.
     *
     * Optional because the field must not force a fabricated value: a caller that does
     * not hold real metrics omits it, and downstream reads it as unknown rather than as
     * zero. Same polarity rule as sumCostUsd — absent is an admission, zero is a claim.
     */
    public readonly billedMetrics?: ExecutionMetricsLike,
    options?: ErrorOptions,
  ) {
    super(message, undefined, options);
    this.name = 'MaxStepsExhaustedError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      steps: this.steps,
      finishReason: this.finishReason,
      ...(this.billedMetrics ? { billedMetrics: this.billedMetrics } : {}),
    };
  }
}

/**
 * The execution-metrics shape errors may carry — DERIVED from `ExecutionMetrics`, not
 * re-declared.
 *
 * It was originally written out structurally, justified as keeping this module
 * dependency-free at the bottom of the import graph. **That justification was wrong**, in
 * a way worth recording: `types/execution.ts` imports nothing from here, and this file
 * already type-only-imports four sibling result types (see the imports above). There was
 * never a cycle to avoid, and type-only imports are erased at emit regardless.
 *
 * The duplicate had ALREADY drifted before it shipped — it omitted `harness?: string`,
 * which `ExecutionMetrics` declares. That is the whole argument against hand-maintained
 * structural copies: the copy silently stops describing the thing it copies, and nothing
 * fails. Deriving makes drift impossible rather than merely unlikely.
 */
export type ExecutionMetricsLike = ExecutionMetrics;

/** Thrown when a preflight check fails (e.g. missing env var, unavailable tool). */
export class PreflightError extends UluOpsError {
  readonly code = 'PREFLIGHT_ERROR' as const;

  constructor(
    message: string,
    public readonly check: string,
    public readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PreflightError';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), check: this.check, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Thrown when the SDK is misconfigured (missing API key, invalid provider, etc.). */
export class ConfigurationError extends UluOpsError {
  readonly code = 'CONFIGURATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Thrown when a model alias cannot be resolved via the registry model catalog. */
export class ModelNotFoundError extends UluOpsError {
  readonly code = 'MODEL_NOT_FOUND' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

/** Thrown when a resolved model lacks a required capability (e.g. tools, vision, extendedThinking). */
export class CapabilityError extends UluOpsError {
  readonly code = 'CAPABILITY_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

/**
 * Error codes for submission service errors
 */
export const SubmissionErrorCodes = {
  SUBMISSION_ERROR: 'SUBMISSION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  REQUEST_FAILED: 'REQUEST_FAILED',
  SUBMISSION_FAILED: 'SUBMISSION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type SubmissionErrorCode = typeof SubmissionErrorCodes[keyof typeof SubmissionErrorCodes];

/** Thrown when the submission service rejects a submission or returns an error. */
export class SubmissionError extends UluOpsError {
  public readonly code: SubmissionErrorCode;

  constructor(message: string, code?: SubmissionErrorCode) {
    super(message);
    this.name = 'SubmissionError';
    this.code = code ?? 'SUBMISSION_ERROR';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code };
  }
}

/**
 * Thrown when a workflow phase gate fails. Includes partial results for
 * completed phases.
 *
 * `context.partialResult` is heterogeneous across the five construction
 * sites in WorkflowExecutor.ts: the all-steps-failed path (:356) passes the
 * completed `CommandResult[]` directly; the outer catch (:99) passes
 * `buildPartialResult(...)`, which returns `Partial<WorkflowResult>` (it
 * omits required fields like `version`/`decision`/`score`/`metrics`, hence
 * `Partial`, not `WorkflowResult`); the remaining three sites (:441,:452,:627)
 * pass `undefined`. The field is therefore optional, matching those three.
 */
export class WorkflowError extends UluOpsError {
  readonly code = 'WORKFLOW_ERROR' as const;

  constructor(
    message: string,
    public readonly context: { partialResult?: Partial<WorkflowResult> | CommandResult[] },
  ) {
    super(message);
    this.name = 'WorkflowError';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), context: this.context };
  }
}

/** Thrown when a pipeline stage fails or a pipeline-level error occurs. */
export class PipelineError extends UluOpsError {
  readonly code = 'PIPELINE_ERROR' as const;

  constructor(
    message: string,
    public readonly context: { partialResult?: PipelineResult; stageName?: string; stageIndex?: number },
  ) {
    super(message);
    this.name = 'PipelineError';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), context: this.context };
  }
}

/**
 * Thrown when a definition requires a higher subscription tier than the user has.
 * The registry returned metadata but withheld content (yaml=null, proRestricted=true).
 */
export class SubscriptionRequiredError extends UluOpsError {
  readonly code = 'SUBSCRIPTION_REQUIRED' as const;

  private static readonly TIER_ORDER: Record<string, number> = {
    free: 0, hobbyist: 1, plus: 2, pro: 3, enterprise: 4,
  };

  constructor(
    message: string,
    public readonly requiredTier: string,
    public readonly currentTier: string,
    public readonly definition?: { type: string; name: string; displayName?: string },
    public readonly upgradeUrl?: string,
  ) {
    super(message);
    this.name = 'SubscriptionRequiredError';
  }

  /** Tier comparison metadata for rendering upgrade prompts */
  get tierComparison(): { current: string; required: string; gap: number } {
    const currentOrder = SubscriptionRequiredError.TIER_ORDER[this.currentTier] ?? 0;
    const requiredOrder = SubscriptionRequiredError.TIER_ORDER[this.requiredTier] ?? 0;
    return { current: this.currentTier, required: this.requiredTier, gap: requiredOrder - currentOrder };
  }

  /** Upgrade URL with source tracking appended */
  trackedUpgradeUrl(source: 'sdk' | 'mcp' | 'cli' | 'api'): string | undefined {
    if (!this.upgradeUrl) return undefined;
    const sep = this.upgradeUrl.includes('?') ? '&' : '?';
    return `${this.upgradeUrl}${sep}source=${source}`;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      requiredTier: this.requiredTier,
      currentTier: this.currentTier,
      tierComparison: this.tierComparison,
      ...(this.definition ? { definition: this.definition } : {}),
      ...(this.upgradeUrl ? { upgradeUrl: this.upgradeUrl } : {}),
    };
  }
}

/** Thrown when structured output cannot be extracted from an LLM response. */
export class ParseError extends UluOpsError {
  readonly code = 'PARSE_ERROR' as const;
  readonly contentPreview: string;

  constructor(message: string, contentPreview: string) {
    super(message);
    this.name = 'ParseError';
    this.contentPreview = contentPreview;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), contentPreview: this.contentPreview };
  }
}

/**
 * Thrown when a caller-pinned integrity check fails at resolve time.
 *
 * Fail-closed: execution is refused rather than proceeding with unverified
 * bytes. `kind` distinguishes the three failure modes:
 *  - `yaml`        — `computeHash(resolved.yaml)` ≠ the pinned `expectedHash`
 *  - `prompt`      — `computePromptHash(resolved.runtime.prompt)` ≠ the pinned `expectedPromptHash`
 *  - `unavailable` — a prompt pin was supplied but there is no rendered prompt to
 *                    verify (WDL/PDL, content-gated, local, or schema-stale). Never a silent pass.
 */
export class IntegrityError extends UluOpsError {
  readonly code = 'INTEGRITY_ERROR' as const;

  constructor(
    message: string,
    public readonly kind: 'yaml' | 'prompt' | 'unavailable',
    public readonly definitionName: string,
    public readonly definitionVersion: string,
    public readonly expected?: string,
    public readonly actual?: string,
  ) {
    super(message);
    this.name = 'IntegrityError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      kind: this.kind,
      definitionName: this.definitionName,
      definitionVersion: this.definitionVersion,
      ...(this.expected !== undefined ? { expected: this.expected } : {}),
      ...(this.actual !== undefined ? { actual: this.actual } : {}),
    };
  }
}

// Re-exports from @uluops/sdk-core
export {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
  // ValidationError (400) extends SdkApiError, not UluOpsError — re-exported so
  // consumers can instanceof-check runtime 400s through this package (issue
  // 309875ff). Config-time key validation no longer reaches it: resolveConfig
  // mirrors sdk-core's checks and throws ConfigurationError at the boundary.
  ValidationError,
  isValidationError,
} from '@uluops/sdk-core/errors';
