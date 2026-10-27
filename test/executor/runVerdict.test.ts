/**
 * runVerdict.ts (PDL 1.6.0 §3.1, D13, D19; P4b): allGatesPassed, the run decision and stage metrics.
 * End to end over every conformance case in pdl-conformance.test.ts; these pin each clause alone.
 */
import { describe, it, expect } from 'vitest';
import { computeAllGatesPassed, runDecision, runDecisionCategory, stageMetrics, paramsLine } from '../../src/executor/runVerdict.js';
import type { GateMode, StageOutcome, StageResult } from '../../src/types/pipeline.js';

const st = (id: string, outcome: StageOutcome, gateMode?: GateMode): StageResult =>
  ({ id, name: id, type: 'command', status: outcome === 'SKIPPED' ? 'skipped' : outcome === 'ERRORED' ? 'errored' : 'completed', outcome, ...(gateMode ? { gateMode } : {}) });
const clean = { stopReached: false, executionFailed: false };

describe('computeAllGatesPassed', () => {
  it('is true when every stage PASSED, WARNED or SKIPPED', () => {
    expect(computeAllGatesPassed([st('a', 'PASSED', 'abort'), st('b', 'WARNED', 'warn'), st('c', 'SKIPPED')], [], clean)).toBe(true);
  });

  it('is false on a FAILED stage, whatever its mode', () => {
    expect(computeAllGatesPassed([st('a', 'FAILED', 'fail')], [], clean)).toBe(false);
  });

  it('an ERRORED stage is false behind abort or fail, and leaves it unchanged behind warn (D19)', () => {
    expect(computeAllGatesPassed([st('a', 'ERRORED', 'abort')], [], clean)).toBe(false);
    expect(computeAllGatesPassed([st('a', 'ERRORED', 'fail')], [], clean)).toBe(false);
    expect(computeAllGatesPassed([st('a', 'ERRORED', 'warn')], [], clean)).toBe(true);
  });

  it('is false when a blocking gate accepted a CONDITIONAL (gate-decision D2)', () => {
    expect(computeAllGatesPassed([st('a', 'PASSED', 'fail')], [{ code: 'CONDITIONAL_ACCEPTED', stage: 'a', agent: 'x' }], clean)).toBe(false);
    expect(computeAllGatesPassed([st('a', 'ERRORED', 'warn')], [{ code: 'STAGE_ERRORED', stage: 'a', reason: 'agent_unjudgeable' }], clean)).toBe(true);
  });

  it('is false when a stop reached a stage, or the execution itself threw', () => {
    expect(computeAllGatesPassed([st('a', 'PASSED', 'fail')], [], { stopReached: true, executionFailed: false })).toBe(false);
    expect(computeAllGatesPassed([st('a', 'PASSED', 'fail')], [], { stopReached: false, executionFailed: true })).toBe(false);
  });
});

describe('runDecision', () => {
  it('FAIL when not passed; WARN on a WARNED stage or one ERRORED behind warn; else PASS', () => {
    expect(runDecision(false, [st('a', 'PASSED', 'fail')])).toBe('FAIL');
    expect(runDecision(true, [st('a', 'WARNED', 'warn')])).toBe('WARN');
    expect(runDecision(true, [st('a', 'ERRORED', 'warn')])).toBe('WARN');
    expect(runDecision(true, [st('a', 'PASSED', 'fail'), st('b', 'SKIPPED')])).toBe('PASS');
    expect(runDecisionCategory('PASS')).toBe('positive');
    expect(runDecisionCategory('WARN')).toBe('conditional');
    expect(runDecisionCategory('FAIL')).toBe('negative');
  });
});

describe('stageMetrics', () => {
  it('counts each outcome once; the five counts partition the stages', () => {
    const m = stageMetrics([st('a', 'PASSED'), st('b', 'WARNED'), st('c', 'FAILED'), st('d', 'ERRORED'), st('e', 'SKIPPED'), st('f', 'PASSED')]);
    expect(m).toEqual({ stagesExecuted: 5, stagesPassed: 2, stagesFailed: 1, stagesWarned: 1, stagesErrored: 1, stagesSkipped: 1 });
  });
});

describe('paramsLine', () => {
  it('writes every resolved parameter as one JSON line with sorted keys', () => {
    expect(paramsLine({ target: '/r', lenses: 'on', n: 3, deep: false })).toBe('params: {"deep":false,"lenses":"on","n":3,"target":"/r"}');
    expect(paramsLine({ note: 'a\nb' })).toBe('params: {"note":"a\\nb"}');
  });
});
