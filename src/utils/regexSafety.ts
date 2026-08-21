/**
 * Guard against pathological, LLM/author-supplied regex patterns (CWE-1333
 * catastrophic backtracking) before compiling them. Shared by ToolHandler's
 * search_content (LLM-supplied) and StepsExecutor's expect_match
 * (definition-author-supplied) — both take a runtime-supplied pattern, so
 * both need the same heuristic guard rather than each re-spelling it.
 *
 * Not a substitute for safe-regex2 (devDependency, build-time gate on
 * statically-authored patterns only) — this is a cheap runtime heuristic for
 * patterns that arrive at execution time and can't go through that gate.
 */

/** Max pattern length. Patterns longer than this are rejected outright. */
export const MAX_REGEX_PATTERN_LENGTH = 200;

/**
 * Returns a human-readable rejection reason if `pattern` is too long or
 * matches a known catastrophic-backtracking shape, or `undefined` if it
 * passes the heuristic (a `try { new RegExp(...) }` compile check is still
 * required by the caller — this does not guarantee the pattern compiles).
 */
export function checkRegexPatternSafety(pattern: string): string | undefined {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `regex pattern too long (${pattern.length} chars, max ${MAX_REGEX_PATTERN_LENGTH})`;
  }

  // Nested quantifiers: (x+)+, (x*)+, (x+)*, (x{n,})+, ([...]+)+
  if (/(\([^)]*[+*][^)]*\))[+*]|\(\?:[^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    return 'regex pattern contains nested quantifiers which may cause catastrophic backtracking';
  }

  // Alternation explosion: (a|aa)+, (a|a?)+ — overlapping alternation under quantifier.
  // Conservative heuristic: any group with alternation followed by a quantifier.
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) {
    return 'regex pattern contains alternation under quantifier which may cause catastrophic backtracking';
  }

  return undefined;
}
