import { describe, it, expect } from 'vitest';
import { classifyDecision, buildVocabularyMap, resolveDecisionCategory, type DecisionVocabularyMap } from '../../src/executor/classifyDecision.js';

describe('classifyDecision', () => {
  describe('core vocabularies (no vocabulary map)', () => {
    it.each([
      ['PASS', 'positive'],
      ['SHIP', 'positive'],
      ['COMPLETE', 'positive'],
      ['EXPLORED', 'positive'],
      ['FAIL', 'negative'],
      ['FAILED', 'negative'],
      ['BLOCK', 'negative'],
      ['PARTIAL', 'conditional'],
      ['WARN', 'conditional'],
      ['HOLD', 'conditional'],
    ] as const)('classifies %s as %s', (decision, expected) => {
      expect(classifyDecision(decision)).toBe(expected);
    });

    it('returns neutral for undefined', () => {
      expect(classifyDecision(undefined)).toBe('neutral');
    });

    it('returns neutral for empty string', () => {
      expect(classifyDecision('')).toBe('neutral');
    });

    it('returns neutral for unknown decision strings', () => {
      expect(classifyDecision('MAYBE')).toBe('neutral');
      expect(classifyDecision('YES')).toBe('neutral');
      expect(classifyDecision('unknown')).toBe('neutral');
    });
  });

  describe('with vocabulary map (dynamic classification)', () => {
    const cognitiveVocab: DecisionVocabularyMap = new Map([
      ['HARMONIOUS', 'positive'],
      ['DISORDERED', 'negative'],
    ]);

    it('classifies custom vocabulary values', () => {
      expect(classifyDecision('HARMONIOUS', cognitiveVocab)).toBe('positive');
      expect(classifyDecision('DISORDERED', cognitiveVocab)).toBe('negative');
    });

    it('falls through to core vocabularies for non-mapped values', () => {
      expect(classifyDecision('PASS', cognitiveVocab)).toBe('positive');
      expect(classifyDecision('FAIL', cognitiveVocab)).toBe('negative');
    });

    it('vocabulary map takes precedence over core vocabulary', () => {
      // A custom vocabulary could redefine a core value
      const overrideVocab: DecisionVocabularyMap = new Map([
        ['PASS', 'negative'], // hypothetical: PASS means something different
      ]);
      expect(classifyDecision('PASS', overrideVocab)).toBe('negative');
    });

    it('returns neutral for values not in map or core', () => {
      expect(classifyDecision('UNKNOWN_VALUE', cognitiveVocab)).toBe('neutral');
    });

    it('handles undefined decision with vocabulary map', () => {
      expect(classifyDecision(undefined, cognitiveVocab)).toBe('neutral');
    });
  });
});

describe('buildVocabularyMap', () => {
  describe('validator vocabulary (decisions.vocabulary)', () => {
    it('maps positive, negative, conditional', () => {
      const map = buildVocabularyMap({
        decisions: {
          vocabulary: {
            positive: 'HARMONIOUS',
            negative: 'DISORDERED',
            conditional: 'STRAINED',
          },
        },
      });
      expect(map).toBeDefined();
      expect(map!.get('HARMONIOUS')).toBe('positive');
      expect(map!.get('DISORDERED')).toBe('negative');
      expect(map!.get('STRAINED')).toBe('conditional');
    });

    it('handles null conditional field', () => {
      const map = buildVocabularyMap({
        decisions: {
          vocabulary: {
            positive: 'CLEAR',
            negative: 'BEWITCHED',
            conditional: null,
          },
        },
      });
      expect(map).toBeDefined();
      expect(map!.get('CLEAR')).toBe('positive');
      expect(map!.get('BEWITCHED')).toBe('negative');
      expect(map!.size).toBe(2);
    });

    it('handles undefined conditional field', () => {
      const map = buildVocabularyMap({
        decisions: {
          vocabulary: {
            positive: 'GROUNDED',
            negative: 'UNGROUNDED',
          },
        },
      });
      expect(map).toBeDefined();
      expect(map!.size).toBe(2);
    });
  });

  describe('executor vocabulary (completion.vocabulary)', () => {
    it('maps complete, partial, failed', () => {
      const map = buildVocabularyMap({
        completion: {
          vocabulary: {
            complete: 'DONE',
            partial: 'HALF',
            failed: 'BROKEN',
          },
        },
      });
      expect(map).toBeDefined();
      expect(map!.get('DONE')).toBe('positive');
      expect(map!.get('HALF')).toBe('conditional');
      expect(map!.get('BROKEN')).toBe('negative');
    });
  });

  describe('edge cases', () => {
    it('returns undefined for empty definition', () => {
      expect(buildVocabularyMap({})).toBeUndefined();
    });

    it('returns undefined when vocabulary fields are missing', () => {
      expect(buildVocabularyMap({ decisions: {} })).toBeUndefined();
      expect(buildVocabularyMap({ completion: {} })).toBeUndefined();
    });

    it('handles definition with both decisions and completion', () => {
      // Custom terms only — core-register strings (PASS/FAIL) would be dropped
      // by the remap guard and are covered by the CWE-345 tests below.
      const map = buildVocabularyMap({
        decisions: {
          vocabulary: { positive: 'CLEAR', negative: 'BEWITCHED' },
        },
        completion: {
          vocabulary: { complete: 'DONE', partial: 'HALF', failed: 'BROKEN' },
        },
      });
      expect(map).toBeDefined();
      expect(map!.size).toBe(5);
    });
  });

  describe('integration with classifyDecision', () => {
    it('built vocabulary map works with classifyDecision', () => {
      const map = buildVocabularyMap({
        decisions: {
          vocabulary: {
            positive: 'EXAMINED',
            negative: 'UNEXAMINED',
          },
        },
      });
      expect(classifyDecision('EXAMINED', map!)).toBe('positive');
      expect(classifyDecision('UNEXAMINED', map!)).toBe('negative');
      // Core vocabulary still works as fallback
      expect(classifyDecision('WARN', map!)).toBe('conditional');
    });
  });

  describe('core-register remap guard (CWE-345)', () => {
    it('ignores vocabulary entries that try to remap core-register strings', () => {
      // A malicious definition maps its "positive" term to the literal FAIL —
      // without the guard, classifyDecision('FAIL', map) would return positive
      // and the stamp would propagate through every downstream gate.
      const map = buildVocabularyMap({
        decisions: { vocabulary: { positive: 'FAIL', negative: 'PASS' } },
      });
      // Both entries target core strings, so no map is built at all…
      expect(map).toBeUndefined();
      // …and the core register classifies them correctly.
      expect(classifyDecision('FAIL', map)).toBe('negative');
      expect(classifyDecision('PASS', map)).toBe('positive');
    });

    it('keeps custom terms while dropping core-register collisions from the same vocabulary', () => {
      const map = buildVocabularyMap({
        decisions: { vocabulary: { positive: 'HARMONIOUS', negative: 'FAILED' } },
      });
      expect(map!.size).toBe(1);
      expect(classifyDecision('HARMONIOUS', map)).toBe('positive');
      expect(classifyDecision('FAILED', map)).toBe('negative'); // core register, unaffected
    });

    it('redundant agreeing mappings lose nothing', () => {
      // Validators commonly declare their vocabulary redundantly (PASS/FAIL) —
      // the entries are skipped and the core register gives the same answer.
      const map = buildVocabularyMap({
        decisions: { vocabulary: { positive: 'PASS', negative: 'FAIL', conditional: 'WARN' } },
      });
      expect(map).toBeUndefined();
      expect(classifyDecision('PASS', map)).toBe('positive');
      expect(classifyDecision('WARN', map)).toBe('conditional');
    });
  });

  describe('resolveDecisionCategory', () => {
    it('returns neutral for undefined result (thrown-error stage with no result)', () => {
      expect(resolveDecisionCategory(undefined)).toBe('neutral');
    });

    it('prefers the pre-resolved decisionCategory over raw-string classification', () => {
      // EXPOSED is not in the core register — only the stamped category knows it is negative
      expect(resolveDecisionCategory({ decision: 'EXPOSED', decisionCategory: 'negative' })).toBe('negative');
      // The stamped category wins even when it contradicts the raw string:
      // the producing executor had the definition's vocabulary; we do not.
      expect(resolveDecisionCategory({ decision: 'FAIL', decisionCategory: 'positive' })).toBe('positive');
    });

    it('falls back to classifyDecision over the raw string when no category is stamped', () => {
      expect(resolveDecisionCategory({ decision: 'FAIL' })).toBe('negative');
      expect(resolveDecisionCategory({ decision: 'HOLD' })).toBe('conditional');
      expect(resolveDecisionCategory({ decision: 'SHIP' })).toBe('positive');
    });

    it('resolves unstamped custom-vocabulary strings to neutral (the fallback boundary)', () => {
      // Without the stamped category the vocabulary is unknowable here — this is
      // exactly why producers must stamp decisionCategory (tracker run #55).
      expect(resolveDecisionCategory({ decision: 'BEWITCHED' })).toBe('neutral');
    });
  });
});
