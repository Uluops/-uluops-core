import { describe, it, expect } from 'vitest';
import { agentOutputSchema } from '../../src/parser/outputSchemas';

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
      })).toThrow();
    });

    it('rejects missing required fields', () => {
      expect(() => agentOutputSchema.parse({
        decision: 'PASS',
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
      });
      expect(result.categories).toHaveLength(1);
      expect(result.artifacts).toHaveLength(1);
    });
  });
});
