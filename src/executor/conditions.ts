/**
 * Condition-expression evaluation for PDL stages and inline agents
 * (pdl-steps-execution-spec-v0_1_1 Phase 3 / D5).
 *
 * Grammar (deliberately small — no parentheses, no arithmetic):
 *
 *   expr        := andExpr ('||' andExpr)*
 *   andExpr     := term ('&&' term)*
 *   term        := '!'* (comparison | path)
 *   comparison  := path op literal
 *   op          := '==' | '!=' | '>=' | '<=' | '>' | '<'
 *   literal     := 'str' | "str" | number | true | false
 *                  (string literals are NON-ESCAPABLE — there is no backslash
 *                  escape; to embed one quote style, use the other)
 *   path        := params.<name> | params['<name>']
 *              | stages.<id>.steps['<name>'].<field>
 *              | stages.<id>.<field>
 *              | <id>.<field>                       (legacy, pre-Phase-3 form)
 *
 * Evaluation is THREE-VALUED (Kleene): true / false / null-unknown. A stage or
 * step path that cannot be resolved (missing stage, or an unsupported
 * namespace such as the PDL spec's `trigger.`/`context.` families) yields
 * unknown, which propagates: unknown || true == true, unknown && false ==
 * false, otherwise unknown survives to the top. Callers treat a top-level
 * unknown as FAIL-OPEN (run the stage/agent, warn) — flipping to fail-closed
 * is a corpus-audited decision deferred to PDL v1.3.0 (spec OQ3).
 *
 * EXCEPTION — the params namespace (spec D5 amendment, live-test finding
 * e9399a31): an ABSENT param is a value, not an unknown. Bare `params.x` with
 * x unset is false, `!params.x` is true, `== literal` is false, `!= literal`
 * is true; only ordering comparators over an absent param stay unknown.
 * Absence of a param is a normal caller state (the corpus gates agents with
 * `params.frontend || <detect>` expecting absent→false); absence of a stage
 * path is a typo signal, where running-anyway is the safety property.
 */

import type { StageResult } from '../types/pipeline.js';

export interface ConditionContext {
  /** Results of stages completed so far (in execution order). */
  stages: StageResult[];
  /** Caller-supplied run parameters (ExecutionInput.params). */
  params?: Record<string, string | number | boolean>;
}

/** true / false / null = unknown (unresolvable path or unparseable term). */
export type ConditionVerdict = boolean | null;

/** Expressions longer than this are rejected as unknown (fail-open) before
 *  any regex runs. Condition strings are definition-controlled and evaluated
 *  WITHOUT any opt-in, so their processing cost must be hard-bounded
 *  (security review: reachable quadratic backtracking, CWE-1333/400).
 *  512 chars is ~4x the longest corpus condition. */
export const MAX_CONDITION_LENGTH = 512;

// REGEX SAFETY: no quantifier here competes with an adjacent quantifier over
// an overlapping character set — the lazy path capture (.+?) abuts the
// operator alternation directly (whitespace before the operator lands in the
// capture and is trimmed by the caller). The earlier `(.+?)\s*(==|…)` shape
// backtracked quadratically on long whitespace runs. All four patterns are
// covered by test/executor/regex-safety.test.ts (safe-regex2 + timing).
export const COMPARISON_RE =
  /^(.+?)(==|!=|>=|<=|>|<)\s*(?:'([^']*)'|"([^"]*)"|(-?\d+\.\d+|-?\d+)|(true|false))$/;

export const PARAMS_PATH_RE = /^params(?:\.([\w-]+)|\['([^']+)'\]|\["([^"]+)"\])$/;

export const STEPS_PATH_RE =
  /^(?:stages\.|stage\.)([\w-]+)\.steps\[(?:'([^']+)'|"([^"]+)")\]\.([\w]+)$/;

export const STAGE_FIELD_RE = /^(?:stages\.|stage\.)?([\w-]+)\.([\w]+)$/;

/** Split on a delimiter at top level only (never inside quoted strings). */
function splitTopLevel(expr: string, delimiter: '||' | '&&'): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === delimiter[0] && expr[i + 1] === delimiter[1]) {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(p => p.trim());
}

function resolvePath(path: string, ctx: ConditionContext): unknown {
  const paramsMatch = PARAMS_PATH_RE.exec(path);
  if (paramsMatch) {
    // Mandatory alternation: exactly one of groups 1-3 is defined iff exec matched.
    const name = paramsMatch[1] ?? paramsMatch[2] ?? paramsMatch[3]!;
    return ctx.params?.[name];
  }

  const stepsMatch = STEPS_PATH_RE.exec(path);
  if (stepsMatch) {
    const [, stageId, name1, name2, field] = stepsMatch;
    const stage = ctx.stages.find(s => s.id === stageId);
    const step = stage?.steps?.find(s => s.name === (name1 ?? name2));
    if (!step) return undefined;
    return getField(step, field!);
  }

  const stageMatch = STAGE_FIELD_RE.exec(path);
  if (stageMatch) {
    const [, stageId, field] = stageMatch;
    const stage = ctx.stages.find(s => s.id === stageId);
    if (!stage) return undefined;
    // Prefer the inner result (score, decision, ...), fall back to the
    // StageResult envelope (status, durationMs).
    const fromResult = stage.result ? getField(stage.result, field!) : undefined;
    if (fromResult !== undefined) return fromResult;
    return getField(stage, field!);
  }

  return undefined;
}

/**
 * Dynamic field access on internally-produced objects (StepResult,
 * CommandResult/WorkflowResult, StageResult). SAFETY: single type-erasing
 * cast to an unknown-valued record — no concrete structure is fabricated,
 * and every caller narrows the result through truthy()/String()/Number().
 * (Restores the single-assertion discipline of the pre-Phase-3 getField.)
 */
function getField(obj: object, field: string): unknown {
  if (!(field in obj)) return undefined;
  return (obj as Record<string, unknown>)[field];
}

function truthy(value: unknown): ConditionVerdict {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== 'false';
  return null;
}

function evaluateTerm(term: string, ctx: ConditionContext): ConditionVerdict {
  // Unary negation: !unknown stays unknown.
  let negations = 0;
  let rest = term;
  while (rest.startsWith('!')) {
    negations++;
    rest = rest.slice(1).trim();
  }
  const negate = (v: ConditionVerdict): ConditionVerdict =>
    v === null ? null : (negations % 2 === 1 ? !v : v);

  const cmp = COMPARISON_RE.exec(rest);
  if (cmp) {
    // Non-null assertions here are regex invariants: path (group 1) and op
    // (group 2) are mandatory captures, and exactly one literal alternative
    // (str1/str2/num/bool) is defined iff exec matched.
    const [, pathRaw, op, str1, str2, num, bool] = cmp;
    const path = pathRaw!.trim();
    const actual = resolvePath(path, ctx);
    if (actual === undefined || actual === null) {
      // D5 amendment: within the params namespace, ABSENCE IS A VALUE, not an
      // unknown — an unset param equals no literal (== false, != true).
      // Stage/step path absence stays unknown: there it signals a typo or a
      // missing stage, where fail-open is the safety property. Ordering over
      // an absent param remains ill-formed (unknown).
      if (PARAMS_PATH_RE.test(path)) {
        if (op === '==') return negate(false);
        if (op === '!=') return negate(true);
      }
      return null;
    }
    const expected: string | number | boolean =
      num !== undefined ? Number(num)
      : bool !== undefined ? bool === 'true'
      : (str1 ?? str2)!;
    // Ordering comparators over a non-numeric operand are ill-formed: yield
    // unknown (fail-open) rather than NaN-comparison false — a false verdict
    // under run-gate semantics would silently SKIP the stage on a typo.
    if (op !== '==' && op !== '!=') {
      const a = Number(actual);
      const e = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(e)) return null;
      switch (op) {
        case '>=': return negate(a >= e);
        case '<=': return negate(a <= e);
        case '>':  return negate(a > e);
        case '<':  return negate(a < e);
      }
    }
    switch (op) {
      case '==': return negate(String(actual) === String(expected));
      case '!=': return negate(String(actual) !== String(expected));
    }
  }

  // Bare path truthiness (params.frontend, stages.deploy.failed).
  // D5 amendment: an absent param is false (so !params.x is true) — the
  // corpus idiom `params.frontend || <detect>` expects absent→false, and the
  // harness path reads unset params the same way. Stage/step absence → unknown.
  if (PARAMS_PATH_RE.test(rest)) {
    return negate(truthy(resolvePath(rest, ctx)) ?? false);
  }
  if (STEPS_PATH_RE.test(rest) || STAGE_FIELD_RE.test(rest)) {
    return negate(truthy(resolvePath(rest, ctx)));
  }

  // Bare boolean literals (degenerate but legal).
  if (rest === 'true') return negate(true);
  if (rest === 'false') return negate(false);

  return null;
}

/**
 * Evaluate a condition expression against completed stages and run params.
 * Returns true / false, or null when the expression is unparseable or a
 * needed path is unresolvable — the caller decides fail-open vs fail-closed.
 */
export function evaluateConditionExpr(expr: string, ctx: ConditionContext): ConditionVerdict {
  if (expr.length > MAX_CONDITION_LENGTH) return null;
  const trimmed = expr.trim();
  if (!trimmed) return null;

  // Kleene OR over Kleene ANDs.
  let orVerdict: ConditionVerdict = false;
  for (const orPart of splitTopLevel(trimmed, '||')) {
    let andVerdict: ConditionVerdict = true;
    for (const andPart of splitTopLevel(orPart, '&&')) {
      const v = evaluateTerm(andPart, ctx);
      if (v === false) { andVerdict = false; break; }
      if (v === null) andVerdict = null;
    }
    if (andVerdict === true) return true;
    if (andVerdict === null) orVerdict = null;
  }
  return orVerdict;
}
