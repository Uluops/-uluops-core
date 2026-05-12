import { describe, it, expect } from 'vitest';
import { agentOutputSchema } from '../../src/parser/outputSchemas';

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
      expect(agentOutputSchema.parse(valid)).toEqual(valid);
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
      expect(result.categories).toBeNull();
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
      expect(result.categories![0].findings[0].issues[0].title).toBe('SQL injection found');
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
      expect(agentOutputSchema.parse(valid)).toEqual(valid);
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
      expect(result.artifacts).toBeNull();
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
      expect(result.artifacts![0].type).toBe('report');
    });
  });

  describe('score validation', () => {
    it('rejects score above 100', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: 150,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).toThrow();
    });

    it('rejects score below 0', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
        score: -5,
        maxScore: 100,
        summary: null,
        categories: null,
        artifacts: null,
        ...baseOutput,
      })).toThrow();
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
      expect(result.explorationMaps![0].metadata.explorerName).toBe('bateson-explorer');
      expect(result.explorationMaps![0].sections[0].type).toBe('topology');
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
      expect(result.analysisRecords![0].recordType).toBe('commitment');
      expect(result.domainMetrics).toHaveLength(2);
      expect(result.domainMetrics![0].key).toBe('atomsIdentified');
    });
  });
});
