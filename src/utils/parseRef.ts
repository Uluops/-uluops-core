/**
 * Parse a definition reference string into name and optional version.
 *
 * Handles `name`, `name@version`, and edge cases like multiple `@` symbols
 * (only splits on the first `@`).
 *
 * @example parseRef('code-validator') → ['code-validator', undefined]
 * @example parseRef('code-validator@1.0.0') → ['code-validator', '1.0.0']
 */
export function parseRef(ref: string): [name: string, version: string | undefined] {
  const atIndex = ref.indexOf('@');
  if (atIndex === -1) return [ref, undefined];
  const version = ref.slice(atIndex + 1) || undefined;
  // 'latest' is a tag, not a semver version — treat as unversioned (resolve latest published)
  return [ref.slice(0, atIndex), version === 'latest' ? undefined : version];
}
