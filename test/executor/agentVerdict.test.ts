/**
 * Reading an agent's decision and score (PDL 1.6.0 P4a), unit level, and the pre-launch vocabulary
 * check. The conformance harness runs the fixtures through AgentExecutor; these pin the rules
 * themselves, including the spec's register table against sdk-core (the parity check, D17).
 */
import { describe, it, expect } from 'vitest';
import { decisionToken, readAgentVerdict, isUnjudgeable } from '../../src/executor/agentVerdict.js';
import { classifyDecision, buildVocabularyMap } from '../../src/executor/classifyDecision.js';
import { classifiesItsDecisions, blockingGatedAgentRefs, agentsMissingVocabulary } from '../../src/executor/vocabularyPrecheck.js';
import { OutputNormalizer } from '../../src/parser/OutputNormalizer.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';

const gateVocab = buildVocabularyMap({ decisions: { vocabulary: { positive: 'PROCEED', negative: 'REVISE' } } } as never);
const read = (json: unknown, text = '') =>
  readAgentVerdict({ agent: 'a', json, text, vocabulary: gateVocab, display: new OutputNormalizer().locateDisplaySources(json) });

describe('the core register (D17): the spec table, against sdk-core', () => {
  // The table as the spec prints it (§3.2 item 4) and the skill carries it. sdk-core exports no
  // list, only classifyDecision, so parity is checked through its behaviour.
  const TABLE = {
    positive: ['PASS', 'SHIP', 'COMPLETE', 'EXPLORED', 'APPROVED', 'PROCEED'],
    negative: ['FAIL', 'FAILED', 'BLOCK', 'BLOCKED'],
    conditional: ['WARN', 'HOLD', 'PARTIAL'],
  } as const;

  it.each(Object.entries(TABLE).flatMap(([cls, tokens]) => tokens.map(t => [t, cls])))('%s is %s', (token, cls) => {
    expect(classifyDecision(token)).toBe(cls);
  });

  it.each(['OK', 'SUCCESS', 'PASSED', 'WARNING', 'CAUTION', 'ERROR', 'REJECT', 'DONE', 'INCOMPLETE', 'APPROVE', 'STOP', 'GO'])(
    'the synonym or near-miss %s is neutral: synonyms do not gate', (token) => {
      expect(classifyDecision(token)).toBe('neutral');
    },
  );

  it('a vocabulary cannot remap a register token (buildVocabularyMap drops it; CWE-345), and that is kept', () => {
    const vocab = buildVocabularyMap({ decisions: { vocabulary: { positive: 'FAIL', negative: 'REVISE' } } } as never);
    expect(classifyDecision('FAIL', vocab)).toBe('negative');
    expect(classifyDecision('REVISE', vocab)).toBe('negative');
  });
});

describe('decisionToken: the token rule', () => {
  it.each([
    ['**REVISE** (Score: 85)', 'REVISE'],
    ['✅ PROCEED', 'PROCEED'],
    ['REVISE.', 'REVISE'],
    ['REVISE (pending AF-003)', 'REVISE'],
    ['revise', 'REVISE'],
    ['PARTIALLY_DOCUMENTED', 'PARTIALLY_DOCUMENTED'],
    ['PASS: all checks', 'PASS'],
    ['PASS   ', 'PASS'],
    ['PASS - 3 issues', 'PASS'],
  ])('%s → %s', (value, token) => {
    expect(decisionToken(value)).toBe(token);
  });

  it.each([
    ['NOT SECURE'],
    ['SECURE WITH CONDITIONS'],
    ['PARTIALLY DOCUMENTED'],
    ['[DOCUMENTED|PARTIALLY_DOCUMENTED|UNDERDOCUMENTED]'],
    ['~~PROCEED~~ REVISE'],
    ['PASS/FAIL'],
    ['PASS-ish'],
    ['*'.repeat(200) + 'REVISE'],
    [''],
    ['✅ 🚀'],
    // Closing punctuation is `) ] . , : ; ! *` only (spec, The token rule): a backtick or a quote
    // after the token makes the value neutral. Toward neutral, never the wrong class.
    ['`PASS`'],
    ['"PASS"'],
  ])('%s → neutral (no token)', (value) => {
    expect(decisionToken(value)).toBeUndefined();
  });

  it('counts the 200 characters as code points, before dropping leading non-letters', () => {
    // 199 + 'REVISE' is cut to 199 + 'R': the token is R, which nothing classifies.
    expect(decisionToken('*'.repeat(199) + 'REVISE')).toBe('R');
    // 199 astral characters are 398 UTF-16 units; a UTF-16 cut would drop the R.
    expect(decisionToken('😀'.repeat(199) + 'R')).toBe('R');
    expect(decisionToken('😀'.repeat(200) + 'R')).toBeUndefined();
  });
});

describe('readAgentVerdict: paths, conflicts, saved form', () => {
  it('reads result.decision before the top-level decision', () => {
    expect(read({ decision: 'PROCEED', result: { decision: 'REVISE', score: 90 } })).toMatchObject({ class: 'negative', saved: 'REVISE', score: 90 });
  });

  it('reads the Decision: line when neither JSON path holds one, emphasis allowed', () => {
    expect(read(undefined, 'Report\n**Decision:** REVISE\n')).toMatchObject({ class: 'negative', saved: 'REVISE' });
  });

  it('reads the FIRST Decision: line (a stated reading)', () => {
    expect(read(undefined, 'Decision: PROCEED\n...\nDecision: REVISE')).toMatchObject({ class: 'positive' });
  });

  it('a non-string at result.decision counts as nothing there; the top level is read', () => {
    expect(read({ decision: 'REVISE', result: { decision: { label: 'PROCEED' } } })).toMatchObject({ class: 'negative' });
  });

  it('a classifiable line beats a neutral JSON value, with no warning', () => {
    const v = read({ result: { decision: '[PROCEED|REVISE]', score: 90 } }, 'Decision: REVISE');
    expect(v).toMatchObject({ class: 'negative', saved: 'REVISE', warnings: [] });
  });

  it('when both classify and disagree, the JSON wins with DECISION_CONFLICT', () => {
    const v = read({ result: { decision: 'PROCEED', score: 90 } }, 'Decision: REVISE');
    expect(v.class).toBe('positive');
    expect(v.warnings).toEqual([{ code: 'DECISION_CONFLICT', agent: 'a', json: 'PROCEED', line: 'REVISE' }]);
  });

  it('two tokens of one class are not a conflict', () => {
    expect(read({ result: { decision: 'PROCEED', score: 90 } }, 'Decision: PASS').warnings).toEqual([]);
  });

  it('saves a neutral value as written, whitespace collapsed, cut to 50', () => {
    expect(read({ result: { decision: 'SECURE   WITH\nCONDITIONS', score: 90 } }).saved).toBe('SECURE WITH CONDITIONS');
    const long = read({ result: { decision: 'MAYBE '.repeat(20), score: 90 } }).saved;
    expect(Array.from(long)).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('absent: UNKNOWN, ABSENT_DECISION, and a FALLBACK_DECISION_SOURCE naming where the wide search found one', () => {
    const v = read({ status: 'REVISE', result: { score: 90 } });
    expect(v).toMatchObject({ class: 'absent', saved: 'UNKNOWN' });
    expect(v.warnings).toEqual([{ code: 'ABSENT_DECISION', agent: 'a' }, { code: 'FALLBACK_DECISION_SOURCE', agent: 'a', source: 'status' }]);
  });

  it('classifies through the vocabulary case-insensitively', () => {
    const lower = buildVocabularyMap({ decisions: { vocabulary: { positive: 'Proceed', negative: 'revise' } } } as never);
    expect(readAgentVerdict({ agent: 'a', json: { result: { decision: 'REVISE' } }, text: '', vocabulary: lower }).class).toBe('negative');
  });
});

describe('readAgentVerdict: only the output envelope is read (D47)', () => {
  // R-D12 step 0: core's inline-JSON fallback lifted a category object out of a truncated block, and the
  // contract read its score (17) where the agent's result.score was 87.
  const fragment = { name: 'Anxiety-Register Classification', score: 17, max_points: 25, decision: 'CONFIDENCE_WARRANTED' };

  it('extracted JSON without `result` is not read: its score and decision do not gate', () => {
    const v = readAgentVerdict({ agent: 'a', json: fragment, text: '' });
    expect(v).toMatchObject({ class: 'absent', score: null });
  });

  it('the lines still are: a truncated report keeps what its Decision: and Score: lines say', () => {
    const v = readAgentVerdict({ agent: 'a', json: fragment, text: 'Decision: FAIL\nScore: 87' });
    expect(v).toMatchObject({ class: 'negative', saved: 'FAIL', score: 87 });
  });

  it('an object carrying `result` is the envelope, and its top-level paths are read too', () => {
    expect(readAgentVerdict({ agent: 'a', json: { result: { score: 87 }, decision: 'PASS' }, text: '' }))
      .toMatchObject({ class: 'positive', score: 87 });
  });

  it('core\'s structured output is the envelope by construction: flat `agentOutputSchema` is read', () => {
    expect(readAgentVerdict({ agent: 'a', json: { decision: 'PASS', score: 85, maxScore: 100 }, text: '', structured: true }))
      .toMatchObject({ class: 'positive', score: 85 });
  });
});

describe('readAgentVerdict: the score contract (D16)', () => {
  it.each([
    [{ result: { score: 70 }, score: 90 }, 70],
    [{ result: {}, score: 90 }, 90],
    [{ result: { score: '85' } }, 85],
    [{ result: { score: 0 } }, 0],
    [{ result: { score: 100 } }, 100],
    [{ result: { score: null }, score: 40 }, 40],
  ])('%j → %d', (json, score) => {
    expect(read(json).score).toBe(score);
  });

  it.each([
    [{ result: { score: 150 } }, '150'],
    [{ result: { score: -1 } }, '-1'],
    [{ result: { score: '[X]' } }, '[X]'],
    [{ result: { score: ' 85' } }, ' 85'],
    [{ result: { score: { total: 85 } } }, '{"total":85}'],
  ])('%j is no score, with SCORE_INVALID naming %s, and the top level is not read past it', (json, value) => {
    const v = read({ ...json, score: 90 });
    expect(v.score).toBeNull();
    expect(v.warnings).toContainEqual({ code: 'SCORE_INVALID', agent: 'a', value });
  });

  it.each([
    ['Score: 85', 85],
    ['Score: 85/100', 85],
    ['**Score:** 85', 85],
    ['## Score: 72.5', 72.5],
  ])('the line %s → %d', (line, score) => {
    expect(read(undefined, `Report\n${line}\nDecision: PASS`).score).toBe(score);
  });

  it('a score found only by the wide search is no score, with FALLBACK_SCORE_SOURCE', () => {
    const v = read({ summary: { score: 90 }, result: { decision: 'PROCEED' } });
    expect(v.score).toBeNull();
    expect(v.warnings).toEqual([{ code: 'FALLBACK_SCORE_SOURCE', agent: 'a', source: 'summary.score' }]);
  });

  it('a category score is not a score, and is not reported as a fallback', () => {
    const v = read({ result: { decision: 'PROCEED' }, categories: [{ name: 'Fit', score: 90 }] });
    expect(v.score).toBeNull();
    expect(v.warnings).toEqual([]);
  });
});

describe('isUnjudgeable (D24, D12)', () => {
  // [class, score, threshold, blocking, unjudgeable]
  it.each([
    ['positive', null, true, true, true],
    ['positive', null, false, true, false],
    ['negative', null, false, true, false],
    ['neutral', null, false, true, true],
    ['absent', null, false, false, true],
    // A declared neutral with a score is judgeable at any gate (D6; D12's control).
    ['neutral', 85, true, true, false],
    ['neutral', 85, false, true, false],
    // D12: an absent decision at a blocking gate is unjudgeable whatever the score.
    ['absent', 85, false, true, true],
    ['absent', 85, true, true, true],
    ['absent', 0, true, true, true],
    // Behind `warn`, or in a stage with no gate, the score decides.
    ['absent', 85, true, false, false],
    ['absent', 0, false, false, false],
  ] as const)('%s, score %s, threshold %s, blocking %s → %s', (cls, score, hasThreshold, blocking, want) => {
    expect(isUnjudgeable({ class: cls, score }, { hasThreshold, blocking })).toBe(want);
  });
});

describe('the pre-launch vocabulary check (D9)', () => {
  const agent = (body: Record<string, unknown>, agentType = 'validator') =>
    ({ type: 'agent', name: 'x', agentType, definition: { agent: body } }) as unknown as ResolvedDefinition;

  it('passes a declared vocabulary, an executor completion vocabulary, and an explorer', () => {
    expect(classifiesItsDecisions(agent({ decisions: { vocabulary: { positive: 'GO', negative: 'NO' } } }))).toBe(true);
    expect(classifiesItsDecisions(agent({ completion: { vocabulary: { complete: 'DONE', failed: 'BROKE' } } }, 'executor'))).toBe(true);
    expect(classifiesItsDecisions(agent({}, 'explorer'))).toBe(true);
    expect(classifiesItsDecisions(agent({ interface: { agentType: 'explorer' } }, undefined as never))).toBe(true);
  });

  it('fails no vocabulary, an empty one, and a blank term', () => {
    expect(classifiesItsDecisions(agent({}))).toBe(false);
    expect(classifiesItsDecisions(agent({ decisions: { vocabulary: {} } }))).toBe(false);
    expect(classifiesItsDecisions(agent({ decisions: { vocabulary: { positive: ' ' } } }))).toBe(false);
  });

  it('checks inline agents of blocking-gated stages only (abort, fail, skip, or no on_failure)', () => {
    expect(blockingGatedAgentRefs([
      { id: 'a', name: 'a', agents: [{ ref: 'abort' }], gate: { on_failure: 'abort' } },
      { id: 'b', name: 'b', agents: [{ ref: 'default' }], gate: {} },
      { id: 'c', name: 'c', agents: [{ ref: 'fail' }], gate: { on_failure: 'fail' as never } },
      { id: 'd', name: 'd', agents: [{ ref: 'warn' }], gate: { on_failure: 'warn' } },
      { id: 'e', name: 'e', agents: [{ ref: 'nogate' }] },
      { id: 'f', name: 'f', agents: [{ ref: 'abort' }], gate: { on_failure: 'skip' } },
    ] as never)).toEqual(['abort', 'default', 'fail']);
  });

  it('does not refuse an agent it cannot resolve; dispatch reports it', async () => {
    const unresolved: string[] = [];
    const missing = await agentsMissingVocabulary(
      [{ id: 'a', name: 'a', agents: [{ ref: 'ghost' }, { ref: 'bare' }], gate: { on_failure: 'abort' } }] as never,
      async (ref) => { if (ref === 'ghost') throw new Error('404'); return agent({}); },
      (ref) => unresolved.push(ref),
    );
    expect(missing).toEqual(['bare']);
    expect(unresolved).toEqual(['ghost']);
  });
});
