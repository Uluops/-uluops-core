import { UluOpsError } from './UluOpsError.js';

export { UluOpsError } from './UluOpsError.js';

/** Thrown when agent/command/workflow execution fails. May include a partial result. */
export class ExecutionError extends UluOpsError {
  constructor(
    message: string,
    public readonly partialResult?: unknown
  ) {
    super(message);
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

export class ConfigurationError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class ModelNotFoundError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

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

export class ValidationError extends UluOpsError {
  public readonly code?: ValidationErrorCode;

  constructor(message: string, code?: ValidationErrorCode) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export class WorkflowError extends UluOpsError {
  constructor(
    message: string,
    public readonly context: { partialResult: unknown }
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export class PipelineError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * Parse error - failed to extract structured output from response
 */
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
