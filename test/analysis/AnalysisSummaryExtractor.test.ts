import { describe, it, expect } from 'vitest';
import { AnalysisSummaryExtractor } from '../../src/analysis/AnalysisSummaryExtractor.js';
import type { AgentResult } from '../../src/types/agent.js';
import type { ResolvedDefinition } from '../../src/types/registry.js';

// ─── Factories ──────────────────────────────────────────────────────────────

function makeAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    type: 'agent',
    agentType: 'validator',
    name: 'test-validator',
    version: '1.0.0',
    definitionHash: 'sha256:abc',
    decision: 'PASS',
    score: 85,
    maxScore: 100,
    recommendations: [],
    durationMs: 1200,
    metrics: {
      inputTokens: 500,
      outputTokens: 200,
      cacheCreationTokens: 100,
      cacheReadTokens: 50,
      totalEffectiveTokens: 750,
      durationMs: 1200,
      model: 'claude-sonnet-4-5-20250929',
      toolCallCount: 3,
    },
    ...overrides,
  };
}

function makeResolvedDefinition(overrides?: Partial<ResolvedDefinition>): ResolvedDefinition {
  return {
    type: 'agent',
    name: 'test-validator',
    version: '1.0.0',
    hash: 'sha256:abc',
    yaml: '',
    definition: {
      agent: {
        interface: {
          name: 'test-validator',
          version: '1.0.0',
          displayName: 'Test Validator',
          description: 'A test validator',
          agentType: 'validator',
          domain: 'software',
        },
        scoring: {
          maxScore: 100,
          categories: [
            { id: 'quality', name: 'Code Quality', weight: 40, criteria: [] },
            { id: 'security', name: 'Security', weight: 30, criteria: [] },
            { id: 'perf', name: 'Performance', weight: 30, criteria: [] },
          ],
        },
        decisions: {
          vocabulary: { positive: 'PASS', negative: 'FAIL', conditional: 'CONDITIONAL' },
        },
      },
    },
    runtime: {} as ResolvedDefinition['runtime'],
    ...overrides,
  } as ResolvedDefinition;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AnalysisSummaryExtractor', () => {
  const extractor = new AnalysisSummaryExtractor();

  describe('summary extraction', () => {
    it('extracts decision, score, and agentName', () => {
      const result = makeAgentResult();
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.agentName).toBe('test-validator');
      expect(summary.decision).toBe('PASS');
      expect(summary.score).toBe(85);
    });

    it('builds decision vocabulary from definition', () => {
      const result = makeAgentResult();
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.decisionVocabulary).toBe('PASS/CONDITIONAL/FAIL');
    });

    it('builds decision vocabulary from executor completion vocabulary', () => {
      const result = makeAgentResult({ agentType: 'executor', decision: 'COMPLETE' });
      const resolved = makeResolvedDefinition({
        definition: {
          agent: {
            interface: {
              name: 'test-executor',
              version: '1.0.0',
              displayName: 'Test',
              description: 'Test',
              agentType: 'executor',
              domain: 'software',
            },
            completion: {
              vocabulary: { complete: 'COMPLETE', partial: 'PARTIAL', failed: 'FAILED' },
              criteria: [],
            },
          },
        },
      });
      const { summary } = extractor.extract(result, resolved);

      expect(summary.decisionVocabulary).toBe('COMPLETE/PARTIAL/FAILED');
    });

    it('returns null vocabulary when definition has no vocabulary', () => {
      const result = makeAgentResult();
      const resolved = makeResolvedDefinition({
        definition: {
          agent: {
            interface: {
              name: 'test',
              version: '1.0.0',
              displayName: 'Test',
              description: 'Test',
              agentType: 'analyst',
              domain: 'software',
            },
          },
        },
      });
      const { summary } = extractor.extract(result, resolved);

      expect(summary.decisionVocabulary).toBeNull();
    });
  });

  describe('category scores', () => {
    it('maps categories with weights from definition', () => {
      const result = makeAgentResult({
        categories: [
          { name: 'Code Quality', score: 35, maxScore: 40, findings: [] },
          { name: 'Security', score: 25, maxScore: 30, findings: [] },
          { name: 'Performance', score: 25, maxScore: 30, findings: [] },
        ],
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.categoryScores).toEqual([
        { name: 'Code Quality', weight: 40, score: 35 },
        { name: 'Security', weight: 30, score: 25 },
        { name: 'Performance', weight: 30, score: 25 },
      ]);
    });

    it('uses equal weights when definition has no scoring', () => {
      const result = makeAgentResult({
        categories: [
          { name: 'Analysis', score: 80, maxScore: 100, findings: [] },
          { name: 'Depth', score: 60, maxScore: 100, findings: [] },
        ],
      });
      const resolved = makeResolvedDefinition({
        definition: {
          agent: {
            interface: {
              name: 'test',
              version: '1.0.0',
              displayName: 'Test',
              description: 'Test',
              agentType: 'analyst',
              domain: 'software',
            },
          },
        },
      });
      const { summary } = extractor.extract(result, resolved);

      expect(summary.categoryScores).toEqual([
        { name: 'Analysis', weight: 50, score: 80 },
        { name: 'Depth', weight: 50, score: 60 },
      ]);
    });

    it('returns null when no categories', () => {
      const result = makeAgentResult({ categories: undefined });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.categoryScores).toBeNull();
    });
  });

  describe('system metrics', () => {
    it('populates from execution metrics', () => {
      const result = makeAgentResult({
        extractionConfidence: 1.0,
        extractionMethod: 'structured_output',
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.systemMetrics).toEqual({
        inputTokens: 500,
        outputTokens: 200,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
        thinkingTokens: undefined,
        totalEffectiveTokens: 750,
        durationMs: 1200,
        model: 'claude-sonnet-4-5-20250929',
        toolCallCount: 3,
        costUsd: undefined,
        extractionConfidence: 1.0,
        extractionMethod: 'structured_output',
      });
    });
  });

  describe('rawJson extraction', () => {
    it('extracts epistemicAssessment from rawJson (camelCase)', () => {
      const assessment = { confidence: 'high', groundingRatio: 0.85 };
      const result = makeAgentResult({
        rawJson: { decision: 'EXAMINED', score: 72, epistemicAssessment: assessment },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.epistemicAssessment).toEqual(assessment);
    });

    it('extracts epistemic_assessment from rawJson (snake_case)', () => {
      const assessment = { confidence: 'medium' };
      const result = makeAgentResult({
        rawJson: { decision: 'EXAMINED', score: 72, epistemic_assessment: assessment },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.epistemicAssessment).toEqual(assessment);
    });

    it('extracts auditImplications from rawJson', () => {
      const implications = ['Temporal decay risk in auth module', 'Naming drift accelerating'];
      const result = makeAgentResult({
        rawJson: { decision: 'FRAGILE', score: 45, auditImplications: implications },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.auditImplications).toEqual(implications);
    });

    it('extracts explorationMaps from rawJson', () => {
      const maps = [{
        metadata: { explorerName: 'bateson-explorer', framework: 'logical-levels' },
        sections: [
          { type: 'topology', label: 'Level Map', entities: [{ name: 'code' }], relationships: [] },
        ],
      }];
      const result = makeAgentResult({
        rawJson: { decision: 'EXPLORED', score: 0, explorationMaps: maps },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.explorationMaps).toEqual(maps);
    });

    it('rejects malformed exploration maps', () => {
      const result = makeAgentResult({
        rawJson: { decision: 'EXPLORED', score: 0, explorationMaps: [{ bad: 'data' }] },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.explorationMaps).toBeNull();
    });

    it('returns null for all optional fields when no rawJson', () => {
      const result = makeAgentResult({ rawJson: undefined });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.epistemicAssessment).toBeNull();
      expect(summary.auditImplications).toBeNull();
      expect(summary.explorationMaps).toBeNull();
    });
  });

  describe('analysis records', () => {
    it('generates records from recommendations', () => {
      const result = makeAgentResult({
        recommendations: [
          {
            agent: 'test-validator',
            title: 'Missing null check',
            priority: 'critical',
            severity: 'high',
            failureCode: 'STR-NUL/H',
            failureDomain: 'STR',
            failureMode: 'NUL',
            filePath: 'src/auth.ts',
            lineNumber: 42,
            category: 'safety',
          },
          {
            agent: 'test-validator',
            title: 'Unused import',
            priority: 'backlog',
            severity: 'low',
          },
        ],
      });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        agentName: 'test-validator',
        recordType: 'evidence_finding',
        recordId: 'STR-NUL/H',
        title: 'Missing null check',
        classification: 'STR-NUL/H',
        severity: 'high',
        data: {
          priority: 'critical',
          description: undefined,
          filePath: 'src/auth.ts',
          lineNumber: 42,
          category: 'safety',
          failureMode: 'NUL',
          classificationConfidence: undefined,
          classifiedBy: undefined,
          secondaryFailureCodes: undefined,
          taxonomyVersion: undefined,
        },
      });

      expect(records[1].recordType).toBe('evidence_finding');
      expect(records[1].recordId).toMatch(/^r-[0-9a-f]{16}$/);
    });

    it('returns empty array when no recommendations', () => {
      const result = makeAgentResult({ recommendations: [] });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toEqual([]);
    });

    it('derives records from exploration maps when no explicit records or recommendations', () => {
      const result = makeAgentResult({
        recommendations: [],
        rawJson: {
          explorationMaps: [{
            metadata: { explorerName: 'democritus-explorer', framework: 'reductive-decomposition' },
            sections: [
              {
                type: 'inventory',
                label: 'Atomic inventory',
                entries: [
                  { key: 'A1: UluOpsClient', value: 'Primary facade' },
                  { key: 'A2: RegistryClient', value: 'Definition resolution' },
                ],
              },
              {
                type: 'agenda',
                label: 'Inquiry questions',
                entries: [
                  { key: 'Q1', value: 'Is the output schema truly universal?' },
                ],
              },
            ],
          }],
        },
      });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toHaveLength(3);
      expect(records[0].recordType).toBe('evidence_finding');
      expect(records[0].title).toBe('A1: UluOpsClient');
      expect(records[0].data).toMatchObject({ sectionType: 'inventory', content: 'Primary facade' });
      expect(records[2].recordType).toBe('inquiry_question');
      expect(records[2].title).toBe('Q1');
    });

    it('uses Tier 2 structured records from rawJson.analysisRecords', () => {
      const result = makeAgentResult({
        recommendations: [],
        rawJson: {
          analysisRecords: [
            {
              recordType: 'commitment',
              recordId: 'R-1',
              title: 'Test commitment',
              classification: 'PROMISING',
              severity: null,
              data: [{ key: 'status', value: 'confirmed' }],
            },
          ],
        },
      });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toHaveLength(1);
      expect(records[0].recordType).toBe('commitment');
      expect(records[0].recordId).toBe('R-1');
      expect(records[0].title).toBe('Test commitment');
      expect(records[0].data).toEqual({ status: 'confirmed' });
    });

    it('populates domainMetrics from rawJson when no analysis block', () => {
      const result = makeAgentResult({
        rawJson: {
          domainMetrics: [
            { key: 'atomsFound', value: '42' },
            { key: 'decompositionFit', value: 'HIGH' },
          ],
        },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      // Numeric strings converted to numbers; enum strings preserved
      expect(summary.systemMetrics).toMatchObject({
        atomsFound: 42,
        decompositionFit: 'HIGH',
        // Execution metrics still present
        inputTokens: 500,
      });
    });
  });

  describe('analysis block from rawOutput JSON fence', () => {
    const jsonFence = (analysis: Record<string, unknown>) =>
      `# Report\n\nSome markdown...\n\n\`\`\`json\n${JSON.stringify({
        agent: { name: 'test-validator' },
        result: { score: 82, decision: 'FACTUAL' },
        categories: [],
        analysis,
      })}\n\`\`\`\n\nMore text.`;

    it('uses domain system_metrics from analysis block, merged with execution metrics', () => {
      const result = makeAgentResult({
        rawOutput: jsonFence({
          system_metrics: {
            alignmentLevel: 'substantially aligned',
            statedClassificationsCount: 6,
            alignedClassificationsCount: 4,
          },
        }),
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      // Domain metrics override execution metrics
      expect(summary.systemMetrics).toMatchObject({
        alignmentLevel: 'substantially aligned',
        statedClassificationsCount: 6,
        // Execution metrics still present
        inputTokens: 500,
        model: 'claude-sonnet-4-5-20250929',
      });
    });

    it('uses agent-produced records over auto-generated', () => {
      const result = makeAgentResult({
        rawOutput: jsonFence({
          records: [
            { recordType: 'commitment', recordId: 'R-1', title: 'Issue.timesSeen reified', data: { status: 'PROMISING' } },
            { recordType: 'inquiry_question', recordId: 'IQ-1', title: 'Can timesSeen be derived?', data: { priority: 'high' } },
          ],
        }),
        recommendations: [
          { agent: 'test-validator', title: 'Ignored recommendation', priority: 'suggested' },
        ],
      });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toHaveLength(2);
      expect(records[0].recordType).toBe('commitment');
      expect(records[0].recordId).toBe('R-1');
      expect(records[0].agentName).toBe('test-validator');
      expect(records[1].recordType).toBe('inquiry_question');
      expect(records[1].recordId).toBe('IQ-1');
    });

    it('uses agent epistemic_assessment over structured output', () => {
      const result = makeAgentResult({
        rawOutput: jsonFence({
          epistemic_assessment: {
            fsRiskOverall: 'LOW',
            fs1InterpretationPurism: 'LOW',
            fs2SurfaceParsing: 'LOW',
          },
        }),
        rawJson: {
          epistemicAssessment: { confidence: 'high', groundingRatio: 0.9, keyUncertainties: null, methodology: null },
        },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      // Analysis block wins over structured output
      expect(summary.epistemicAssessment).toEqual({
        fsRiskOverall: 'LOW',
        fs1InterpretationPurism: 'LOW',
        fs2SurfaceParsing: 'LOW',
      });
    });

    it('uses category_scores from analysis block when present', () => {
      const result = makeAgentResult({
        rawOutput: jsonFence({
          category_scores: [
            { name: 'Impression Inventory', weight: 20, score: 17 },
            { name: 'Fact/Judgment Separation', weight: 30, score: 25 },
          ],
        }),
        categories: [
          { name: 'Code Quality', score: 35, maxScore: 40, findings: [] },
        ],
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      // Analysis block scores used instead of auto-computed
      expect(summary.categoryScores).toEqual([
        { name: 'Impression Inventory', weight: 20, score: 17 },
        { name: 'Fact/Judgment Separation', weight: 30, score: 25 },
      ]);
    });

    it('falls back to structured output when no analysis block', () => {
      const result = makeAgentResult({
        rawOutput: '# Just markdown, no JSON fence',
        rawJson: {
          epistemicAssessment: { confidence: 'medium', groundingRatio: 0.7, keyUncertainties: null, methodology: null },
        },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.epistemicAssessment).toEqual({
        confidence: 'medium', groundingRatio: 0.7, keyUncertainties: null, methodology: null,
      });
    });

    it('parses the ```json analysis discriminator fence (report-mode marker)', () => {
      // Report-mode invocations instruct the agent to emit ```json analysis instead
      // of plain ```json so an earlier illustrative fence in the prose cannot claim
      // the canonical match. The extractor must accept this marker as equivalent.
      const reportModeFence = `# Wittgensteinian Report\n\nProse analysis here...\n\n\`\`\`json analysis\n${JSON.stringify({
        agent: { name: 'test-validator' },
        result: { score: 88, decision: 'CLEAR' },
        categories: [],
        analysis: {
          records: [
            { recordType: 'commitment', recordId: 'R-1', title: 'Discriminator parsed', data: { status: 'OK' } },
          ],
        },
      })}\n\`\`\`\n`;
      const result = makeAgentResult({ rawOutput: reportModeFence });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toHaveLength(1);
      expect(records[0].recordId).toBe('R-1');
      expect(records[0].agentName).toBe('test-validator');
    });

    it('prefers the ```json analysis discriminator over an earlier ```json example in prose', () => {
      // The case the discriminator exists to prevent: an analyst includes a ```json
      // example block in their prose, then ends with the canonical ```json analysis
      // block. Without the discriminator the first-match regex would consume the
      // example. With it, the canonical block wins.
      const canonicalRecords = [
        { recordType: 'commitment', recordId: 'CANONICAL', title: 'Canonical block', data: {} },
      ];
      const exampleBlock = '```json\n{"example": "this is an illustrative payload"}\n```';
      const canonicalFence = `\`\`\`json analysis\n${JSON.stringify({
        agent: { name: 'test-validator' },
        result: { score: 90, decision: 'CLEAR' },
        categories: [],
        analysis: { records: canonicalRecords },
      })}\n\`\`\``;
      const rawOutput = `# Report\n\nHere is an example payload:\n\n${exampleBlock}\n\nAnd the canonical block:\n\n${canonicalFence}\n`;

      const result = makeAgentResult({ rawOutput });
      const resolved = makeResolvedDefinition();
      const { records } = extractor.extract(result, resolved);

      expect(records).toHaveLength(1);
      expect(records[0].recordId).toBe('CANONICAL');
    });
  });
});
