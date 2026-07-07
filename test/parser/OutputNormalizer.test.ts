import { describe, it, expect } from 'vitest';
import { OutputNormalizer } from '../../src/parser/OutputNormalizer.js';

describe('OutputNormalizer', () => {
  const normalizer = new OutputNormalizer();

  // ─── score nullability (Phase 4) ────────────────────────────────────
  describe('score nullability (Phase 4)', () => {
    it('does not fabricate a score for a generator-shaped output with no score (V9)', () => {
      const out = normalizer.normalizeOutput({ decision: 'COMPLETE' }, 'executor');
      expect(out.score == null).toBe(true);   // absent, not fabricated 0
      expect(out.maxScore == null).toBe(true);
    });

    it('keeps real per-category scores with their 100 scale (V10)', () => {
      const out = normalizer.normalizeOutput(
        { decision: 'PASS', scores: { 'Code Quality': 80, 'Security': 90 } },
        'validator',
      );
      const cq = out.categories?.find(c => c.name === 'Code Quality');
      expect(cq?.score).toBe(80);
      expect(cq?.maxScore).toBe(100); // real score's scale is KEPT, not nulled
    });

    it('synthesizes a null-pair category for a scoreless output with flat issues (V10b)', () => {
      const out = normalizer.normalizeOutput(
        { decision: 'COMPLETE', issues: [{ title: 'Something', description: 'd', severity: 'medium' }] },
        'executor',
      );
      const extracted = out.categories?.find(c => c.name === 'Extracted Issues');
      expect(extracted).toBeDefined();
      expect(extracted?.score).toBeNull();
      expect(extracted?.maxScore).toBeNull();
    });
  });

  // ─── normalizeDecision ──────────────────────────────────────────────

  describe('normalizeDecision', () => {
    it('normalizes validator decisions', () => {
      expect(normalizer.normalizeDecision('PASS', 'validator')).toBe('PASS');
      expect(normalizer.normalizeDecision('PASSED', 'validator')).toBe('PASS');
      expect(normalizer.normalizeDecision('OK', 'validator')).toBe('PASS');
      expect(normalizer.normalizeDecision('FAIL', 'validator')).toBe('FAIL');
      expect(normalizer.normalizeDecision('WARN', 'validator')).toBe('WARN');
      expect(normalizer.normalizeDecision('WARNING', 'validator')).toBe('WARN');
    });

    it('normalizes executor decisions', () => {
      expect(normalizer.normalizeDecision('SUCCESS', 'executor')).toBe('COMPLETE');
      expect(normalizer.normalizeDecision('COMPLETE', 'executor')).toBe('COMPLETE');
      expect(normalizer.normalizeDecision('DONE', 'executor')).toBe('COMPLETE');
      expect(normalizer.normalizeDecision('PARTIAL', 'executor')).toBe('PARTIAL');
      expect(normalizer.normalizeDecision('FAIL', 'executor')).toBe('FAILED');
    });

    it('passes through analyst decisions unchanged', () => {
      expect(normalizer.normalizeDecision('VITAL', 'analyst')).toBe('VITAL');
      expect(normalizer.normalizeDecision('DECADENT', 'analyst')).toBe('DECADENT');
      expect(normalizer.normalizeDecision('FLOWING', 'analyst')).toBe('FLOWING');
    });

    it('extracts first word from decorated decisions', () => {
      expect(normalizer.normalizeDecision('PASS - Ready for next phase', 'validator')).toBe('PASS');
      expect(normalizer.normalizeDecision('FAIL — Blocking issues found', 'validator')).toBe('FAIL');
    });

    it('strips emojis from decisions', () => {
      expect(normalizer.normalizeDecision('✅ PASS', 'validator')).toBe('PASS');
      expect(normalizer.normalizeDecision('❌ FAIL', 'validator')).toBe('FAIL');
    });

    it('handles empty and whitespace decisions', () => {
      expect(normalizer.normalizeDecision('', 'validator')).toBe('');
      expect(normalizer.normalizeDecision('   ', 'validator')).toBe('');
    });
  });

  // ─── normalizeOutput — score resolution ─────────────────────────────

  describe('normalizeOutput score resolution', () => {
    it('resolves numeric score directly', () => {
      const result = normalizer.normalizeOutput({ score: 85, decision: 'PASS' }, 'validator');
      expect(result.score).toBe(85);
    });

    it('resolves string score via parseFloat', () => {
      const result = normalizer.normalizeOutput({ score: '72.5', decision: 'PASS' }, 'validator');
      expect(result.score).toBe(72.5);
    });

    it('guards against NaN from unparseable string scores', () => {
      const result = normalizer.normalizeOutput({ score: 'excellent', decision: 'PASS' }, 'validator');
      expect(result.score).toBeUndefined();
    });

    it('guards against NaN from empty string score', () => {
      const result = normalizer.normalizeOutput({ score: '', decision: 'PASS' }, 'validator');
      expect(result.score).toBeUndefined();
    });

    it('resolves score from nested result object', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        result: { score: 90 },
      }, 'validator');
      expect(result.score).toBe(90);
    });

    it('computes score from categories when no direct score', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        categories: [
          { name: 'Quality', score: 25, maxScore: 30 },
          { name: 'Safety', score: 18, maxScore: 20 },
        ],
      }, 'validator');
      expect(result.score).toBe(43);
    });

    it('resolves maxScore from string with NaN guard', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 85,
        max_score: 'N/A',
      }, 'validator');
      expect(result.maxScore).toBeUndefined();
    });

    it('resolves maxScore from valid string', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 85,
        max_score: '100',
      }, 'validator');
      expect(result.maxScore).toBe(100);
    });
  });

  // ─── parseCategories — provider max-key and score-shape variants ─────
  // Regression for issue 185be486: gpt-5.x category output rendered /100
  // with max 0 because 'max'/'max_score' keys were unrecognized.
  describe('category max-score variants', () => {
    it('accepts max as the category scale key', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 86,
        categories: [{ name: 'structural_completeness', score: 21, max: 25 }],
      }, 'validator');
      expect(result.categories?.[0]?.maxScore).toBe(25);
    });

    it('accepts max_score as the category scale key', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 86,
        categories: [{ name: 'Quality', score: 18, max_score: 20 }],
      }, 'validator');
      expect(result.categories?.[0]?.maxScore).toBe(20);
    });

    it('parses fraction-string category scores with denominator as scale', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 86,
        categories: [{ name: 'Quality', score: '21/25' }],
      }, 'validator');
      expect(result.categories?.[0]?.score).toBe(21);
      expect(result.categories?.[0]?.maxScore).toBe(25);
    });

    it('prefers an explicit max key over a fraction denominator', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 86,
        categories: [{ name: 'Quality', score: '21/25', max: 30 }],
      }, 'validator');
      expect(result.categories?.[0]?.maxScore).toBe(30);
    });

    it('treats a zero max as broken scale data and defaults to 100', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 86,
        categories: [{ name: 'Quality', score: 21, max: 0 }],
      }, 'validator');
      expect(result.categories?.[0]?.maxScore).toBe(100);
    });

    it('nulls the pair for an unparseable non-fraction score string', () => {
      const result = normalizer.normalizeOutput({
        decision: 'PASS',
        score: 86,
        categories: [{ name: 'Quality', score: 'excellent' }],
      }, 'validator');
      expect(result.categories?.[0]?.score).toBeNull();
      expect(result.categories?.[0]?.maxScore).toBeNull();
    });
  });

  // ─── normalizeOutput — issue resolution via categories ──────────────

  describe('normalizeOutput issue resolution', () => {
    it('resolves issues from recommendations array into category findings', () => {
      const result = normalizer.normalizeOutput({
        decision: 'FAIL',
        score: 60,
        recommendations: [
          { title: 'Fix bug', severity: 'high', description: 'Something broke' },
        ],
      }, 'validator');
      // Issues are attached as findings within categories
      expect(result.categories).toBeDefined();
      const allIssues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(allIssues.length).toBeGreaterThanOrEqual(1);
      expect(allIssues.some(i => i.title === 'Fix bug')).toBe(true);
    });

    it('resolves issues from nested issues_found structure', () => {
      const result = normalizer.normalizeOutput({
        decision: 'FAIL',
        score: 65,
        issues_found: {
          critical: [{ title: 'SQL injection', description: 'Unparameterized query' }],
          warnings: [{ title: 'Missing test', description: 'No coverage' }],
        },
      }, 'validator');
      expect(result.categories).toBeDefined();
      const allIssues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(allIssues.length).toBeGreaterThanOrEqual(2);
    });

    it('resolves Gemini growth_trajectory_assessment shape', () => {
      const result = normalizer.normalizeOutput({
        decision: 'VITAL',
        score: 78,
        growth_trajectory_assessment: [
          {
            dimension: 'Modularity',
            current_state: 'Monolithic',
            latent_capability: 'Microservices',
            impediment: 'Tight coupling between auth and billing',
          },
        ],
      }, 'analyst');
      expect(result.categories).toBeDefined();
      const allIssues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(allIssues.length).toBeGreaterThanOrEqual(1);
      expect(allIssues.some(i => i.title.includes('Growth impediment'))).toBe(true);
      expect(allIssues.some(i => i.description!.includes('Tight coupling'))).toBe(true);
    });

    it('resolves Gemini growth_trajectory variant key', () => {
      const result = normalizer.normalizeOutput({
        decision: 'VITAL',
        growth_trajectory: [
          { dimension: 'Scale', impediment: 'Single database bottleneck' },
        ],
      }, 'analyst');
      expect(result.categories).toBeDefined();
      const allIssues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(allIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('resolves Gemini purpose_coherence_assessment conflicts', () => {
      const result = normalizer.normalizeOutput({
        decision: 'ATELEOLOGICAL',
        score: 55,
        purpose_coherence_assessment: {
          purpose_conflicts: 'The API serves both internal and external consumers with conflicting SLAs',
        },
      }, 'analyst');
      expect(result.categories).toBeDefined();
      const allIssues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(allIssues.some(i => i.title === 'Purpose conflict identified')).toBe(true);
    });

    it('filters out non-substantive purpose conflicts', () => {
      const result = normalizer.normalizeOutput({
        decision: 'TELEOLOGICAL',
        score: 90,
        purpose_coherence_assessment: {
          purpose_conflicts: 'No significant conflicts were identified',
        },
      }, 'analyst');
      const allIssues = (result.categories ?? []).flatMap(c => c.findings.flatMap(f => f.issues));
      const purposeIssues = allIssues.filter(i => i.title === 'Purpose conflict identified');
      expect(purposeIssues).toHaveLength(0);
    });
  });

  // ─── normalizeOutput — edge cases ───────────────────────────────────

  describe('normalizeOutput edge cases', () => {
    it('returns ERROR decision for null input', () => {
      const result = normalizer.normalizeOutput(null, 'validator');
      expect(result.decision).toBe('ERROR');
    });

    it('returns ERROR decision for non-object input', () => {
      const result = normalizer.normalizeOutput('just a string', 'validator');
      expect(result.decision).toBe('ERROR');
    });

    it('resolves decision from nested result.decision', () => {
      const result = normalizer.normalizeOutput({
        result: { decision: 'HARMONIOUS', score: 88 },
      }, 'analyst');
      expect(result.decision).toBe('HARMONIOUS');
    });

    it('preserves rawJson reference', () => {
      const input = { decision: 'PASS', score: 100 };
      const result = normalizer.normalizeOutput(input, 'validator');
      expect(result.rawJson).toBe(input);
    });

    it('parses artifacts when present', () => {
      const result = normalizer.normalizeOutput({
        decision: 'COMPLETE',
        artifacts: [
          { type: 'file', path: 'output.txt', description: 'Generated file' },
        ],
      }, 'executor');
      expect(result.artifacts).toHaveLength(1);
    });
  });
});
