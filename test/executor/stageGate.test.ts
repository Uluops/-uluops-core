/**
 * stageGate.ts (PDL 1.6.0 §3.2, P4b): the failure mode, the decision key, and the gate judgement.
 * The conformance fixtures run these rules end to end (pdl-conformance.test.ts); these pin the
 * branches the fixtures do not discriminate, found by hand mutants that survived them.
 */
import { describe, it, expect } from 'vitest';
import { gateMode, decisionKey, judgeGate, judgedOutcome, isPerAgentMode, gateHasThreshold, type GatedMember } from '../../src/executor/stageGate.js';
import type { GateDefinition, StageDefinition } from '../../src/types/pipeline.js';

const m = (name: string, cls: GatedMember['class'], score: number | null, threshold?: number): GatedMember =>
  ({ name, class: cls, score, ...(threshold !== undefined ? { threshold } : {}) });

describe('gateMode', () => {
  it('reads skip as fail, absent on_failure as abort, and no gate as fail (D1, D19)', () => {
    expect(gateMode({ on_failure: 'skip' })).toBe('fail');
    expect(gateMode({ on_failure: 'fail' })).toBe('fail');
    expect(gateMode({ on_failure: 'warn' })).toBe('warn');
    expect(gateMode({ on_failure: 'abort' })).toBe('abort');
    expect(gateMode({})).toBe('abort');
    expect(gateMode(undefined)).toBe('fail');
  });

  it('reads a value outside the enum as abort, the most blocking mode (was: continue)', () => {
    expect(gateMode({ on_failure: 'halt' } as unknown as GateDefinition)).toBe('abort');
  });
});

describe('decisionKey', () => {
  it('defaults to not_negative at a blocking gate and ignore at warn (gate-decision D3)', () => {
    expect(decisionKey({ on_failure: 'fail' }, 'fail')).toBe('not_negative');
    expect(decisionKey({ on_failure: 'abort' }, 'abort')).toBe('not_negative');
    expect(decisionKey({ on_failure: 'warn' }, 'warn')).toBe('ignore');
    expect(decisionKey(undefined, 'fail')).toBe('not_negative');
  });

  it('keeps an authored key, and reads an unknown one as the default', () => {
    expect(decisionKey({ on_failure: 'warn', decision: 'not_negative' }, 'warn')).toBe('not_negative');
    expect(decisionKey({ on_failure: 'fail', decision: 'ignore' }, 'fail')).toBe('ignore');
    expect(decisionKey({ on_failure: 'fail', decision: 'bogus' } as unknown as GateDefinition, 'fail')).toBe('not_negative');
  });
});

describe('judgeGate: decision', () => {
  it('positive fails a conditional; not_negative passes it and reports it accepted at a blocking gate', () => {
    expect(judgeGate({ on_failure: 'fail', decision: 'positive' }, [m('a', 'conditional', 90)], false).failed).toBe(true);
    const accepted = judgeGate({ on_failure: 'fail' }, [m('a', 'conditional', 90)], false);
    expect(accepted).toMatchObject({ failed: false, conditionalAccepted: ['a'] });
  });

  it('a warn gate with not_negative passes a conditional and accepts nothing: only a blocking gate makes it count', () => {
    const r = judgeGate({ on_failure: 'warn', decision: 'not_negative' }, [m('a', 'conditional', 90)], false);
    expect(r).toMatchObject({ failed: false, conditionalAccepted: [] });
  });

  it('reports no accepted CONDITIONAL from a gate that failed on another member', () => {
    const r = judgeGate({ on_failure: 'fail' }, [m('a', 'conditional', 90), m('b', 'negative', 90)], false);
    expect(r).toMatchObject({ failed: true, conditionalAccepted: [] });
  });

  it('neutral and absent never fail; ignore compares nothing', () => {
    expect(judgeGate({ on_failure: 'fail' }, [m('a', 'neutral', 90), m('b', 'absent', 90)], false).failed).toBe(false);
    expect(judgeGate({ on_failure: 'fail', decision: 'ignore' }, [m('a', 'negative', 90)], false).failed).toBe(false);
  });
});

describe('judgeGate: score', () => {
  it('per-agent mode: an agent\'s own threshold wins over the gate threshold (D5)', () => {
    // 75 clears the gate's 70 but not the agent's own 80.
    expect(judgeGate({ on_failure: 'fail', threshold: 70 }, [m('a', 'positive', 75, 80)], true).failed).toBe(true);
    // And the other way: 75 clears its own 70 but not the gate's 80.
    expect(judgeGate({ on_failure: 'fail', threshold: 80 }, [m('a', 'positive', 75, 70)], true).failed).toBe(false);
  });

  it('per-agent mode falls back to gate.threshold for an agent without one, and fails closed with neither', () => {
    expect(judgeGate({ on_failure: 'fail', threshold: 70 }, [m('a', 'positive', 90, 80), m('b', 'positive', 68)], true).failed).toBe(true);
    expect(judgeGate({ on_failure: 'fail' }, [m('a', 'positive', 90)], true).failed).toBe(true);
  });

  it('aggregate mode defaults to min; average and max as authored', () => {
    const members = [m('a', 'positive', 80), m('b', 'positive', 70)];
    expect(judgeGate({ on_failure: 'fail', threshold: 75 }, members, false).failed).toBe(true);
    expect(judgeGate({ on_failure: 'fail', threshold: 75, aggregate: 'average' }, members, false).failed).toBe(false);
    expect(judgeGate({ on_failure: 'fail', threshold: 75, aggregate: 'max' }, members, false).failed).toBe(false);
  });

  it('fails closed on an unusable threshold; compares no member without a score (ref and steps stages)', () => {
    expect(judgeGate({ on_failure: 'fail', threshold: Number.NaN }, [m('a', 'positive', 90)], false).failed).toBe(true);
    expect(judgeGate({ on_failure: 'fail', threshold: 70 }, [m('a', 'positive', null)], false).failed).toBe(false);
  });
});

describe('judgedOutcome, isPerAgentMode, gateHasThreshold', () => {
  it('maps a failed gate to WARNED behind warn and FAILED otherwise', () => {
    expect(judgedOutcome(false, 'abort')).toBe('PASSED');
    expect(judgedOutcome(true, 'warn')).toBe('WARNED');
    expect(judgedOutcome(true, 'fail')).toBe('FAILED');
    expect(judgedOutcome(true, 'abort')).toBe('FAILED');
  });

  it('per-agent mode is any agentRef with a threshold; a threshold gate is that or gate.threshold', () => {
    const stage = (agents: StageDefinition['agents'], gate?: GateDefinition) => ({ id: 's', name: 's', type: 'agents', agents, gate }) as StageDefinition;
    expect(isPerAgentMode(stage([{ ref: 'a' }, { ref: 'b', threshold: 70 }]))).toBe(true);
    expect(isPerAgentMode(stage([{ ref: 'a' }], { threshold: 70 }))).toBe(false);
    expect(gateHasThreshold(stage([{ ref: 'a' }], { threshold: 70 }))).toBe(true);
    expect(gateHasThreshold(stage([{ ref: 'a' }], { on_failure: 'fail' }))).toBe(false);
  });
});
