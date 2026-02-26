import { UluOpsError } from './UluOpsError.js';

export { UluOpsError } from './UluOpsError.js';

/** Thrown when agent/command/workflow execution fails. May include a partial result. */
export class ExecutionError extends UluOpsError {
  constructor(
    message: string,
    public readonly partialResult?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecutionError';
  }
}

/** Thrown when a preflight check fails (e.g. missing env var, unavailable tool). */
export class PreflightError extends UluOpsError {
  constructor(
    message: string,
    public readonly check: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** Thrown when a definition's SHA-256 hash does not match the expected value. */
export class HashVerificationError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'HashVerificationError';
  }
}

/** Thrown when the SDK is misconfigured (missing API key, invalid provider, etc.). */
export class ConfigurationError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Thrown when a model alias cannot be resolved via the registry model catalog. */
export class ModelNotFoundError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

/** Thrown when a resolved model lacks a required capability (e.g. tools, vision, extendedThinking). */
export class CapabilityError extends UluOpsError {
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
  public readonly code?: ValidationErrorCode;

  constructor(message: string, code?: ValidationErrorCode) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

/** Thrown when a workflow phase gate fails. Includes partial results for completed phases. */
export class WorkflowError extends UluOpsError {
  constructor(
    message: string,
    public readonly context: { partialResult: unknown },
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/** Thrown when a pipeline stage fails or a pipeline-level error occurs. */
export class PipelineError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

/** Thrown when structured output cannot be extracted from an LLM response. */
export class ParseError extends UluOpsError {
  readonly contentPreview: string;

  constructor(message: string, contentPreview: string) {
    super(message);
    this.name = 'ParseError';
    this.contentPreview = contentPreview;
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
