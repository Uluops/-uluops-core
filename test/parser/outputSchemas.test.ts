import { describe, it, expect } from 'vitest';
import { agentOutputSchema } from '../../src/parser/outputSchemas.js';
import { z } from 'zod';

/** Base valid output — all nullable analysis fields set to null */
const baseOutput = {
  explorationMaps: null,
  epistemicAssessment: null,
  auditImplications: null,
  analysisRecords: null,
  domainMetrics: null,
};

describe('agentOutputSchema', () => {
  describe('categories', () => {
    it('accepts valid output with categories', () => {
      const valid = {
        decision: 'PASS',
        score: 85,
        maxScore: 100,
        summary: 'All checks passed',
        categories: [{
          name: 'Code Quality',
          score: 40,
          maxScore: 50,
          findings: [{
            criterion: 'No lint errors',
            pointsEarned: 40,
            pointsPossible: 50,
            issues: [],
          }],
        }],
        artifacts: null,
        ...baseOutput,
      };
      // Not a round-trip any more: explicit nulls on optional fields are coerced to
      // absent, so parse(valid) is intentionally NOT deep-equal to `valid`. Assert the
      // fields that must survive rather than identity.
      const parsed = agentOutputSchema.parse(valid);
      expect(parsed).toMatchObject({ decision: valid.decision, score: valid.score, maxScore: valid.maxScore });
    });

    it('accepts null categories', () => {
      const result = agentOutputSchema.parse({
        decision: 'PASS',
        score: 90,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      });
      // Null is coerced to absent by optionalNullTolerant — the schema no longer
      // emits a union for this field, which is what keeps it under Anthropic's ceiling.
      expect(result.categories).toBeUndefined();
    });

    it('accepts issues with all nullable fields as null', () => {
      const result = agentOutputSchema.parse({
        decision: 'FAIL',
        score: 30,
        maxScore: 100,
        summary: null,
        categories: [{
          name: 'Security',
          score: 10,
          maxScore: 50,
          findings: [{
            criterion: 'No injection',
            pointsEarned: 10,
            pointsPossible: 50,
            issues: [{
              title: 'SQL injection found',
              description: null,
              priority: null,
              severity: null,
              filePath: null,
              lineNumber: null,
              failureCode: null,
            }],
          }],
        }],
        artifacts: null,
        ...baseOutput,
      });
      expect(result.categories![0]!.findings[0]!.issues[0]!.title).toBe('SQL injection found');
    });

    it('validates issue priority enum', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'FAIL',
        score: 50,
        maxScore: 100,
        summary: null,
        categories: [{
          name: 'Test',
          score: 50,
          maxScore: 100,
          findings: [{
            criterion: 'Coverage',
            pointsEarned: 50,
            pointsPossible: 100,
            issues: [{
              title: 'Low coverage',
              description: null,
              priority: 'invalid_priority',
              severity: null,
              filePath: null,
              lineNumber: null,
              failureCode: null,
            }],
          }],
        }],
        artifacts: null,
        ...baseOutput,
      })).toThrow();
    });
  });

  describe('artifacts', () => {
    it('accepts valid output with artifacts', () => {
      const valid = {
        decision: 'COMPLETE',
        score: 100,
        maxScore: 100,
        summary: 'Generated report',
        categories: null,
        artifacts: [{
          type: 'file',
          path: '/tmp/report.md',
          content: '# Report',
        }],
        ...baseOutput,
      };
      // Not a round-trip any more: explicit nulls on optional fields are coerced to
      // absent, so parse(valid) is intentionally NOT deep-equal to `valid`. Assert the
      // fields that must survive rather than identity.
      const parsed = agentOutputSchema.parse(valid);
      expect(parsed).toMatchObject({ decision: valid.decision, score: valid.score, maxScore: valid.maxScore });
    });

    it('accepts null artifacts', () => {
      const result = agentOutputSchema.parse({
        decision: 'COMPLETE',
        score: 100,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      });
      // Null is coerced to absent by optionalNullTolerant — see the categories case.
      expect(result.artifacts).toBeUndefined();
    });

    it('accepts artifacts with null path and content', () => {
      const result = agentOutputSchema.parse({
        decision: 'COMPLETE',
        score: 80,
        maxScore: 100,
        summary: 'Done',
        categories: null,
        artifacts: [{ type: 'report', path: null, content: null }],
        ...baseOutput,
      });
      expect(result.artifacts![0]!.type).toBe('report');
    });
  });

  describe('score validation', () => {
    // Range (0-100) is NO LONGER enforced at the schema layer. The structured-output
    // spike (0a) found Anthropic rejects min/max on numbers in structured mode, so
    // agentOutputSchema uses bare z.number().nullable() and range enforcement moved to
    // the AgentExecutor mapping layer. These tests now assert the schema is permissive;
    // the clamp/warn behavior is tested in AgentExecutor.test.ts (Phase 3).
    it('accepts score above 100 (range enforced downstream at AgentExecutor, not schema)', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: 150,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).not.toThrow();
    });

    it('accepts score below 0 (range enforced downstream at AgentExecutor, not schema)', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: -5,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).not.toThrow();
    });

    it('accepts null score and null maxScore (generators/executors)', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'COMPLETE',
        score: null,
        maxScore: null,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).not.toThrow();
    });

    it('rejects missing required fields', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
      })).toThrow();
    });
  });

  describe('constraint rejection', () => {
    it('rejects non-string decision', () => {
      expect(() => agentOutputSchema.parse({
        decision: 123,
        score: 50,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).toThrow();
    });

    it('rejects non-number score', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: 'not-a-number',
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).toThrow();
    });

    it('rejects malformed categories array', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: 80,
        maxScore: 100,
        summary: null,
        categories: [{ wrong: 'shape' }],
        artifacts: null,
        ...baseOutput,
      })).toThrow();
    });

    it('rejects category with missing findings array', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: 80,
        maxScore: 100,
        summary: null,
        categories: [{ name: 'Test', score: 80, maxScore: 100 }],
        artifacts: null,
        ...baseOutput,
      })).toThrow();
    });
  });

  describe('universal schema', () => {
    it('accepts custom decision vocabularies', () => {
      const result = agentOutputSchema.parse({
        decision: 'EXAMINED',
        score: 75,
        maxScore: 100,
        summary: 'Socratic examination complete',
        categories: null,
        artifacts: null,
        ...baseOutput,
      });
      expect(result.decision).toBe('EXAMINED');
    });

    it('accepts both categories and artifacts together', () => {
      const result = agentOutputSchema.parse({
        decision: 'COMPLETE',
        score: 88,
        maxScore: 100,
        summary: 'Analysis with generated report',
        categories: [{
          name: 'Analysis',
          score: 88,
          maxScore: 100,
          findings: [{
            criterion: 'Depth',
            pointsEarned: 88,
            pointsPossible: 100,
            issues: [],
          }],
        }],
        artifacts: [{
          type: 'report',
          path: '/tmp/analysis.md',
          content: '# Analysis Report',
        }],
        ...baseOutput,
      });
      expect(result.categories).toHaveLength(1);
      expect(result.artifacts).toHaveLength(1);
    });
  });

  describe('analysis extension fields', () => {
    it('accepts exploration maps from explorer agents', () => {
      const result = agentOutputSchema.parse({
        decision: 'EXPLORED',
        score: 0,
        maxScore: 100,
        summary: 'Structural mapping complete',
        categories: null,
        artifacts: null,
        epistemicAssessment: null,
        auditImplications: null,
        analysisRecords: null,
        domainMetrics: null,
        explorationMaps: [{
          metadata: {
            explorerName: 'bateson-explorer',
            framework: 'logical-levels',
            artifactPath: null,
          },
          sections: [{
            type: 'topology',
            label: 'Level Map',
            summary: 'Four distinct communication levels identified',
            entries: [
              { key: 'entity:code', value: 'Level 1 — implementation layer' },
              { key: 'entity:docs', value: 'Level 2 — documentation layer' },
              { key: 'rel:code→docs', value: 'describes' },
            ],
          }],
        }],
      });
      expect(result.explorationMaps).toHaveLength(1);
      expect(result.explorationMaps![0]!.metadata.explorerName).toBe('bateson-explorer');
      expect(result.explorationMaps![0]!.sections[0]!.type).toBe('topology');
    });

    it('accepts epistemic assessment from cognitive lens agents', () => {
      const result = agentOutputSchema.parse({
        decision: 'EXAMINED',
        score: 72,
        maxScore: 100,
        summary: 'Epistemic audit complete',
        categories: null,
        artifacts: null,
        explorationMaps: null,
        auditImplications: null,
        analysisRecords: null,
        domainMetrics: null,
        epistemicAssessment: {
          confidence: 'high',
          groundingRatio: 0.85,
          keyUncertainties: ['Coverage of private modules unknown'],
          methodology: 'Epictetan impression analysis',
        },
      });
      expect(result.epistemicAssessment!.confidence).toBe('high');
      expect(result.epistemicAssessment!.groundingRatio).toBe(0.85);
    });

    it('accepts audit implications from forecaster agents', () => {
      const result = agentOutputSchema.parse({
        decision: 'HIGH_CONFIDENCE',
        score: 65,
        maxScore: 100,
        summary: 'Trajectory projection complete',
        categories: null,
        artifacts: null,
        explorationMaps: null,
        epistemicAssessment: null,
        analysisRecords: null,
        domainMetrics: null,
        auditImplications: [
          'Temporal decay risk in auth module within 6 months',
          'Naming drift accelerating — 3 conventions competing',
          'Dual-database pattern creating growing operational burden',
        ],
      });
      expect(result.auditImplications).toHaveLength(3);
    });

    it('accepts all analysis fields together', () => {
      const result = agentOutputSchema.parse({
        decision: 'EXPLORED',
        score: 78,
        maxScore: 100,
        summary: 'Full analysis',
        categories: null,
        artifacts: null,
        explorationMaps: [{
          metadata: { explorerName: 'test', framework: 'test', artifactPath: null },
          sections: [],
        }],
        epistemicAssessment: {
          confidence: 'medium',
          groundingRatio: null,
          keyUncertainties: null,
          methodology: null,
        },
        auditImplications: ['Risk identified'],
        analysisRecords: [{
          recordType: 'commitment',
          recordId: 'R-1',
          title: 'Test commitment',
          classification: 'PROMISING',
          severity: null,
          data: [{ key: 'status', value: 'confirmed' }],
        }],
        domainMetrics: [
          { key: 'atomsIdentified', value: '20' },
          { key: 'decompositionFit', value: 'HIGH' },
        ],
      });
      expect(result.explorationMaps).toHaveLength(1);
      expect(result.epistemicAssessment!.confidence).toBe('medium');
      expect(result.auditImplications).toHaveLength(1);
      expect(result.analysisRecords).toHaveLength(1);
      expect(result.analysisRecords![0]!.recordType).toBe('commitment');
      expect(result.domainMetrics).toHaveLength(2);
      expect(result.domainMetrics![0]!.key).toBe('atomsIdentified');
    });
  });
});

/**
 * `z.number()` accepts Infinity — the schema confers a trust it does not verify.
 *
 * POSITIVE CONTROL: remove `.finite()` from any field below and its test fails.
 *
 * Verified against the pinned zod (3.25.76), with a control proving the probe is not
 * vacuous — NaN IS rejected, so the schema is genuinely running:
 *
 *     Infinity   ACCEPTED -> Infinity      -Infinity  ACCEPTED
 *     NaN        rejected                  5.5        ACCEPTED
 *
 * This matters more here than anywhere else in the package: OutputExtractor treats the
 * structured-output path as extraction confidence 1.0 BECAUSE the SDK schema-validated it.
 * An unconstrained `z.number()` therefore stamps `Infinity` as trustworthy, and
 * `Infinity < threshold` is `false`, so it fail-opens a gate — the same shape as the
 * NaN-weight and the inert-budget defects, arriving through the most-trusted rung.
 */
describe('outputSchemas — numeric fields reject non-finite values', () => {
  const base = {
    decision: 'PASS',
    summary: null,
    categories: null,
    artifacts: null,
    ...baseOutput,
  };

  it('proves the control: bare z.number() DOES accept Infinity', () => {
    // If this ever starts failing, zod changed its default and the `.finite()` calls below
    // may be redundant — but verify before removing them.
    expect(z.number().safeParse(Infinity).success).toBe(true);
    expect(z.number().safeParse(NaN).success).toBe(false);
  });

  it.each([[Infinity], [-Infinity]])('rejects a non-finite top-level score (%s)', (bad) => {
    expect(agentOutputSchema.safeParse({ ...base, score: bad, maxScore: 100 }).success).toBe(false);
  });

  it('rejects a non-finite per-category score', () => {
    // These nested fields have NO downstream clamp of any kind — unlike the top-level
    // score, which AgentExecutor clamps to [0,100] with a warning. They flow to consumers
    // as-is, which is why the schema is their only seam.
    expect(agentOutputSchema.safeParse({
      ...base, score: 80, maxScore: 100,
      categories: [{ name: 'x', score: Infinity, maxScore: 100 }],
    }).success).toBe(false);
  });

  it('STILL accepts an out-of-range but finite score — the negative control', () => {
    // Range is deliberately enforced downstream at AgentExecutor (clamp + warn), not here.
    // Without this assertion, "rejects bad numbers" would pass for a schema that had
    // swallowed the range contract too, replacing a visible warning with a silent reject.
    expect(agentOutputSchema.safeParse({ ...base, score: -5, maxScore: 100 }).success).toBe(true);
    expect(agentOutputSchema.safeParse({ ...base, score: 5000, maxScore: 100 }).success).toBe(true);
  });
});
