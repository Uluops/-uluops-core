import { describe, it, expect } from 'vitest';
import safeRegex from 'safe-regex2';
import {
  COMPARISON_RE,
  PARAMS_PATH_RE,
  STEPS_PATH_RE,
  STAGE_FIELD_RE,
  MAX_CONDITION_LENGTH,
  evaluateConditionExpr,
} from '../../src/executor/conditions.js';
import { TEMPLATE_RE } from '../../src/executor/StepsExecutor.js';

// Standing gate for author-facing regexes (repo convention: all patterns must
// pass safe-regex2; registry-api precedent test/unit/services/safety/
// regex-safety.test.ts). Condition strings and step commands are
// definition-controlled input — conditions are evaluated WITHOUT any opt-in.
// Root cause of the Phase 3 security finding (quadratic backtracking in the
// original COMPARISON_RE shape) was the absence of this file.
describe('regex safety (safe-regex2)', () => {
  const authorFacing: Array<[string, RegExp]> = [
    ['COMPARISON_RE', COMPARISON_RE],
    ['PARAMS_PATH_RE', PARAMS_PATH_RE],
    ['STEPS_PATH_RE', STEPS_PATH_RE],
    ['STAGE_FIELD_RE', STAGE_FIELD_RE],
    ['TEMPLATE_RE (step commands)', TEMPLATE_RE],
  ];

  for (const [name, re] of authorFacing) {
    it(`${name} passes safe-regex2`, () => {
      expect(safeRegex(re)).toBe(true);
    });
  }
});

describe('adversarial condition inputs are time-bounded', () => {
  const ctx = { stages: [], params: {} };

  it('rejects over-length expressions before any regex runs (fail-open)', () => {
    const bomb = 'a' + ' '.repeat(100_000) + '=';
    const start = performance.now();
    expect(evaluateConditionExpr(bomb, ctx)).toBeNull();
    expect(performance.now() - start).toBeLessThan(5);
  });

  it('evaluates max-length whitespace-run adversarial input quickly', () => {
    // The original COMPARISON_RE shape was quadratic on exactly this input
    // class; must stay linear-ish within the length cap.
    const adversarial = 'a' + ' '.repeat(MAX_CONDITION_LENGTH - 2) + '=';
    const start = performance.now();
    evaluateConditionExpr(adversarial, ctx);
    expect(performance.now() - start).toBeLessThan(20);
  });

  it('evaluates a max-length no-operator run quickly', () => {
    const adversarial = 'x'.repeat(MAX_CONDITION_LENGTH);
    const start = performance.now();
    evaluateConditionExpr(adversarial, ctx);
    expect(performance.now() - start).toBeLessThan(20);
  });
});
