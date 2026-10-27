import { describe, it, expect } from 'vitest';
import safeRegex from 'safe-regex2';
import { MAX_CONDITION_LENGTH, evaluateCondition, parseCondition, E } from '../../src/executor/conditions.js';
import { TEMPLATE_RE, PARAM_TEMPLATE } from '../../src/executor/stepTemplates.js';

// Standing gate for author-facing regexes (repo convention: all patterns must
// pass safe-regex2; registry-api precedent test/unit/services/safety/
// regex-safety.test.ts). Condition strings and step commands are
// definition-controlled input — conditions are evaluated WITHOUT any opt-in.
// Root cause of the Phase 3 security finding (quadratic backtracking in the
// original COMPARISON_RE shape) was the absence of this file.
// PDL 1.6.0 (P3b) replaced the condition regexes with a tokenizer and a recursive-descent parser,
// which apply no pattern to the condition as a whole; the timing tests below hold that.
describe('regex safety (safe-regex2)', () => {
  const authorFacing: Array<[string, RegExp]> = [
    ['TEMPLATE_RE (step commands)', TEMPLATE_RE],
    ['PARAM_TEMPLATE (step placement)', PARAM_TEMPLATE],
  ];

  for (const [name, re] of authorFacing) {
    it(`${name} passes safe-regex2`, () => {
      // An import that no longer resolves gives `undefined`, which safe-regex2 also passes. The
      // template pattern moved to stepTemplates.ts in PDL 1.6.0 P3a, and the old import passed
      // this test with no pattern to check.
      expect(re).toBeInstanceOf(RegExp);
      expect(safeRegex(re)).toBe(true);
    });
  }
});

describe('adversarial condition inputs are time-bounded', () => {
  const ctx = { stages: [], params: {}, passed: new Map<string, boolean>() };

  it('refuses over-length expressions before tokenizing', () => {
    const bomb = 'a' + ' '.repeat(100_000) + '=';
    const start = performance.now();
    expect(parseCondition(bomb)).toMatchObject({ ok: false, code: 'condition_too_long' });
    expect(evaluateCondition(bomb, ctx)).toBe(E);
    expect(performance.now() - start).toBeLessThan(20);
  });

  it.each([
    ['a whitespace run', 'a' + ' '.repeat(MAX_CONDITION_LENGTH - 2) + '='],
    ['a no-operator run', 'x'.repeat(MAX_CONDITION_LENGTH)],
    ['deep parenthesis nesting', '('.repeat(MAX_CONDITION_LENGTH / 2) + ')'.repeat(MAX_CONDITION_LENGTH / 2)],
    ['a long || chain', Array.from({ length: 50 }, () => 'params.a').join(' || ')],
    ['a long negated-group chain', '!('.repeat(100) + 'params.a' + ')'.repeat(100)],
  ])('parses and evaluates %s at the length cap quickly', (_label, src) => {
    const start = performance.now();
    evaluateCondition(src, ctx);
    expect(performance.now() - start).toBeLessThan(20);
  });
});
