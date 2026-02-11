import { describe, it, expect } from 'vitest';
import { OutputExtractor } from '../../src/parser/OutputExtractor.js';
import { ParseError } from '../../src/errors/index.js';

describe('OutputExtractor', () => {
  const extractor = new OutputExtractor();

  describe('JSON code fence extraction', () => {
    it('extracts from json code fence', () => {
      const content = `Here is my analysis:

\`\`\`json
{
  "decision": "PASS",
  "score": 85,
  "maxScore": 100
}
\`\`\``;
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.method).toBe('json_code_fence');
      expect(result.confidence).toBe(0.95);
      expect(result.output.decision).toBe('PASS');
      expect(result.output.score).toBe(85);
      expect(result.output.maxScore).toBe(100);
    });

    it('uses last code fence when multiple present', () => {
      const content = `Some context:
\`\`\`json
{"decision": "FAIL", "score": 20}
\`\`\`

After further analysis:
\`\`\`json
{"decision": "PASS", "score": 85}
\`\`\``;
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(85);
    });

    it('handles bare code fence without json tag', () => {
      const content = `\`\`\`
{"decision": "PASS", "score": 90}
\`\`\``;
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.method).toBe('json_code_fence');
      expect(result.output.decision).toBe('PASS');
    });
  });

  describe('inline JSON extraction', () => {
    it('extracts inline JSON with decision field', () => {
      const content = 'The result is {"decision": "PASS", "score": 77} and that is final.';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.method).toBe('inline_json');
      expect(result.confidence).toBe(0.75);
      expect(result.output.decision).toBe('PASS');
      expect(result.output.score).toBe(77);
    });

    it('handles nested JSON objects', () => {
      const content = 'Result: {"decision": "FAIL", "score": 30, "details": {"reason": "test"}}';
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('FAIL');
      expect(result.score).toBe(30);
    });
  });

  describe('structured text extraction', () => {
    it('extracts decision and score from text patterns', () => {
      const content = 'Decision: PASS\nScore: 85\nMax Score: 100';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.method).toBe('structured_text');
      expect(result.confidence).toBe(0.5);
      expect(result.output.decision).toBe('PASS');
      expect(result.output.score).toBe(85);
      expect(result.output.maxScore).toBe(100);
    });

    it('handles various decision formats', () => {
      const content = 'status = success\npoints = 92';
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(92);
    });

    it('only extracts maxScore for validators', () => {
      const content = 'Decision: complete\nScore: 50\nMax Score: 100';
      const result = extractor.extract(content, 'executor');
      expect(result.decision).toBe('COMPLETE');
      expect(result.score).toBe(50);
      expect(result.maxScore).toBeUndefined();
    });
  });

  describe('decision normalization', () => {
    it('normalizes validator decisions', () => {
      expect(extractDecision('PASSED', 'validator')).toBe('PASS');
      expect(extractDecision('OK', 'validator')).toBe('PASS');
      expect(extractDecision('WARNING', 'validator')).toBe('WARN');
      expect(extractDecision('FAILED', 'validator')).toBe('FAIL');
      expect(extractDecision('REJECT', 'validator')).toBe('FAIL');
    });

    it('normalizes executor decisions', () => {
      expect(extractDecision('SUCCESS', 'executor')).toBe('COMPLETE');
      expect(extractDecision('DONE', 'executor')).toBe('COMPLETE');
      expect(extractDecision('INCOMPLETE', 'executor')).toBe('PARTIAL');
      expect(extractDecision('ERROR', 'executor')).toBe('FAILED');
    });
  });

  describe('categories parsing (validators)', () => {
    it('parses categories from JSON output', () => {
      const content = `\`\`\`json
{
  "decision": "PASS",
  "score": 85,
  "maxScore": 100,
  "categories": [
    {
      "name": "Security",
      "score": 40,
      "maxPoints": 50,
      "findings": [
        {
          "criterion": "Input validation",
          "pointsEarned": 8,
          "pointsPossible": 10,
          "issues": [
            {
              "title": "Missing XSS protection",
              "priority": "critical",
              "severity": "high",
              "filePath": "src/app.ts",
              "lineNumber": 42,
              "description": "Input not sanitized"
            }
          ]
        }
      ]
    }
  ]
}
\`\`\``;
      const result = extractor.extract(content, 'validator');
      expect(result.categories).toHaveLength(1);
      const category = result.categories![0]!;
      expect(category.name).toBe('Security');
      expect(category.score).toBe(40);
      expect(category.findings).toHaveLength(1);
      expect(category.findings[0]!.issues).toHaveLength(1);
      expect(category.findings[0]!.issues[0]!.title).toBe('Missing XSS protection');
      expect(category.findings[0]!.issues[0]!.priority).toBe('critical');
    });
  });

  describe('artifacts parsing (executors)', () => {
    it('parses artifacts from JSON output', () => {
      const content = `\`\`\`json
{
  "decision": "COMPLETE",
  "artifacts": [
    { "name": "report.pdf", "path": "/output/report.pdf", "size": 1024, "contentType": "application/pdf" }
  ]
}
\`\`\``;
      const result = extractor.extract(content, 'executor');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts![0]!.name).toBe('report.pdf');
      expect(result.artifacts![0]!.size).toBe(1024);
    });
  });

  describe('error handling', () => {
    it('returns ERROR output when extraction fails', () => {
      const result = extractor.extractWithMetadata('Random gibberish without any structure', 'validator');
      expect(result.output.decision).toBe('ERROR');
      expect(result.output.score).toBe(0);
      expect(result.confidence).toBe(0);
    });

    it('throws ParseError in strict mode', () => {
      expect(() => {
        extractor.extract('No structure here', 'validator', { strict: true });
      }).toThrow(ParseError);
    });

    it('handles empty string input', () => {
      const result = extractor.extractWithMetadata('', 'validator');
      expect(result.output.decision).toBe('ERROR');
      expect(result.output.score).toBe(0);
      expect(result.confidence).toBe(0);
    });

    it('handles whitespace-only input', () => {
      const result = extractor.extractWithMetadata('   \n\n\t  ', 'validator');
      expect(result.output.decision).toBe('ERROR');
      expect(result.output.score).toBe(0);
    });

    it('handles JSON with missing decision field', () => {
      const content = '```json\n{"score": 85, "maxScore": 100}\n```';
      const result = extractor.extract(content, 'validator');
      // Should still extract with a default/derived decision
      expect(result.score).toBe(85);
      expect(typeof result.decision).toBe('string');
    });

    it('handles nested result wrapper', () => {
      const content = '```json\n{"result": {"decision": "PASS", "score": 85}}\n```';
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(85);
    });

    it('handles score of zero as valid (not undefined)', () => {
      const content = '```json\n{"decision": "FAIL", "score": 0, "maxScore": 100}\n```';
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('FAIL');
      expect(result.score).toBe(0);
      expect(result.maxScore).toBe(100);
    });

    it('handles truncated JSON in code fence', () => {
      const content = '```json\n{"decision": "PASS", "score": 85, "categories": [\n```';
      const result = extractor.extractWithMetadata(content, 'validator');
      // Should either extract partial data or fall through to other methods
      expect(result.output).toBeDefined();
      expect(typeof result.output.decision).toBe('string');
    });

    it('only unwraps one level of result nesting', () => {
      const content = '```json\n{"result": {"result": {"decision": "PASS", "score": 90}}}\n```';
      const result = extractor.extract(content, 'validator');
      // Double-nested result.result is not unwrapped — only one level
      expect(result.decision).toBe('UNKNOWN');
    });
  });

  describe('score parsing', () => {
    it('handles string scores in JSON', () => {
      const content = '```json\n{"decision": "PASS", "score": "85"}\n```';
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(85);
    });

    it('handles max_score alias', () => {
      const content = '```json\n{"decision": "PASS", "score": 85, "max_score": 100}\n```';
      const result = extractor.extract(content, 'validator');
      expect(result.maxScore).toBe(100);
    });
  });

  describe('priority normalization', () => {
    it('maps priority aliases correctly', () => {
      const content = `\`\`\`json
{
  "decision": "FAIL",
  "score": 30,
  "categories": [{
    "name": "Test",
    "score": 0,
    "maxPoints": 50,
    "findings": [{
      "criterion": "Test",
      "pointsEarned": 0,
      "pointsPossible": 10,
      "issues": [
        { "title": "A", "priority": "high", "severity": "critical", "description": "test" },
        { "title": "B", "priority": "p0", "severity": "high", "description": "test" },
        { "title": "C", "priority": "low", "severity": "info", "description": "test" }
      ]
    }]
  }]
}
\`\`\``;
      const result = extractor.extract(content, 'validator');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues[0]!.priority).toBe('critical');
      expect(issues[1]!.priority).toBe('critical');
      expect(issues[2]!.priority).toBe('backlog');
    });
  });

  describe('warnings population', () => {
    it('returns empty warnings for json code fence extraction', () => {
      const content = '```json\n{"decision": "PASS", "score": 90}\n```';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.warnings).toEqual([]);
      expect(result.warnings.length).toBe(0);
    });

    it('returns non-empty warnings for inline JSON extraction', () => {
      const content = 'The result is {"decision": "PASS", "score": 90}';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('inline JSON');
    });

    it('returns non-empty warnings for structured text fallback', () => {
      const content = 'Decision: PASS\nScore: 75\nMax Score: 100';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('structured text');
    });

    it('returns warning when extraction fails completely', () => {
      const content = 'This has no structured data at all.';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.warnings).toEqual(['Could not extract structured output from response']);
    });
  });
});

function extractDecision(decision: string, agentType: 'validator' | 'executor'): string {
  const extractor = new OutputExtractor();
  const content = `\`\`\`json\n{"decision": "${decision}"}\n\`\`\``;
  return extractor.extract(content, agentType).decision;
}
