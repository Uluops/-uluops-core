/**
 * The PDL 1.6.0 condition language: parser and evaluator for stage and `agentRef` conditions
 * (build unit P3b).
 *
 * Normative source: `uluops-pdl-spec-v1.6.0.md`, Execution Semantics → The condition language.
 * Design record: pdl-1_6_0 spec §3.4, decisions D2 (three roots, total), D4 (a runtime error is an
 * interpreter defect), D25 (legacy forms removed), D36 (`!` placement), D40 (no control character in
 * a literal), D41 (the bound counts code points). The conformance fixtures
 * (`test/fixtures/pdl-conformance/`, `conditions/*` and the condition `load-errors/*`) are the oracle.
 *
 * The grammar (EBNF, from the spec):
 *
 *   condition = or-expr ;                       (at most 512 code points)
 *   or-expr   = and-expr , { "||" , and-expr } ;
 *   and-expr  = unary , { "&&" , unary } ;
 *   unary     = "!" , negand | atom ;
 *   negand    = reference | "(" , or-expr , ")" ;
 *   atom      = reference , [ ( "==" | "!=" ) , string ] | "(" , or-expr , ")" ;
 *   reference = segment , { "." , segment | "[" , string , "]" } ;
 *   segment   = letter , { letter | digit | "_" | "-" } ;
 *   string    = "'" , { not "'" } , "'" | '"' , { not '"' } , '"' ;
 *
 * A reference resolves against exactly three roots: `params.<name>`, `stages.<id>.passed` and
 * `stages.<id>.steps['<name>'].output`.
 *
 * What changed from the pre-1.6.0 evaluator, each a stated upgrade impact (spec §6 items 5, 26,
 * 31, 32): ordering operators, number and boolean literals, any `stages.<id>.<field>` other than
 * `passed`, the `stage.` prefix and the bare `<id>.<field>` form are syntax errors or unknown roots;
 * parentheses parse; the string `0` is falsy; `!params.a == 'x'` and `!!x` are syntax errors. The
 * old evaluator returned "unknown" for anything it could not read and the stage ran (fail-open);
 * now the load validator (`pipelineLoad.ts`) refuses such a condition before anything launches,
 * and the evaluator is total.
 *
 * The parser is a port of the factory's (`@uluops/definition-factory`, `src/parser/pdl-conditions.ts`),
 * extended to build the tree the evaluator walks. Both are held to the same fixtures; a fix to one
 * is a fix to the other. Linear time: one tokenizing pass and a recursive-descent parse over at most
 * 512 code points, checked before any work is done (CWE-1333 discipline; this module uses no
 * backtracking regex on the condition).
 */

import type { StageResult } from '../types/pipeline.js';

/** Conditions over this many CODE POINTS are refused before tokenizing (D41). */
export const MAX_CONDITION_LENGTH = 512;

/** Length in code points, the unit the JSON schema's `maxLength` counts (D41). */
export function conditionLength(src: string): number {
  return [...src].length;
}

/**
 * Characters a string literal may not hold (D40): C0 controls (tab, newline included), DEL, C1
 * controls, U+2028 and U+2029.
 */
const LITERAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Whole-condition faults, checked before any reference. */
export type ConditionParseCode = 'condition_too_long' | 'condition_syntax';

/** Per-reference faults this module can classify. */
export type ReferenceFaultCode = 'unknown_root' | 'unknown_path';

/** A reference that resolved to one of the three roots. */
export type ConditionRef =
  | { kind: 'param'; name: string }
  | { kind: 'passed'; stage: string }
  | { kind: 'step'; stage: string; step: string };

/** A reference that did not resolve to a root. */
export interface ReferenceFault { kind: 'fault'; code: ReferenceFaultCode; message: string }

/** The parsed condition. */
export type ConditionNode =
  | { k: 'or' | 'and'; l: ConditionNode; r: ConditionNode }
  | { k: 'not'; e: ConditionNode }
  | { k: 'cmp'; ref: ConditionRef | ReferenceFault; op: '==' | '!='; lit: string }
  | { k: 'ref'; ref: ConditionRef | ReferenceFault };

/**
 * `refs` is in source order and may hold faults: the spec runs every check on one reference
 * (root, path, declaration, ancestry, step) before the next, so the load validator, which holds
 * the context for the later checks, walks this list and stops at the first fault.
 */
export type ConditionParseResult =
  | { ok: true; tree: ConditionNode; refs: Array<ConditionRef | ReferenceFault> }
  | { ok: false; code: ConditionParseCode; message: string };

/** `ws`: whitespace came right before this token (whitespace may not appear inside a reference). */
type Token =
  | { t: 'op'; v: '||' | '&&' | '==' | '!=' | '!' | '(' | ')' | '[' | ']' | '.'; ws: boolean }
  | { t: 'str'; v: string; ws: boolean }
  | { t: 'id'; v: string; ws: boolean };

type RawSegment = { kind: 'seg'; v: string } | { kind: 'key'; v: string };

class SyntaxFault extends Error {}

const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let ws = false;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; ws = true; continue; }
    const two = src.slice(i, i + 2);
    if (two === '||' || two === '&&' || two === '==' || two === '!=') { out.push({ t: 'op', v: two, ws }); i += 2; ws = false; continue; }
    if (c === '!' || c === '(' || c === ')' || c === '[' || c === ']' || c === '.') { out.push({ t: 'op', v: c, ws }); i++; ws = false; continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new SyntaxFault('unterminated string literal');
      if (LITERAL_CONTROL.test(src.slice(i + 1, end))) throw new SyntaxFault('a string literal may not contain a control character (D40)');
      out.push({ t: 'str', v: src.slice(i + 1, end), ws });
      ws = false;
      i = end + 1;
      continue;
    }
    if (isLetter(c)) {
      let j = i + 1;
      while (j < src.length && (isLetter(src[j]!) || isDigit(src[j]!) || src[j] === '_' || src[j] === '-')) j++;
      out.push({ t: 'id', v: src.slice(i, j), ws });
      i = j;
      ws = false;
      continue;
    }
    // digits (number literals), `=`, `<`, `>`, and anything else
    throw new SyntaxFault(`unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

/** Classify one syntactically valid reference against the three roots. */
function classify(segs: RawSegment[]): ConditionRef | ReferenceFault {
  const [root, ...rest] = segs;
  const shown = segs.map((s, n) => (s.kind === 'key' ? `['${s.v}']` : (n ? '.' : '') + s.v)).join('');
  if (root!.kind !== 'seg' || (root!.v !== 'params' && root!.v !== 'stages')) {
    return { kind: 'fault', code: 'unknown_root', message: `"${shown}": a condition reads only params.*, stages.<id>.passed and stages.<id>.steps['<name>'].output` };
  }
  if (root!.v === 'params') {
    if (rest.length === 1) return { kind: 'param', name: rest[0]!.v };
    return { kind: 'fault', code: 'unknown_path', message: `"${shown}": write params.<name> or params['<name>']` };
  }
  const [id, a, b, c] = rest;
  if (rest.length === 2 && id?.kind === 'seg' && a?.kind === 'seg' && a.v === 'passed') {
    return { kind: 'passed', stage: id.v };
  }
  if (rest.length === 4 && id?.kind === 'seg' && a?.kind === 'seg' && a.v === 'steps' && b?.kind === 'key' && c?.kind === 'seg' && c.v === 'output') {
    return { kind: 'step', stage: id.v, step: b.v };
  }
  return { kind: 'fault', code: 'unknown_path', message: `"${shown}": a stage reference is stages.<id>.passed or stages.<id>.steps['<name>'].output` };
}

class Parser {
  private i = 0;
  readonly refs: Array<ConditionRef | ReferenceFault> = [];
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined { return this.toks[this.i]; }
  private isOp(v: string): boolean { const k = this.peek(); return k?.t === 'op' && k.v === v; }
  private expectOp(v: string): void {
    if (!this.isOp(v)) throw new SyntaxFault(`expected ${JSON.stringify(v)}`);
    this.i++;
  }

  parse(): ConditionNode {
    if (this.toks.length === 0) throw new SyntaxFault('empty condition');
    const tree = this.orExpr();
    if (this.i !== this.toks.length) throw new SyntaxFault(`unexpected ${JSON.stringify(this.peek()!.v)}`);
    return tree;
  }

  private orExpr(): ConditionNode {
    let l = this.andExpr();
    while (this.isOp('||')) { this.i++; l = { k: 'or', l, r: this.andExpr() }; }
    return l;
  }

  private andExpr(): ConditionNode {
    let l = this.unary();
    while (this.isOp('&&')) { this.i++; l = { k: 'and', l, r: this.unary() }; }
    return l;
  }

  private group(): ConditionNode {
    this.expectOp('(');
    const e = this.orExpr();
    this.expectOp(')');
    return e;
  }

  private unary(): ConditionNode {
    if (this.isOp('!')) {
      this.i++;
      // D36: `!` precedes only a reference or a parenthesised expression.
      if (this.isOp('(')) return { k: 'not', e: this.group() };
      return { k: 'not', e: { k: 'ref', ref: this.reference() } };
    }
    return this.atom();
  }

  private atom(): ConditionNode {
    if (this.isOp('(')) return this.group();
    const ref = this.reference();
    if (this.isOp('==') || this.isOp('!=')) {
      const op = (this.peek() as { v: '==' | '!=' }).v;
      this.i++;
      const k = this.peek();
      if (k?.t !== 'str') throw new SyntaxFault('a comparison needs a string literal on the right');
      this.i++;
      return { k: 'cmp', ref, op, lit: k.v };
    }
    return { k: 'ref', ref };
  }

  private reference(): ConditionRef | ReferenceFault {
    const first = this.peek();
    if (first?.t !== 'id') throw new SyntaxFault('expected a reference');
    this.i++;
    const segs: RawSegment[] = [{ kind: 'seg', v: first.v }];
    for (;;) {
      const next = this.peek();
      if (next?.ws && (this.isOp('.') || this.isOp('['))) throw new SyntaxFault('whitespace inside a reference');
      if (this.isOp('.')) {
        this.i++;
        const k = this.peek();
        if (k?.t !== 'id' || k.ws) throw new SyntaxFault('expected a segment right after "."');
        this.i++;
        segs.push({ kind: 'seg', v: k.v });
      } else if (this.isOp('[')) {
        this.i++;
        const k = this.peek();
        if (k?.t !== 'str' || k.ws) throw new SyntaxFault('expected a quoted key right after "["');
        this.i++;
        if (this.peek()?.ws) throw new SyntaxFault('whitespace inside a reference');
        this.expectOp(']');
        segs.push({ kind: 'key', v: k.v });
      } else break;
    }
    if (segs.length === 1 && (segs[0]!.v === 'true' || segs[0]!.v === 'false')) {
      throw new SyntaxFault('boolean literals are not part of the condition language');
    }
    const ref = classify(segs);
    this.refs.push(ref);
    return ref;
  }
}

/**
 * Parse a condition and classify its references. A whole-condition fault (length, then syntax) is
 * returned as `ok: false`; reference faults ride in `refs` (and in the tree), in source order.
 */
export function parseCondition(src: string): ConditionParseResult {
  const length = conditionLength(src);
  if (length > MAX_CONDITION_LENGTH) {
    return { ok: false, code: 'condition_too_long', message: `condition is ${length} code points; the limit is ${MAX_CONDITION_LENGTH}` };
  }
  try {
    const parser = new Parser(tokenize(src));
    const tree = parser.parse();
    return { ok: true, tree, refs: parser.refs };
  } catch (e) {
    if (e instanceof SyntaxFault) return { ok: false, code: 'condition_syntax', message: e.message };
    throw e;
  }
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** The error value E (spec, Semantics): a read of a step that did not pass. */
export const E = 'E' as const;

/** A condition's value: true, false, or the error value E. */
export type ConditionValue = boolean | typeof E;

/** What a condition reads at run time. */
export interface ConditionContext {
  /** The run's parameters, declared defaults bound first. A missing key is an absent parameter. */
  params: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Results of the stages that have ended so far. */
  stages: readonly StageResult[];
  /** `stages.<id>.passed` for each ended stage (PASSED, per the spec's status model). */
  passed: ReadonlyMap<string, boolean>;
}

/** Absent: a declared parameter with no default and no value. Equals nothing; falsy. */
const ABSENT = Symbol('absent');
type Read = string | typeof ABSENT | typeof E;

function read(ref: ConditionRef | ReferenceFault, ctx: ConditionContext): Read {
  switch (ref.kind) {
    case 'param': {
      const v = Object.hasOwn(ctx.params, ref.name) ? ctx.params[ref.name] : undefined;
      return v === undefined ? ABSENT : String(v);
    }
    case 'passed':
      return String(ctx.passed.get(ref.stage) ?? false);
    case 'step': {
      // Readable only when the step's status is `passed` (a continue_on_error step that exited 0
      // included). Failed, timed out, skipped after a hard failure, failed to spawn, or in a stage
      // whose steps never ran: E.
      const step = ctx.stages.find(s => s.id === ref.stage)?.steps?.find(s => s.name === ref.step);
      return step?.status === 'passed' ? step.output.trim() : E;
    }
    case 'fault':
      // Load validation refuses every fault, so reaching one is an interpreter defect (D4).
      return E;
  }
}

/** Truthiness: false for absent, '', 'false' and '0'; true otherwise. Every value is a string. */
function truthy(v: Read): ConditionValue {
  if (v === E) return E;
  if (v === ABSENT) return false;
  return v !== '' && v !== 'false' && v !== '0';
}

function evaluate(node: ConditionNode, ctx: ConditionContext): ConditionValue {
  switch (node.k) {
    case 'ref': return truthy(read(node.ref, ctx));
    case 'cmp': {
      const v = read(node.ref, ctx);
      if (v === E) return E;
      // An absent value equals nothing, not even ''.
      const equal = v !== ABSENT && v === node.lit;
      return node.op === '==' ? equal : !equal;
    }
    case 'not': {
      const v = evaluate(node.e, ctx);
      return v === E ? E : !v;
    }
    case 'and': {
      // Kleene: false absorbs E from either side; otherwise E propagates.
      const l = evaluate(node.l, ctx);
      const r = evaluate(node.r, ctx);
      if (l === false || r === false) return false;
      return l === E || r === E ? E : true;
    }
    case 'or': {
      const l = evaluate(node.l, ctx);
      const r = evaluate(node.r, ctx);
      if (l === true || r === true) return true;
      return l === E || r === E ? E : false;
    }
  }
}

/**
 * Evaluate a condition. Total: true, false, or E. A condition that does not parse yields E, since
 * load validation refuses it before any stage launches (D4: a runtime error is an interpreter
 * defect, and its stage or agent ends ERRORED).
 */
export function evaluateCondition(src: string, ctx: ConditionContext): ConditionValue {
  const parsed = parseCondition(src);
  if (!parsed.ok) return E;
  return evaluate(parsed.tree, ctx);
}
