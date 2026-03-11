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

  describe('cross-model JSON shapes', () => {
    // Failure Mode 1: score is an object { total: N, ... } (gpt-5-codex, gpt-5.1-codex)
    it('handles score as nested object with total (gpt-5-codex shape)', () => {
      const content = JSON.stringify({
        score: { total: 85, code_quality: 15, standards_compliance: 25, testing: 25, best_practices: 20 },
        decision: 'PASS',
        issues: [
          { title: 'Large function', severity: 'M', failure_code: 'PRA-FRA/M', file: 'src/renderer.ts', line: 27 }
        ],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(85);
    });

    // Failure Mode 2: decision is an object { pass: true, label: "PASS" } (gpt-5)
    it('handles decision as object with label (gpt-5 shape)', () => {
      const content = JSON.stringify({
        report: {
          summary: { score: 97, code_quality: 27, standards_compliance: 25, testing: 25, best_practices: 20 },
        },
        decision: { pass: true, label: 'PASS - Ready for next phase' },
        issues: { total_issues: 4, items: [
          { title: 'Large function', category: 'Code Quality', file: 'src/renderer.ts', line: 27, failure_code: 'PRA-FRA/M' }
        ]},
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(97);
      expect(result.categories).toBeDefined();
    });

    it('handles decision as object with result key (gpt-5-mini variant)', () => {
      const content = JSON.stringify({
        score: 92,
        decision: { result: 'PASS', explanation: 'Score 92/100 >= 70' },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(92);
    });

    it('handles string summary as decision fallback', () => {
      const content = JSON.stringify({
        summary: 'PASS — ready for next phase',
        score: 92,
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
    });

    it('handles decision as object with pass boolean (false)', () => {
      const content = JSON.stringify({
        decision: { pass: false, label: 'FAIL - Issues found' },
        score: 45,
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('FAIL');
      expect(result.score).toBe(45);
    });

    // Failure Mode 3: score/decision nested under summary (gpt-5-mini)
    it('handles score and decision under summary (gpt-5-mini shape)', () => {
      const content = JSON.stringify({
        summary: {
          score: 93,
          decision: 'PASS',
          reasoning_short: 'Comprehensive test suite present',
        },
        scores: {
          'Code Quality': 23,
          'Standards Compliance': 25,
          'Testing': 25,
          'Best Practices': 20,
          'Total': 93,
          'pass_threshold': 70,
        },
        issues_found: {
          critical: [],
          warnings: [
            { title: 'Large function', file_line: 'src/adl-context-builder.ts:97-169', failure_code: 'PRA-FRA/M', explanation: 'buildADLContext() is ~72 lines' },
          ],
          suggestions: [
            { title: 'Wrap transform phase', file_line: 'src/pipelines/cdl.ts:36-47', failure_code: 'SEM-COM/M', explanation: 'Pipeline should catch errors' },
          ],
        },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(93);
      expect(result.categories).toBeDefined();
      expect(result.categories!.length).toBeGreaterThan(0);
    });

    // Failure Mode 4: no total score, only category sub-scores (gpt-4.1-nano)
    it('sums category sub-scores when no total exists (gpt-4.1-nano shape)', () => {
      const content = JSON.stringify({
        criteria: {
          code_quality: { score: 20, issues: [{ file: 'src/index.ts', line: 96, issue: 'Function complexity' }] },
          standards_compliance: { score: 20, issues: [] },
          testing: { score: 20, issues: [] },
          best_practices: { score: 15, issues: [] },
        },
        decision: 'PASS',
        reason: 'Overall codebase meets thresholds',
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(75); // 20+20+20+15
      expect(result.categories).toHaveLength(4);
    });

    // Failure Mode 5: JSON inside markdown code fence (o4-mini)
    it('handles code-fenced JSON with nested validationResults (o4-mini shape)', () => {
      const content = '```json\n' + JSON.stringify({
        validationResults: {
          score: 95,
          breakdown: {
            'Code Quality': 30,
            'Standards Compliance': 24,
            'Testing': 25,
            'Best Practices': 16,
          },
        },
        issues: [
          { type: 'WARNING', file: 'eslint.config.js:5', failureCode: 'STR-INC/L', message: 'Minor config gap' },
        ],
        decision: 'PASS',
      }, null, 2) + '\n```';
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.method).toBe('json_code_fence');
      expect(result.output.decision).toBe('PASS');
      expect(result.output.score).toBe(95);
      expect(result.output.categories).toBeDefined();
    });

    // Breakdown without validationResults wrapper
    it('handles flat breakdown object (score sum fallback)', () => {
      const content = JSON.stringify({
        decision: 'PASS',
        breakdown: { 'Code Quality': 30, 'Standards': 25, 'Testing': 25, 'Practices': 20 },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(100); // 30+25+25+20
      expect(result.categories).toHaveLength(4);
    });

    // gpt-5-nano shape: flat issues array at top level + breakdown score object
    it('handles issues with locations array (gpt-5-nano shape)', () => {
      const content = JSON.stringify({
        score: 99,
        status: 'PASS',
        issues: [
          {
            severity: 'L',
            code: 'STR-OMI/L',
            message: 'buildOutputTemplate is a placeholder',
            location: 'src/transformer/adl-context-builder.ts',
            start_line: 292,
          },
        ],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(99);
    });

    // Issues with file_line combined field
    it('parses file_line combined field into filePath and lineNumber', () => {
      const content = JSON.stringify({
        decision: 'FAIL',
        score: 68,
        issues_found: {
          critical: [],
          warnings: [
            { title: 'Test issue', file_line: 'src/foo.ts:42-50', failure_code: 'PRA-FRA/M', explanation: 'Too long' },
          ],
          suggestions: [],
        },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('FAIL');
      expect(result.score).toBe(68);
      // Issues should be extracted from issues_found
      expect(result.categories).toBeDefined();
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues[0]!.filePath).toBe('src/foo.ts');
      expect(issues[0]!.lineNumber).toBe(42);
      expect(issues[0]!.failureCode).toBe('PRA-FRA/M');
    });

    // gpt-5-nano retest shape: score nested under validations wrapper
    it('handles score under validations wrapper (gpt-5-nano retest shape)', () => {
      const content = JSON.stringify({
        phase: 1,
        validations: {
          score: 100,
          breakdown: { CodeQuality: 30, StandardsCompliance: 25, Testing: 25, BestPractices: 20 },
        },
        decision: 'PASS - Ready for next phase',
        issuesFound: [],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(100);
      expect(result.categories).toBeDefined();
      expect(result.categories!.length).toBe(4);
    });

    // gpt-5-nano retest2 shape: validation_summary wrapper with final_decision
    it('handles validation_summary wrapper with final_decision (gpt-5-nano retest2 shape)', () => {
      const content = JSON.stringify({
        target_path: '/some/path',
        validation_summary: {
          status: 'PASS',
          score: 100,
          score_breakdown: { 'Code Quality': 30, 'Standards Compliance': 25, Testing: 25, 'Best Practices': 20 },
          threshold: 70,
        },
        issues_found: [],
        final_decision: 'PASS - Ready for next phase',
        reasoning_trace: [{ category: 'Code Quality', notes: 'Good' }],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(100);
      expect(result.categories).toBeDefined();
      expect(result.categories!.length).toBe(4);
    });

    // gpt-5-nano retest3 shape: arbitrary wrapper name with {points, deductions} breakdown
    it('handles arbitrary wrapper name with points/deductions breakdown', () => {
      const content = JSON.stringify({
        phase: 3,
        validation: {
          score: 100,
          breakdown: {
            CodeQuality: { points: 30, deductions: 0 },
            StandardsCompliance: { points: 25, deductions: 0 },
            Testing: { points: 25, deductions: 0 },
            BestPractices: { points: 20, deductions: 0 },
          },
        },
        decision: 'PASS',
        issues: [],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(100);
      expect(result.categories).toBeDefined();
      expect(result.categories!.length).toBe(4);
      expect(result.categories![0]!.score).toBe(30);
    });

    // FM12: score_total field name (gpt-5 shape)
    it('resolves score_total inside results wrapper', () => {
      const content = JSON.stringify({
        results: {
          score_total: 97,
          code_quality: 27,
          standards_compliance: 25,
          testing: 25,
          best_practices: 20,
        },
        decision: 'PASS',
        issues: [],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(97);
    });

    // Multi-step output: final JSON report at end of accumulated text
    it('extracts the last JSON object from multi-step output', () => {
      const content = [
        'I will now review the codebase.',
        '{"tool_call": "read_file", "path": "src/index.ts"}',
        'The code looks good. Let me check the tests.',
        '{"tool_call": "read_file", "path": "test/smoke.test.ts"}',
        'Here is my final assessment:',
        JSON.stringify({
          validation_results: { score: 90, breakdown: { CodeQuality: 28, Testing: 25 } },
          decision: { result: 'PASS', reasoning: 'Score 90 >= 70' },
          issues_found: [],
        }),
      ].join('\n');
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('PASS');
      expect(result.score).toBe(90);
    });

    // Issues with locations array (gpt-5 shape)
    it('parses issues with locations array', () => {
      const content = JSON.stringify({
        decision: 'FAIL',
        score: 85,
        issues: [
          {
            title: 'Unhandled rejection',
            severity: 'H',
            failure_code: 'SEM-COM/H',
            description: 'Pipeline missing try/catch',
            locations: [{ file: 'src/pipelines/cdl.ts', line_start: 36, line_end: 48 }],
          },
        ],
      });
      const result = extractor.extract(content, 'validator');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues[0]!.filePath).toBe('src/pipelines/cdl.ts');
      expect(issues[0]!.lineNumber).toBe(36);
    });

    it('should extract issues from recommendations array (gpt-5-codex shape)', () => {
      const content = JSON.stringify({
        score: 81,
        decision: 'FAIL',
        recommendations: [
          {
            title: 'Large function in transformer',
            severity: 'medium',
            file_path: 'src/transformer/builder.ts',
            line_number: 97,
            description: 'Function exceeds 50 lines',
          },
          {
            title: 'Missing error handling',
            severity: 'high',
            file_path: 'src/parser/main.ts',
            line_number: 42,
            description: 'No try/catch around async call',
          },
        ],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(81);
      expect(result.decision).toBe('FAIL');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues).toHaveLength(2);
      expect(issues[0]!.filePath).toBe('src/transformer/builder.ts');
      expect(issues[1]!.filePath).toBe('src/parser/main.ts');
      expect(issues[1]!.lineNumber).toBe(42);
    });

    it('should extract issues from inside dynamically discovered wrapper', () => {
      const content = JSON.stringify({
        codeValidation: {
          score: 88,
          decision: 'PASS',
          issues: [
            {
              title: 'Unused import',
              severity: 'low',
              file_path: 'src/utils.ts',
              line_number: 3,
              description: 'Import is never used',
            },
          ],
        },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(88);
      expect(result.decision).toBe('PASS');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.filePath).toBe('src/utils.ts');
    });

    it('should attach flat issues when categories already exist from scores (gpt-5-codex shape)', () => {
      const content = JSON.stringify({
        scores: { total: 98, code_quality: 28, standards_compliance: 25, testing: 25, best_practices: 20 },
        decision: { status: 'PASS', reason: 'Score 98/100' },
        issues: [
          {
            title: 'trackIfEnabled mixes responsibilities',
            severity: 'M',
            failure_code: 'PRA-FRA/M',
            file: 'src/client/UluOpsClient.ts',
            line_start: 336,
            description: 'Function exceeds 50-line guideline',
          },
        ],
      });
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(98);
      expect(result.decision).toBe('PASS');
      // Categories from scores + issues should be attached
      const allIssues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(allIssues).toHaveLength(1);
      expect(allIssues[0]!.filePath).toBe('src/client/UluOpsClient.ts');
      expect(allIssues[0]!.lineNumber).toBe(336);
      expect(allIssues[0]!.failureCode).toBe('PRA-FRA/M');
    });

    it('should use description as title when no title/message key exists', () => {
      const content = JSON.stringify({
        score: 92,
        decision: 'FAIL',
        issues: [
          {
            description: 'sanitizePathAsFolderName fails for Windows paths',
            file: 'src/utils.ts',
            line: '24-50',
            failure_code: 'SEM-COM/H',
            severity: 'H',
            explanation: 'Backslashes and drive letters are not normalized',
          },
        ],
      });
      const result = extractor.extract(content, 'validator');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.title).toBe('sanitizePathAsFolderName fails for Windows paths');
      expect(issues[0]!.description).toBe('Backslashes and drive letters are not normalized');
      expect(issues[0]!.filePath).toBe('src/utils.ts');
      expect(issues[0]!.lineNumber).toBe(24);
    });

    it('should extract issues from issues.details array (gpt-5.1 shape)', () => {
      const content = JSON.stringify({
        score: { total: 92 },
        decision: 'PASS',
        issues: {
          total_issues: 2,
          details: [
            {
              title: 'Large facade class',
              severity: 'M',
              failure_code: 'PRA-FRA/M',
              location: 'src/client.ts:151',
              description: 'OpsClient aggregating too many operations',
            },
            {
              title: 'No dependency audit',
              severity: 'M',
              failure_code: 'PRA-EFF/M',
              location: 'project-wide: package.json',
              description: 'No explicit audit strategy',
            },
          ],
        },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(92);
      const issues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(issues).toHaveLength(2);
      expect(issues[0]!.title).toBe('Large facade class');
      expect(issues[0]!.filePath).toBe('src/client.ts');
      expect(issues[0]!.lineNumber).toBe(151);
      // location without file:line pattern should not extract a path
      expect(issues[1]!.filePath).toBeUndefined();
    });

    it('should extract score from report.results.score (gpt-5.1 nested shape)', () => {
      const content = JSON.stringify({
        report: {
          files_reviewed: ['src/cli.ts'],
          results: {
            score: 96,
            by_category: { code_quality: 29, testing: 25 },
          },
        },
        decision: 'PASS',
      });
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(96);
      expect(result.decision).toBe('PASS');
    });

    it('should use "issue" field as title (gpt-5.1 shape)', () => {
      const content = JSON.stringify({
        score: { total: 95 },
        decision: 'PASS',
        issues: { items: [
          {
            issue: 'Single class file aggregating many bound operation groups',
            file: 'src/client.ts',
            line: 117,
            failure_code: 'PRA-FRA/M',
            severity: 'M',
            explanation: 'RegistryClient owns construction of 8+ sub-clients',
            suggestion: 'Extract session management to a dedicated service',
          },
        ]},
      });
      const result = extractor.extract(content, 'validator');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.title).toBe('Single class file aggregating many bound operation groups');
      expect(issues[0]!.description).toBe('RegistryClient owns construction of 8+ sub-clients');
    });

    it('should parse line number from string range like "24-50"', () => {
      const content = JSON.stringify({
        score: 85,
        decision: 'FAIL',
        issues: [
          { title: 'Long function', file: 'src/main.ts', line: '100-200', severity: 'medium' },
          { title: 'Missing check', file: 'src/auth.ts', line: '42', severity: 'high' },
        ],
      });
      const result = extractor.extract(content, 'validator');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues[0]!.lineNumber).toBe(100);
      expect(issues[1]!.lineNumber).toBe(42);
    });

    it('should extract issues from wrapper with recommendations key', () => {
      const content = JSON.stringify({
        validationReport: {
          score: 75,
          decision: 'FAIL',
          recommendations: [
            {
              title: 'Add type annotations',
              severity: 'medium',
              file_path: 'src/api.ts',
              line_number: 15,
              description: 'Missing return type',
            },
          ],
        },
      });
      const result = extractor.extract(content, 'validator');
      expect(result.score).toBe(75);
      expect(result.decision).toBe('FAIL');
      const issues = result.categories![0]!.findings[0]!.issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.title).toBe('Add type annotations');
    });

    it('should extract score.total and decision from inline JSON with prefix text', () => {
      // Simulates gpt-5.1 CLI run where model produces analysis text before JSON
      const json = JSON.stringify({
        score: { total: 93, code_quality: 28, standards_compliance: 23, testing: 23, best_practices: 19 },
        issues: {
          total_issues: 7,
          by_severity: { C: 0, H: 0, M: 5, L: 2 },
          items: [
            {
              id: 'CQ1', type: 'code_quality', severity: 'M', failure_code: 'PRA-FRA/M',
              title: 'Overly large multi-responsibility command functions',
              description: 'Several command registration functions contain very long action handlers.',
              file: 'src/commands/admin.ts', line: 10,
            },
          ],
        },
        auto_fail: { 'AF-001': 'clear' },
        decision: 'PASS',
        reasoning_trace: {
          code_quality: { score: 28, max_score: 30, deductions: [{ criterion: 'test', points_lost: 2 }] },
        },
        summary: {
          files_reviewed: ['package.json', 'src/cli.ts'],
          narrative: 'The CLI package is in a very strong state.',
        },
      }, null, 2);
      const content = `I've reviewed the codebase thoroughly. Here is my assessment:\n\n${json}`;
      const result = extractor.extractWithMetadata(content, 'validator');
      expect(result.method).toBe('inline_json');
      expect(result.output.decision).toBe('PASS');
      expect(result.output.score).toBe(93);
      expect(result.output.categories).toBeDefined();
      expect(result.output.categories!.length).toBeGreaterThan(0);
      const issues = result.output.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.title).toBe('Overly large multi-responsibility command functions');
    });

    it('should handle total_score and grouped issues array (gpt-4.1-nano shape)', () => {
      const content = JSON.stringify({
        criteria: { 'Code Quality': 20, 'Standards Compliance': 18, Testing: 15, 'Best Practices': 12 },
        total_score: 65,
        issues: [
          {
            severity: 'CRITICAL', count: 2,
            issues: [
              { description: 'Missing null check', file: 'src/index.ts', line: 96, failure_code: 'SEM-COM/H' },
              { description: 'Large function exceeds 80 lines', file: 'test/smoke.test.ts', line: 328, failure_code: 'PRA-FRA/M' },
            ],
          },
          {
            severity: 'WARNING', count: 1,
            issues: [
              { description: 'Missing JSDoc comments', file: 'src/index.ts', line: 96, failure_code: 'STR-OMI/L' },
            ],
          },
        ],
        decision: 'FAIL',
      });
      const result = extractor.extract(content, 'validator');
      expect(result.decision).toBe('FAIL');
      expect(result.score).toBe(65);
      const issues = result.categories!.flatMap(c => c.findings.flatMap(f => f.issues));
      expect(issues).toHaveLength(3);
      expect(issues[0]!.title).toBe('Missing null check');
      expect(issues[0]!.filePath).toBe('src/index.ts');
      expect(issues[0]!.lineNumber).toBe(96);
      expect(issues[2]!.title).toBe('Missing JSDoc comments');
    });
  });
});

function extractDecision(decision: string, agentType: 'validator' | 'executor'): string {
  const extractor = new OutputExtractor();
  const content = `\`\`\`json\n{"decision": "${decision}"}\n\`\`\``;
  return extractor.extract(content, agentType).decision;
}
