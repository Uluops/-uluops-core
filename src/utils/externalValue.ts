/**
 * The single validating boundary for values that arrive from OUTSIDE this package.
 *
 * ─── Why this module exists, and why it is organised by PROVENANCE ──────────────────────
 *
 * The 0.42.0 cycle spent six audit passes on one defect class: *an external value is read
 * without validation and produces a number nobody measured, or a state that never
 * happened.* Every pass found it one region further out than the last, because every fix
 * was applied at the citations that pass had reported:
 *
 *   pass 1-2  provider payloads in AIProvider
 *   pass 3    the same, at the submission and executor boundaries
 *   pass 4    the same, in TokenBudgetTracker
 *   pass 5    model tool arguments (shellExecutor) and authored config (aggregateScores,
 *             contextBudget)  ->  produced clampModelBound, usableWeight, usableBudget
 *   pass 6    model tool arguments in ToolHandler, authored step bounds in StepsExecutor,
 *             a second raw reader of contextBudget in AIProvider
 *
 * Pass 6 diagnosed the reason precisely, and it applies to the guard as much as to the
 * code: the static check written after pass 5 enumerated by FIELD NAME, and was extended
 * with exactly the four names pass 5 had cited (`timeoutMs`, `maxOutputLength`, `weight`,
 * `budget`). `max_results`, `start_line`, `max_depth`, `context_lines`, `step.timeout` and
 * `step.retries` were never in view — not judged safe, just never met.
 *
 * **A field-name list is an OPEN set.** It grows every time someone names a variable, so
 * enumerating it cannot terminate. **Provenance is a CLOSED set.** There are finitely many
 * ways data enters this package, and they can be counted:
 *
 *   1. model tool-call arguments        (ToolHandler)
 *   2. authored YAML definitions        (RegistryClient -> executors)
 *   3. JSON.parse of external payloads  (OutputExtractor, AnalysisSummaryExtractor)
 *   4. process.env                      (config resolution)
 *   5. registry / AI-SDK responses      (ModelCatalog, AIProvider)
 *   6. public API arguments             (a library consumer is outside this package)
 *
 * That list is checkable and finite, which is the whole point: this module can be complete
 * in a way the name list never could be.
 *
 * ─── Why ONE module rather than a fourth helper ─────────────────────────────────────────
 *
 * `clampModelBound`, `usableWeight` and `usableBudget` were written on three different
 * passes for three different citations, and their existence as a trio IS the citation
 * pattern in miniature — three implementations of one idea, each correct, none aware of
 * the others, each one a place the next reviewer has to check separately. They now derive
 * from `finitePositive` below rather than restating it. Adding a fourth would have been
 * the seventh repetition of the mistake.
 *
 * ─── The contract ───────────────────────────────────────────────────────────────────────
 *
 * `typeof x === 'number'` is a TYPE narrow, not a VALUE validation. It admits `NaN`,
 * `Infinity`, negatives and non-integers, every one of which has produced a measured defect
 * in this package:
 *
 *   NaN       a command that never ran, reported as a result (`retries: .nan`)
 *   Infinity  a search ceiling removed entirely (`max_results`)
 *   negative  "and 8 more files" in a directory of seven
 *   0         an operator timeout disabled and the run reported `exitCode: 0`
 *   non-int   "and 5.5 more files"
 *
 * So every function here answers "is this value USABLE", never "is this value a number".
 */

/**
 * The primitive. A finite number strictly greater than zero, or `undefined`.
 *
 * `undefined` means "no usable value", deliberately — not zero. Absent and zero are
 * different facts, and collapsing them is the other half of this same defect class.
 */
export function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A finite number at or above zero, or `undefined`.
 *
 * Distinct from {@link finitePositive} because some bounds legitimately accept zero —
 * `context_lines: 0` means "no surrounding context", which is a real request, not a
 * malformed one. Using the wrong one of these two silently changes a tool's contract.
 */
export function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read an INTEGER bound supplied by an untrusted source, clamped into an allowed range.
 *
 * This is the workhorse for model tool arguments and authored definition values. It is
 * bounded on BOTH sides on purpose: `Math.min(x ?? d, d)` is a ceiling with no floor, and
 * the smallest legal value defeats it — that is exactly how `timeoutMs: 0` disabled an
 * operator shell timeout and how `max_results: 0` made a search report "no matches" for a
 * search it never performed.
 *
 * Non-integers fall back rather than being rounded: a fractional `max_results` produced the
 * user-visible text "and 5.5 more files", and silently flooring it would hide that the
 * caller sent something meaningless.
 *
 * @param value    the untrusted value, as received
 * @param min      smallest meaningful value (often 0 or 1 — choose deliberately)
 * @param max      the operator/system ceiling; the caller can never exceed it
 * @param fallback used when `value` is absent or unusable; must itself be within [min, max]
 */
export function externalInt(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return clampToRange(fallback, min, max);
  }
  return clampToRange(value, min, max);
}

/** Bound a known-finite number into [min, max]. */
function clampToRange(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Coerce EXTERNAL TEXT to a finite number, or `undefined`.
 *
 * For values parsed out of model prose, wire strings, env vars and authored conditions —
 * anywhere `parseFloat` / `parseInt` / `Number()` is applied to something this package did
 * not produce.
 *
 * **`parseFloat('Infinity')` and `Number('Infinity')` both return `Infinity`**, and the
 * common `!isNaN(...)` guard passes it — measured:
 *
 *     parseFloat("Infinity")  -> Infinity
 *     Number("Infinity")      -> Infinity
 *     !isNaN(Number("Infinity")) === true      <- the guard that was supposed to catch it
 *
 * A model writing "Score: Infinity" in prose therefore produced an `Infinity` score on the
 * text-extraction path, and `Infinity < threshold` is `false`, so the gate PASSES. That is
 * the same fail-open as the NaN weight and the unconstrained zod schema, arriving through a
 * third channel — which is the whole reason this module is organised by provenance.
 *
 * (`parseInt('Infinity', 10)` happens to yield NaN, so that one form was already safe. The
 * safety was accidental, not designed, and did not extend to its two siblings.)
 */
export function parseExternalNumber(text: unknown): number | undefined {
  if (typeof text === 'number') return Number.isFinite(text) ? text : undefined;
  if (typeof text !== 'string') return undefined;
  // EXTERNAL-OK: this IS the seam. The finiteness check on the next line is the validation
  // every other site delegates here for — flagging it would be the instrument reporting its
  // own implementation.
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Clamp a bound supplied by the MODEL into the operator's allowed range.
 *
 * Kept as a named export because the call sites read better in their own vocabulary, but it
 * now derives from {@link externalInt} rather than restating the rule. A value the model did
 * not supply, or supplied unusably, falls back to the operator default; a usable one is
 * bounded on both sides and can only ever LOWER the ceiling.
 *
 * Measured before this existed: with the operator ceiling at 2,000 ms, a model omitting the
 * field had its 5-second command killed at 2,004 ms; a model sending `timeoutMs: 0` ran the
 * full 5,011 ms to completion and reported a clean `exitCode: 0`.
 */
export function clampModelBound(supplied: number | undefined, operatorDefault: number): number {
  return externalInt(supplied, { min: 1, max: operatorDefault, fallback: operatorDefault });
}

/**
 * Validate an AUTHORED (definition YAML/JSON) scoring weight.
 *
 * Degrades to the neutral weight `1` — the same weight an unlisted key already receives —
 * so one malformed entry costs the weighting rather than poisoning the aggregate.
 *
 * Measured before this existed, with true scores of 90 and 95 aggregating to 93 unweighted:
 * a `NaN` weight reported **0**, failing every gate; an `Infinity` weight produced **NaN**,
 * and because `NaN < threshold` is `false` the gate **passed** a run with no valid score.
 * YAML makes `.nan` and `.inf` directly authorable.
 */
export function usableWeight(authored: unknown): number {
  return finitePositive(authored) ?? 1;
}

/**
 * Validate a context budget from operator CONFIG.
 *
 * Returns `undefined` for anything unusable so the caller can fall through to a real
 * default, rather than operating on a meaningless number. Measured before this existed:
 * `0` latched the wrap-up brake on step 1 so the agent could never call a tool, and `NaN`
 * made every threshold comparison false — leaving the brake silently inert with no
 * degradation marker, which is the precise gap `budget.brake-inert` was added to close.
 */
export function usableBudget(value: unknown): number | undefined {
  return finitePositive(value);
}
