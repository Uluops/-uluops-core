/**
 * Extract a human-readable message from an unknown error value.
 * Safely handles Error instances, strings, and arbitrary objects.
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
