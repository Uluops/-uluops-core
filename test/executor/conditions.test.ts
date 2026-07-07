import { describe, it, expect } from 'vitest';
import { evaluateConditionExpr } from '../../src/executor/conditions.js';
import type { StageResult } from '../../src/types/pipeline.js';

// Context mirroring a real detection preflight (post-implementation shape).
const preflight: StageResult = {
  id: 'preflight',
  name: 'Preflight',
  type: 'command',
  status: 'completed',
  steps: [
    { name: 'Detect TypeScript', command: 'test -f tsconfig.json', status: 'passed', exitCode: 0, output: 'DETECTED', durationMs: 5 },
    { name: 'Detect frontend', command: 'find …', status: 'passed', exitCode: 0, output: 'NOT_DETECTED', durationMs: 90 },
  ],
  result: {
    type: 'command', name: 'Preflight', version: '1.0.0', definitionHash: '',
    agentType: 'analyst', decision: 'PASS', score: null, maxScore: null,
    recommendations: [], durationMs: 100,
    metrics: { durationMs: 100, model: 'none', toolCalls: 0, inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0 },
  },
};

const validate: StageResult = {
  id: 'validate',
  name: 'Validate',
  type: 'command',
  status: 'completed',
  result: {
    type: 'command', name: 'Validate', version: '1.0.0', definitionHash: '',
    agentType: 'validator', decision: 'PASS', score: 85, maxScore: 100,
    recommendations: [], durationMs: 100,
    metrics: { durationMs: 100, model: 'sonnet', toolCalls: 3, inputTokens: 1, outputTokens: 1, totalEffectiveTokens: 2 },
  },
};

const ctx = { stages: [preflight, validate], params: { frontend: false, skip_behavior: true, mode: 'deep' } };

describe('evaluateConditionExpr', () => {
  describe('step-output paths (the corpus form)', () => {
    it("resolves stages.<id>.steps['<name>'].output comparisons", () => {
      expect(evaluateConditionExpr("stages.preflight.steps['Detect TypeScript'].output == 'DETECTED'", ctx)).toBe(true);
      expect(evaluateConditionExpr("stages.preflight.steps['Detect frontend'].output == 'DETECTED'", ctx)).toBe(false);
    });

    it('resolves step status and exitCode fields', () => {
      expect(evaluateConditionExpr("stages.preflight.steps['Detect TypeScript'].status == 'passed'", ctx)).toBe(true);
      expect(evaluateConditionExpr("stages.preflight.steps['Detect TypeScript'].exitCode == 0", ctx)).toBe(true);
    });

    it('returns unknown for a missing step name', () => {
      expect(evaluateConditionExpr("stages.preflight.steps['No Such Step'].output == 'DETECTED'", ctx)).toBeNull();
    });
  });

  describe('params paths', () => {
    it('resolves params comparisons and bare truthiness', () => {
      expect(evaluateConditionExpr("params.mode == 'deep'", ctx)).toBe(true);
      expect(evaluateConditionExpr('params.frontend', ctx)).toBe(false);
      expect(evaluateConditionExpr('params.skip_behavior', ctx)).toBe(true);
    });

    it('supports unary negation (the flagship !params.skip_behavior form)', () => {
      expect(evaluateConditionExpr('!params.skip_behavior', ctx)).toBe(false);
      expect(evaluateConditionExpr('!params.frontend', ctx)).toBe(true);
      expect(evaluateConditionExpr('!!params.skip_behavior', ctx)).toBe(true);
    });

    it('treats an absent param as false, not unknown (D5 amendment)', () => {
      // Absence is a normal caller state — the corpus gates agents with
      // `params.x || <detect>` expecting absent→false (live finding e9399a31).
      expect(evaluateConditionExpr('params.nope', ctx)).toBe(false);
      expect(evaluateConditionExpr('!params.nope', ctx)).toBe(true);
      expect(evaluateConditionExpr("params.nope == 'anything'", ctx)).toBe(false);
      expect(evaluateConditionExpr("params.nope != 'anything'", ctx)).toBe(true);
      // Ordering over an absent param stays ill-formed (unknown).
      expect(evaluateConditionExpr('params.nope >= 5', ctx)).toBeNull();
    });

    it('supports bracket access', () => {
      expect(evaluateConditionExpr("params['mode'] == 'deep'", ctx)).toBe(true);
    });
  });

  describe('stage-field paths', () => {
    it('resolves stages.<id>.<field> from the inner result', () => {
      expect(evaluateConditionExpr('stages.validate.score >= 70', ctx)).toBe(true);
      expect(evaluateConditionExpr("stages.validate.decision == 'PASS'", ctx)).toBe(true);
    });

    it('evaluates exact-boundary numeric comparisons correctly', () => {
      // score is exactly 85 — pins >= vs > (and <= vs <) off-by-one mutations.
      expect(evaluateConditionExpr('stages.validate.score >= 85', ctx)).toBe(true);
      expect(evaluateConditionExpr('stages.validate.score > 85', ctx)).toBe(false);
      expect(evaluateConditionExpr('stages.validate.score <= 85', ctx)).toBe(true);
      expect(evaluateConditionExpr('stages.validate.score < 85', ctx)).toBe(false);
    });

    it('supports the legacy <id>.<field> form (pre-Phase-3 back-compat)', () => {
      expect(evaluateConditionExpr('validate.score >= 70', ctx)).toBe(true);
      expect(evaluateConditionExpr('validate.score > 90', ctx)).toBe(false);
    });

    it('falls back to the StageResult envelope for status', () => {
      expect(evaluateConditionExpr("stages.preflight.status == 'completed'", ctx)).toBe(true);
    });

    it('returns unknown for a missing stage', () => {
      expect(evaluateConditionExpr("stages.ghost.decision == 'PASS'", ctx)).toBeNull();
    });
  });

  describe('boolean composition (Kleene)', () => {
    it('evaluates || across step outputs (the post-implementation MCP form)', () => {
      expect(evaluateConditionExpr(
        "stages.preflight.steps['Detect frontend'].output == 'DETECTED' || stages.preflight.steps['Detect TypeScript'].output == 'DETECTED'",
        ctx,
      )).toBe(true);
    });

    it('evaluates params || step-output mixes', () => {
      expect(evaluateConditionExpr(
        "params.frontend || stages.preflight.steps['Detect frontend'].output == 'DETECTED'",
        ctx,
      )).toBe(false);
    });

    it('evaluates && conjunction', () => {
      expect(evaluateConditionExpr("!params.frontend && stages.validate.score >= 70", ctx)).toBe(true);
      expect(evaluateConditionExpr("params.skip_behavior && stages.validate.score > 90", ctx)).toBe(false);
    });

    it('OR short-circuits true past an unknown; unknown survives otherwise', () => {
      // stages.ghost.* is the genuine unknown source (missing stage = typo signal).
      expect(evaluateConditionExpr("stages.ghost.failed || stages.validate.score >= 70", ctx)).toBe(true);
      expect(evaluateConditionExpr('stages.ghost.failed || params.frontend', ctx)).toBeNull();
    });

    it('AND yields false past an unknown when any term is false; unknown survives otherwise', () => {
      // Kleene: false dominates unknown in AND, regardless of term order.
      expect(evaluateConditionExpr('stages.ghost.failed && params.frontend', ctx)).toBe(false);
      expect(evaluateConditionExpr('params.frontend && stages.ghost.failed', ctx)).toBe(false);
      expect(evaluateConditionExpr('stages.ghost.failed && params.skip_behavior', ctx)).toBeNull();
    });

    it('gates the live-finding form correctly: absent param || false detection is false', () => {
      // The exact shape from the $11.46 live run: frontend-validator must gate
      // OFF when params.frontend is unset and detection says NOT_DETECTED.
      expect(evaluateConditionExpr(
        "params.frontend_missing || stages.preflight.steps['Detect frontend'].output == 'DETECTED'",
        ctx,
      )).toBe(false);
    });

    it('does not split on || inside quoted strings', () => {
      expect(evaluateConditionExpr("params.mode == 'a||b'", ctx)).toBe(false);
    });
  });

  describe('ill-formed numeric comparisons fail open, not false', () => {
    it('returns unknown when an ordering operand is non-numeric', () => {
      // false would silently SKIP a stage under run-gate semantics.
      expect(evaluateConditionExpr('stages.validate.decision > 5', ctx)).toBeNull();
      expect(evaluateConditionExpr("stages.validate.score >= 'high'", ctx)).toBeNull();
    });

    it('still evaluates equality on strings normally', () => {
      expect(evaluateConditionExpr("stages.validate.decision == 'PASS'", ctx)).toBe(true);
    });
  });

  describe('unparseable expressions', () => {
    it('returns unknown for unsupported namespaces and garbage', () => {
      expect(evaluateConditionExpr("trigger.type == 'git_push'", ctx)).toBeNull();
      expect(evaluateConditionExpr('invalid condition syntax !!!', ctx)).toBeNull();
      expect(evaluateConditionExpr('', ctx)).toBeNull();
    });
  });
});
