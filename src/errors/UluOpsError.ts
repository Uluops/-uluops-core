/**
 * Error codes for all @uluops/core SDK errors.
 * Each subclass declares its own `code` as a readonly property.
 */
export const UluOpsErrorCodes = {
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  MAX_STEPS_EXHAUSTED: 'MAX_STEPS_EXHAUSTED',
  PREFLIGHT_ERROR: 'PREFLIGHT_ERROR',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  CAPABILITY_ERROR: 'CAPABILITY_ERROR',
  WORKFLOW_ERROR: 'WORKFLOW_ERROR',
  PIPELINE_ERROR: 'PIPELINE_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  INTEGRITY_ERROR: 'INTEGRITY_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type UluOpsErrorCode = typeof UluOpsErrorCodes[keyof typeof UluOpsErrorCodes];

/**
 * Base error class for all @uluops/core SDK errors.
 *
 * Supports the standard `cause` property (ES2022) for wrapping
 * underlying errors while preserving the original stack trace.
 */
export class UluOpsError extends Error {
  readonly code: string = 'UNKNOWN_ERROR';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UluOpsError';
  }

  /** Serialize error for network boundaries (thin-client, API responses). */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.cause ? { cause: String(this.cause) } : {}),
    };
  }
}
