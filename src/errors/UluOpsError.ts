/**
 * Base error class for all @uluops/core SDK errors.
 *
 * Supports the standard `cause` property (ES2022) for wrapping
 * underlying errors while preserving the original stack trace.
 */
export class UluOpsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UluOpsError';
  }
}
