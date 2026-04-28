import { UluOpsError } from './UluOpsError.js';

export { UluOpsError, UluOpsErrorCodes, type UluOpsErrorCode } from './UluOpsError.js';

/** Thrown when agent/command/workflow execution fails. May include a partial result. */
export class ExecutionError extends UluOpsError {
  readonly code = 'EXECUTION_ERROR' as const;

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

/** Thrown when a preflight check fails (e.g. missing env var, unavailable tool). */
export class PreflightError extends UluOpsError {
  readonly code = 'PREFLIGHT_ERROR' as const;

  constructor(
    message: string,
    public readonly check: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
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
 * Error codes for validation service errors
 */
export const ValidationErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  REQUEST_FAILED: 'REQUEST_FAILED',
  SUBMISSION_FAILED: 'SUBMISSION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type ValidationErrorCode = typeof ValidationErrorCodes[keyof typeof ValidationErrorCodes];

/** Thrown when the validation service rejects a submission or returns an error. */
export class ValidationError extends UluOpsError {
  public readonly code: ValidationErrorCode;

  constructor(message: string, code?: ValidationErrorCode) {
    super(message);
    this.name = 'ValidationError';
    this.code = code ?? 'VALIDATION_ERROR';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code };
  }
}

/** Thrown when a workflow phase gate fails. Includes partial results for completed phases. */
export class WorkflowError extends UluOpsError {
  readonly code = 'WORKFLOW_ERROR' as const;

  constructor(
    message: string,
    public readonly context: { partialResult: unknown },
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
    public readonly context: { partialResult?: unknown; stageName?: string; stageIndex?: number },
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
} from '@uluops/sdk-core/errors';
