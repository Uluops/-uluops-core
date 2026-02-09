/**
 * Base error class for all @uluops/core SDK errors
 */
export class UluOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UluOpsError';
  }
}
