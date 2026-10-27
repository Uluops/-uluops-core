/**
 * The PDL 1.6.0 condition language (P3b): parser and evaluator, unit level. The conformance
 * fixtures (`pdl-conformance.test.ts`) hold the same rules against whole pipelines; these tests pin
 * the pieces, including the pre-1.6.0 behaviours each change removed.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCondition, parseCondition, E, MAX_CONDITION_LENGTH, type ConditionContext } from '../../src/executor/conditions.js';
import type { StageResult, StepResult } from '../../src/types/pipeline.js';

const step = (name: string, status: StepResult['status'], output: string): StepResult =>
  ({ name, command: '…', status, exitCode: status === 'passed' ? 0 : 2, output, durationMs: 1 });

// A real detection preflight's shape: two passed detectors, one failed, one skipped after a hard failure.
const preflight: StageResult = {
  id: 'preflight',
  name: 'Preflight',
  type: 'command',
  status: 'completed',
  steps: [
    step('Detect TypeScript', 'passed', 'DETECTED'),
    step('Detect frontend', 'passed', '  NOT_DETECTED  '),
    step('Detect docs', 'failed', 'DETECTED'),
    step('Detect later', 'skipped', ''),
    step('Zero', 'passed', '0'),
  ],
};

const ctx = (params: ConditionContext['params'] = {}, passed: Record<string, boolean> = {}): ConditionContext =>
  ({ params, stages: [preflight], passed: new Map(Object.entries(passed)) });
const ev = (src: string, c: ConditionContext = ctx()) => evaluateCondition(src, c);

describe('parseCondition: the grammar', () => {
  it.each([
    "params.mode == 'deep'",
    "params['skip-synthesis']",
    '!params.a',
    "!(params.a == 'x')",
    "(params.a == 'x' || params.b == 'y') && params.c == 'z'",
    "stages.preflight.steps['Detect TypeScript'].output == \"DETECTED\"",
    'stages.review.passed || params.lenses == \'on\'',
  ])('accepts %s', (src) => {
    expect(parseCondition(src).ok).toBe(true);
  });

  it.each([
    ['ordering operator', 'params.n >= 5'],
    ['number literal', 'params.n == 5'],
    ['boolean literal on the right', 'params.b == true'],
    ['bare boolean (D36)', 'true'],
    ['! before an unparenthesised comparison (D36)', "!params.a == 'x'"],
    ['double negation (D36)', '!!params.a'],
    ['single =', "params.a = 'x'"],
    ['literal on the left', "'x' == params.a"],
    ['reference on both sides', 'params.a == params.b'],
    ['unbalanced parenthesis', "(params.a == 'x'"],
    ['dangling operator', "params.a == 'x' &&"],
    ['whitespace inside a reference', 'params .a'],
    ['control character in a literal (D40)', "params.a == 'x\ty'"],
    ['line separator in a literal (D40)', "params.a == 'x y'"],
    ['empty', '   '],
  ])('refuses %s as condition_syntax', (_label, src) => {
    const r = parseCondition(src);
    expect(r).toMatchObject({ ok: false, code: 'condition_syntax' });
  });

  it('classifies references against the three roots, in source order', () => {
    const r = parseCondition("params.a == 'x' && stages.pre.passed || stages.pre.steps['n'].output");
    expect(r.ok && r.refs).toEqual([
      { kind: 'param', name: 'a' },
      { kind: 'passed', stage: 'pre' },
      { kind: 'step', stage: 'pre', step: 'n' },
    ]);
  });

  it.each([
    ['trigger.type', 'unknown_root'],
    ['context.has_src', 'unknown_root'],
    ['stage.pre.passed', 'unknown_root'],          // D25: singular prefix
    ['pre.decision', 'unknown_root'],               // D25: bare <id>.<field>
    ['stages.pre.score', 'unknown_path'],
    ["stages.pre.steps['n'].status", 'unknown_path'],
    ['params', 'unknown_path'],
  ])('classifies %s as %s', (src, code) => {
    const r = parseCondition(src);
    expect(r.ok && r.refs[0]).toMatchObject({ kind: 'fault', code });
  });

  it('bounds the length in code points (D41): 512 astral characters parse, 513 do not', () => {
    const within = `params.a == '${'😀'.repeat(MAX_CONDITION_LENGTH - 14)}'`;
    expect([...within].length).toBe(MAX_CONDITION_LENGTH);
    expect(within.length).toBeGreaterThan(MAX_CONDITION_LENGTH); // UTF-16 units: the unit core used to count
    expect(parseCondition(within).ok).toBe(true);
    expect(parseCondition(`params.a == '${'😀'.repeat(MAX_CONDITION_LENGTH - 13)}'`)).toMatchObject({ ok: false, code: 'condition_too_long' });
  });
});

describe('evaluateCondition: semantics', () => {
  it('compares string forms; a number or boolean parameter compares as its string', () => {
    expect(ev("params.mode == 'deep'", ctx({ mode: 'deep' }))).toBe(true);
    expect(ev("params.n == '5'", ctx({ n: 5 }))).toBe(true);
    expect(ev("params.b == 'true'", ctx({ b: true }))).toBe(true);
    expect(ev("params['mode'] != 'deep'", ctx({ mode: 'fast' }))).toBe(true);
  });

  it('truthiness: empty, false and 0 are false (the string 0 included: spec §6 item 31)', () => {
    expect(ev('params.x', ctx({ x: '' }))).toBe(false);
    expect(ev('params.x', ctx({ x: 'false' }))).toBe(false);
    expect(ev('params.x', ctx({ x: false }))).toBe(false);
    expect(ev('params.x', ctx({ x: '0' }))).toBe(false);
    expect(ev('params.x', ctx({ x: 0 }))).toBe(false);
    expect(ev("stages.preflight.steps['Zero'].output")).toBe(false);
    expect(ev('params.x', ctx({ x: 'yes' }))).toBe(true);
  });

  it('an absent parameter equals nothing, not even the empty string, and is falsy', () => {
    expect(ev("params.flag == ''")).toBe(false);
    expect(ev("params.flag != 'x'")).toBe(true);
    expect(ev('params.flag')).toBe(false);
    expect(ev('!params.flag')).toBe(true);
  });

  it('reads a passed step\'s output trimmed', () => {
    expect(ev("stages.preflight.steps['Detect TypeScript'].output == 'DETECTED'")).toBe(true);
    expect(ev("stages.preflight.steps['Detect frontend'].output == 'NOT_DETECTED'")).toBe(true);
  });

  it('reads stages.<id>.passed from the passed map; a stage not in it reads false', () => {
    expect(ev('stages.review.passed', ctx({}, { review: true }))).toBe(true);
    expect(ev('stages.review.passed', ctx({}, { review: false }))).toBe(false);
    expect(ev('stages.review.passed')).toBe(false);
    expect(ev("stages.review.passed == 'true'", ctx({}, { review: true }))).toBe(true);
  });

  it('&& binds tighter than ||, and parentheses group', () => {
    const p = ctx({ a: 'x', b: 'n', c: 'n' });
    expect(ev("params.a == 'x' || params.b == 'y' && params.c == 'z'", p)).toBe(true);
    expect(ev("(params.a == 'x' || params.b == 'y') && params.c == 'z'", p)).toBe(false);
  });
});

describe('evaluateCondition: the error value E (Kleene)', () => {
  const failed = "stages.preflight.steps['Detect docs'].output == 'DETECTED'";
  const skipped = "stages.preflight.steps['Detect later'].output == 'DETECTED'";

  it('a read of a failed step, a step skipped after a hard failure, or a step of a stage that did not run is E', () => {
    expect(ev(failed)).toBe(E);
    expect(ev(skipped)).toBe(E);
    expect(ev("stages.preflight.steps['Detect docs'].output")).toBe(E);
    expect(ev("stages.ghost.steps['x'].output == 'y'")).toBe(E);
  });

  it('propagates as the spec table says', () => {
    const t = "params.on == 'y'";
    const f = "params.on == 'n'";
    const c = ctx({ on: 'y' });
    expect(ev(`!(${failed})`, c)).toBe(E);
    expect(ev(`${t} || ${failed}`, c)).toBe(true);
    expect(ev(`${failed} || ${t}`, c)).toBe(true);
    expect(ev(`${f} && ${failed}`, c)).toBe(false);
    expect(ev(`${failed} && ${f}`, c)).toBe(false);
    expect(ev(`${f} || ${failed}`, c)).toBe(E);
    expect(ev(`${failed} || ${f}`, c)).toBe(E);
    expect(ev(`${t} && ${failed}`, c)).toBe(E);
    expect(ev(`${failed} && ${t}`, c)).toBe(E);
    expect(ev(`${failed} || ${skipped}`, c)).toBe(E);
    expect(ev(`${failed} && ${skipped}`, c)).toBe(E);
  });

  it('a condition that does not parse is E, not true: load validation refuses it, so reaching one is a defect (D4)', () => {
    // Negative control: the pre-1.6.0 evaluator returned "unknown" here and the stage ran.
    expect(ev("trigger.type == 'git_push'")).toBe(E);
    expect(ev('params.n >= 5')).toBe(E);
  });
});
