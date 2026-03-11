import { describe, it, expect } from 'vitest';
import { validatorOutputSchema, executorOutputSchema, genericOutputSchema } from '../../src/parser/outputSchemas';

describe('outputSchemas', () => {
  describe('validatorOutputSchema', () => {
    it('accepts valid validator output', () => {
      const valid = {
        decision: 'PASS',
        score: 85,
        maxScore: 100,
        summary: 'All checks passed',
        categories: [{
          name: 'Code Quality',
          score: 40,
          maxPoints: 50,
          findings: [{
            criterion: 'No lint errors',
            pointsEarned: 40,
            pointsPossible: 50,
            issues: [],
          }],
        }],
      };
      expect(validatorOutputSchema.parse(valid)).toEqual(valid);
    });

    it('accepts null categories', () => {
      const result = validatorOutputSchema.parse({
        decision: 'PASS',
        score: 90,
        maxScore: 100,
        summary: null,
        categories: null,
      });
      expect(result.categories).toBeNull();
    });

    it('rejects score above 100', () => {
      expect(() => validatorOutputSchema.parse({
        decision: 'PASS',
        score: 150,
        maxScore: 100,
        summary: null,
        categories: null,
      })).toThrow();
    });

    it('rejects score below 0', () => {
      expect(() => validatorOutputSchema.parse({
        decision: 'PASS',
        score: -5,
        maxScore: 100,
        summary: null,
        categories: null,
      })).toThrow();
    });

    it('accepts issues with all nullable fields as null', () => {
      const result = validatorOutputSchema.parse({
        decision: 'FAIL',
        score: 30,
        maxScore: 100,
        summary: null,
        categories: [{
          name: 'Security',
          score: 10,
          maxPoints: 50,
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
      });
      expect(result.categories![0].findings[0].issues[0].title).toBe('SQL injection found');
    });

    it('validates issue priority enum', () => {
      expect(() => validatorOutputSchema.parse({
        decision: 'FAIL',
        score: 50,
        maxScore: 100,
        summary: null,
        categories: [{
          name: 'Test',
          score: 50,
          maxPoints: 100,
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
      })).toThrow();
    });
  });

  describe('executorOutputSchema', () => {
    it('accepts valid executor output with artifacts', () => {
      const valid = {
        decision: 'COMPLETE',
        score: 100,
        maxScore: 100,
        summary: 'Generated report',
        artifacts: [{
          type: 'file',
          path: '/tmp/report.md',
          content: '# Report',
        }],
      };
      expect(executorOutputSchema.parse(valid)).toEqual(valid);
    });

    it('accepts null artifacts', () => {
      const result = executorOutputSchema.parse({
        decision: 'COMPLETE',
        score: 100,
        maxScore: 100,
        summary: null,
        artifacts: null,
      });
      expect(result.artifacts).toBeNull();
    });

    it('accepts artifacts with null path and content', () => {
      const result = executorOutputSchema.parse({
        decision: 'COMPLETE',
        score: 80,
        maxScore: 100,
        summary: 'Done',
        artifacts: [{ type: 'report', path: null, content: null }],
      });
      expect(result.artifacts![0].type).toBe('report');
    });
  });

  describe('genericOutputSchema', () => {
    it('accepts minimal valid output', () => {
      const result = genericOutputSchema.parse({
        decision: 'EXAMINED',
        score: 75,
        maxScore: 100,
        summary: null,
      });
      expect(result.decision).toBe('EXAMINED');
    });

    it('rejects missing required fields', () => {
      expect(() => genericOutputSchema.parse({
        decision: 'PASS',
      })).toThrow();
    });
  });
});
