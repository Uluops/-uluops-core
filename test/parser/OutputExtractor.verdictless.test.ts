// A JSON rung wins only when it carries a verdict (decision or score). R-D12 live run, 2026-11-01:
// Haiku's final answer was `{"analysisRecords":[]}`, which won `inline_json` at 0.9 with decision
// UNKNOWN, so the text rung never ran. These tests pin the fall-through and its two guards.
import { describe, it, expect } from 'vitest';
import { OutputExtractor } from '../../src/parser/OutputExtractor.js';

const extractor = new OutputExtractor();
const records = [{ recordType: 'evidence_claim', recordId: 'EC-1', title: 'Off-by-one in average', severity: 'critical' }];

describe('OutputExtractor: a JSON object with no decision and no score does not win its rung', () => {
  it('reads the decision and score from the prose around a verdictless fence, keeping the JSON fields', () => {
    const content = [
      '# Code Validator',
      '**Score: 62/100**',
      'DECISION',
      '━━━━━━━━━━',
      'FAIL - Critical issues must be fixed',
      '```json',
      JSON.stringify({ analysisRecords: records }),
      '```',
    ].join('\n');
    const r = extractor.extractWithMetadata(content, 'validator');
    expect(r.method).toBe('structured_text');
    expect(r.confidence).toBe(0.5);
    expect(r.output.decision).toBe('FAIL');
    expect(r.output.score).toBe(62);
    expect(r.output.maxScore).toBe(100);
    expect((r.output.rawJson as { analysisRecords: Array<{ recordId: string }> }).analysisRecords.map(x => x.recordId)).toEqual(['EC-1']);
    expect(r.warnings.some(w => w.includes('carried no decision or score'))).toBe(true);
  });

  it('reads the decision from the prose around a verdictless inline object', () => {
    const content = `Decision: PASS\n\nRecords follow: ${JSON.stringify({ analysisRecords: records })}\n`;
    const r = extractor.extractWithMetadata(content, 'validator');
    // A regression guard, not a negative control: INLINE_JSON_PATTERN only considers objects that
    // contain "decision", "status" or "score", so this one was never a candidate and the text rung
    // read PASS before the fall-through existed too.
    expect(r.method).toBe('structured_text');
    expect(r.output.decision).toBe('PASS');
  });

  it('returns a whole-reply verdictless object as before, with a warning naming what is missing', () => {
    const r = extractor.extractWithMetadata('{"analysisRecords":[]}', 'validator');
    expect(r.method).toBe('inline_json');
    expect(r.confidence).toBe(0.9);
    expect(r.output.decision).toBe('UNKNOWN');
    expect(r.warnings.some(w => w.includes('carried no decision or score, and no text outside it did either'))).toBe(true);
  });

  it('never reads text INSIDE a verdictless JSON as the verdict', () => {
    // The text rung's patterns need `key:` with no quote between, so quoted JSON keys never match.
    // A string VALUE can: a finding that quotes "status: open" or "score: 8". Only prose outside
    // the JSON may be read; here there is none, so nothing is.
    const json = JSON.stringify({ analysisRecords: [{ recordId: 'EC-1', description: 'ticket status: open, earlier score: 8' }] }, null, 2);
    for (const reply of ['```json\n' + json + '\n```', json]) {
      const r = extractor.extractWithMetadata(reply, 'validator');
      expect(r.output.decision).toBe('UNKNOWN');
      expect(r.output.score ?? null).toBeNull();
    }
  });

  it('leaves a fence that carries a decision on the fence rung', () => {
    const content = 'DECISION\n━━━\nFAIL\n```json\n{"decision":"PASS","score":90,"maxScore":100}\n```';
    const r = extractor.extractWithMetadata(content, 'validator');
    expect(r.method).toBe('json_code_fence');
    expect(r.confidence).toBe(0.95);
    expect(r.output.decision).toBe('PASS');
  });

  it('treats a score alone as a verdict (score-only gating, D16)', () => {
    const r = extractor.extractWithMetadata('```json\n{"score": 74, "analysisRecords": []}\n```', 'validator');
    expect(r.method).toBe('json_code_fence');
    expect(r.output.score).toBe(74);
  });
});
