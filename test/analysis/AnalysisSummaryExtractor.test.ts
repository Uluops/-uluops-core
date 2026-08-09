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
    it('is null when the agent produced no cognitive metrics — execution telemetry is NOT merged in', () => {
      // system-metrics-contract spec v0.1.2 D4 (issue 762f58be): tokens/model/
      // duration travel first-class on agents[] via SubmissionClient; the
      // extraction facts move to epistemicAssessment. systemMetrics carries
      // cognitive measurements only.
      const result = makeAgentResult({
        extractionConfidence: 1.0,
        extractionMethod: 'structured_output',
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      expect(summary.systemMetrics).toBeNull();
      expect(summary.epistemicAssessment).toEqual({
        extraction_confidence: 1.0,
        extraction_method: 'structured_output',
      });
    });

    it('never clobbers agent-authored extraction keys in the epistemic assessment', () => {
      const result = makeAgentResult({
        extractionConfidence: 0.95,
        extractionMethod: 'json_code_fence',
        rawJson: {
          decision: 'EXAMINED',
          score: 72,
          epistemicAssessment: { extraction_confidence: 0.4, ownSignal: 'low' },
        },
      });
      const resolved = makeResolvedDefinition();
      const { summary } = extractor.extract(result, resolved);

      // Agent's own key WINS; core fills only what's absent
      expect(summary.epistemicAssessment).toEqual({
        extraction_confidence: 0.4,
        ownSignal: 'low',
        extraction_method: 'json_code_fence',
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

    it('preserves a semantic recordId between 21 and 100 chars (no longer hashed)', () => {
      const semanticId = 'foundations-api-aristotle-20260626'; // 34 chars, > old 20-char cap
      expect(semanticId.length).toBeGreaterThan(20);
      const result = makeAgentResult({
        recommendations: [],
        rawJson: {
          analysisRecords: [
            { recordType: 'commitment', recordId: semanticId, title: 'Long id', data: [] },
          ],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].recordId).toBe(semanticId);
    });

    it('bounds an over-100-char recordId to a deterministic hash', () => {
      const longId = 'x'.repeat(101);
      const result = makeAgentResult({
        recommendations: [],
        rawJson: {
          analysisRecords: [
            { recordType: 'commitment', recordId: longId, title: 'Too long', data: [] },
          ],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].recordId).toMatch(/^r-[0-9a-f]{16}$/);
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

      // Numeric strings converted to numbers; enum strings preserved.
      // Execution telemetry is NOT merged in (spec v0.1.2 D4) — domain
      // metrics only, exactly as submitted.
      expect(summary.systemMetrics).toEqual({
        atomsFound: 42,
        decompositionFit: 'HIGH',
      });
    });
  });

  // Locks the first-non-empty-tier-wins ordering of buildAnalysisRecords so a tier
  // reorder/removal is a loud failure rather than silent data loss for an agent class.
  describe('record severity sanitization', () => {
    const fenceWith = (analysis: Record<string, unknown>) =>
      `# Report\n\n\`\`\`json\n${JSON.stringify({ agent: {}, result: {}, analysis })}\n\`\`\`\n`;

    it('coerces off-vocabulary severity to null and preserves the raw value (Tier 1 analysis block)', () => {
      const result = makeAgentResult({
        rawOutput: fenceWith({
          records: [
            { recordType: 'commitment', recordId: 'R1', title: 'register-style', severity: 'structural', data: { note: 'kept' } },
            { recordType: 'commitment', recordId: 'R2', title: 'valid', severity: 'high', data: {} },
          ],
        }),
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].severity).toBeNull();
      expect(records[0].data).toEqual({ note: 'kept', rawSeverity: 'structural' });
      expect(records[1].severity).toBe('high');
      expect(records[1].data).not.toHaveProperty('rawSeverity');
    });

    it('case-normalizes enum severities instead of nulling them', () => {
      const result = makeAgentResult({
        rawOutput: fenceWith({
          records: [{ recordType: 'commitment', recordId: 'R1', title: 'cased', severity: 'HIGH', data: {} }],
        }),
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].severity).toBe('high');
      expect(records[0].data).not.toHaveProperty('rawSeverity');
    });

    it('sanitizes Tier 2 structured records and Tier 4 recommendation records', () => {
      const structured = makeAgentResult({
        rawJson: {
          analysisRecords: [{ recordType: 'commitment', recordId: 'T2', title: 'tier-2', severity: 'epistemic', data: [] }],
        },
      });
      const { records: t2 } = extractor.extract(structured, makeResolvedDefinition());
      expect(t2[0].severity).toBeNull();
      expect(t2[0].data).toMatchObject({ rawSeverity: 'epistemic' });

      const recs = makeAgentResult({
        recommendations: [{ agent: 'test-validator', title: 'tier-4', priority: 'suggested', severity: 'tactical' }],
      });
      const { records: t4 } = extractor.extract(recs, makeResolvedDefinition());
      expect(t4[0].severity).toBeNull();
      expect(t4[0].data).toMatchObject({ rawSeverity: 'tactical' });
    });

    it('leaves null/absent severity untouched', () => {
      const result = makeAgentResult({
        rawOutput: fenceWith({
          records: [{ recordType: 'commitment', recordId: 'R1', title: 'no severity', data: {} }],
        }),
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].severity ?? null).toBeNull();
      expect(records[0].data).not.toHaveProperty('rawSeverity');
    });
  });

  // Record TYPE is deliberately not a closed vocabulary. ops-api widened it from an enum to a
  // bounded string so registry-defined agents can emit new shapes without an API release
  // (ops-uluops-api/CHANGELOG.md:1743). This module used to re-narrow it client-side against a
  // 47-value set, and only on Tier 2 — so the same record survived or was flattened to
  // evidence_finding depending on which channel the agent used, with the original preserved
  // nowhere. These tests pin the vocabulary-open behaviour and the tier symmetry.
  describe('record type sanitization', () => {
    const fenceWith = (analysis: Record<string, unknown>) =>
      `# Report\n\n\`\`\`json\n${JSON.stringify({ agent: {}, result: {}, analysis })}\n\`\`\`\n`;

    it('preserves an off-catalog record type on Tier 2 instead of flattening it', () => {
      // breakdown_event and reification are real, heavily-emitted types that were absent from
      // the old 47-value set. Before this change both became evidence_finding here.
      const result = makeAgentResult({
        rawJson: {
          analysisRecords: [
            { recordType: 'breakdown_event', recordId: 'B1', title: 'obtrusive', data: [] },
            { recordType: 'reification', recordId: 'R1', title: 'svabhava', data: [] },
          ],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records.map(r => r.recordType)).toEqual(['breakdown_event', 'reification']);
      expect(records[0].data).not.toHaveProperty('rawRecordType');
    });

    it('applies the same policy on Tier 1 and Tier 2 — the asymmetry is the bug', () => {
      const viaFence = makeAgentResult({
        rawOutput: fenceWith({
          records: [{ recordType: 'threshold_verdict', recordId: 'T1', title: 'fence', data: {} }],
        }),
      });
      const viaStructured = makeAgentResult({
        rawJson: {
          analysisRecords: [{ recordType: 'threshold_verdict', recordId: 'T2', title: 'structured', data: [] }],
        },
      });
      const t1 = extractor.extract(viaFence, makeResolvedDefinition()).records[0];
      const t2 = extractor.extract(viaStructured, makeResolvedDefinition()).records[0];
      expect(t1.recordType).toBe('threshold_verdict');
      expect(t2.recordType).toBe(t1.recordType);
    });

    it('normalizes case and surrounding whitespace so variants do not fragment', () => {
      const result = makeAgentResult({
        rawJson: {
          analysisRecords: [
            { recordType: '  Fear  ', recordId: 'F1', title: 'cased', data: [] },
            { recordType: 'fear', recordId: 'F2', title: 'plain', data: [] },
          ],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records.map(r => r.recordType)).toEqual(['fear', 'fear']);
      expect(records[0].data).not.toHaveProperty('rawRecordType');
    });

    it('falls back on an over-length type and preserves the original, on BOTH tiers', () => {
      // 50 is the storage bound (VARCHAR(50), and min(1).max(50) in the API + MCP schemas).
      // Tier 1 previously applied no bound at all, so this value reached the API and its
      // rejection killed the entire save — not just the offending record.
      const tooLong = 'x'.repeat(51);
      const viaFence = makeAgentResult({
        rawOutput: fenceWith({ records: [{ recordType: tooLong, recordId: 'L1', title: 'fence', data: {} }] }),
      });
      const viaStructured = makeAgentResult({
        rawJson: { analysisRecords: [{ recordType: tooLong, recordId: 'L2', title: 'structured', data: [] }] },
      });
      for (const result of [viaFence, viaStructured]) {
        const rec = extractor.extract(result, makeResolvedDefinition()).records[0];
        expect(rec.recordType).toBe('evidence_finding');
        expect(rec.data).toMatchObject({ rawRecordType: tooLong });
      }
    });

    it('accepts a type exactly at the 50-char bound', () => {
      const atBound = 'y'.repeat(50);
      const result = makeAgentResult({
        rawJson: { analysisRecords: [{ recordType: atBound, recordId: 'A1', title: 'boundary', data: [] }] },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].recordType).toBe(atBound);
      expect(records[0].data).not.toHaveProperty('rawRecordType');
    });

    it('falls back without rawRecordType noise when there was nothing to preserve', () => {
      const result = makeAgentResult({
        rawJson: {
          analysisRecords: [
            { recordType: '', recordId: 'E1', title: 'empty', data: [] },
            { recordType: null, recordId: 'N1', title: 'null', data: [] },
          ],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records.map(r => r.recordType)).toEqual(['evidence_finding', 'evidence_finding']);
      // Regression guard: String(null) is the 4-char string "null", which the bound accepts.
      expect(records.map(r => r.recordType)).not.toContain('null');
      for (const rec of records) expect(rec.data).not.toHaveProperty('rawRecordType');
    });

    it('does not fabricate a type from a non-string value', () => {
      // Tier 1 spreads the agent's record verbatim off JSON.parse, so recordType can be any
      // JSON type. A bare String() would turn {} into "[object object]" — 15 chars, inside
      // the bound — and store it as though declared. The old code sent the non-string to the
      // API and died loudly; a fabricated type is worse, because it is silent AND it lands
      // in the corpus this normalization exists to make measurable.
      const fenceWithType = (recordType: unknown) =>
        `# R\n\n\`\`\`json\n${JSON.stringify({
          agent: {}, result: {},
          analysis: { records: [{ recordType, recordId: 'X1', title: 't', data: {} }] },
        })}\n\`\`\`\n`;

      const cases: Array<[unknown, string]> = [
        [{}, '{}'],
        [{ name: 'fear' }, '{"name":"fear"}'],
        [['a', 'b'], '["a","b"]'],
        [123, '123'],
        [true, 'true'],
      ];

      for (const [value, expectedRaw] of cases) {
        const { records } = extractor.extract(
          makeAgentResult({ rawOutput: fenceWithType(value) }),
          makeResolvedDefinition(),
        );
        expect(records[0].recordType).toBe('evidence_finding');
        expect(records[0].recordType).not.toContain('object');
        expect(records[0].data).toMatchObject({ rawRecordType: expectedRaw });
      }
    });

    it('lands both rawSeverity and rawRecordType when a record fails both checks', () => {
      // The two sanitizers run in sequence over the same `data` object
      // (.map(sanitizeRecordSeverity).map(sanitizeRecordType)). Severity runs first, so
      // the type sanitizer spreads a `data` that already carries rawSeverity. Neither
      // may drop the other's preserved value, and the agent's own keys must survive both.
      const result = makeAgentResult({
        rawJson: {
          analysisRecords: [{
            recordType: 'z'.repeat(51),
            recordId: 'D1',
            title: 'both invalid',
            severity: 'structural',
            data: [{ key: 'note', value: 'agent payload' }],
          }],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].recordType).toBe('evidence_finding');
      expect(records[0].severity).toBeNull();
      expect(records[0].data).toEqual({
        note: 'agent payload',
        rawSeverity: 'structural',
        rawRecordType: 'z'.repeat(51),
      });
    });

    it('sanitizer wins when the agent already used the key rawRecordType', () => {
      // Documented, accepted collision: the preserved value is written after the agent's
      // data is spread, so on a key clash the sanitizer's value survives. Same shape as
      // the pre-existing rawSeverity behaviour. Pinned so a change here is deliberate.
      const result = makeAgentResult({
        rawJson: {
          analysisRecords: [{
            recordType: 'q'.repeat(51),
            recordId: 'C1',
            title: 'clobber',
            data: [{ key: 'rawRecordType', value: 'agent-supplied' }],
          }],
        },
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].data).toMatchObject({ rawRecordType: 'q'.repeat(51) });
    });

    it('does not fabricate a type or title from a non-string on Tier 2 either', () => {
      // The Tier 1 fix alone was not enough. extractStructuredRecords used to do
      // String(r.recordType) and String(r.title), which erased the JSON type before the
      // sanitizers could see it — so Tier 2 kept fabricating "[object object]" while Tier 1
      // was clean. Fixing the cited instance and not its sibling path is the exact pattern
      // this file's other comments keep warning about.
      const { records } = extractor.extract(
        makeAgentResult({
          rawJson: {
            analysisRecords: [
              { recordType: {}, recordId: 'X1', title: { t: 1 }, data: [] },
              { recordType: ['a', 'b'], recordId: 'X2', title: 42, data: [] },
            ],
          },
        }),
        makeResolvedDefinition(),
      );
      for (const rec of records) {
        expect(rec.recordType).toBe('evidence_finding');
        expect(rec.recordType).not.toContain('object');
        expect(rec.title).not.toContain('object');
        expect(rec.title).toBe('(untitled record)');
      }
    });

    it('still yields evidence_finding for Tier 4 recommendation records', () => {
      // Tier 4 previously tested VALID_RECORD_TYPES.has(failureDomain), which could never be
      // true — failureDomain is STR|SEM|PRA|EPI and no domain was in that set. Behaviour is
      // unchanged; the dead branch is gone.
      const result = makeAgentResult({
        recommendations: [
          { agent: 'test-validator', title: 'tier-4', priority: 'suggested', failureDomain: 'STR' },
        ],
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records[0].recordType).toBe('evidence_finding');
    });
  });

  // title and classification were the last two agent-authored fields with no bound. The SDK
  // validates the WHOLE analysisRecords array client-side before the network, so one
  // over-length value threw a ZodError and lost the entire run's analysis rather than one
  // record — the same failure that produced sanitizeRecordSeverity and sanitizeRecordType.
  describe('record title and classification sanitization', () => {
    const t2 = (overrides: Record<string, unknown>) =>
      extractor.extract(
        makeAgentResult({
          rawJson: {
            analysisRecords: [{ recordType: 'fear', recordId: 'R1', title: 't', data: [], ...overrides }],
          },
        }),
        makeResolvedDefinition(),
      ).records[0];

    it('accepts a title exactly at the 500-char bound untouched', () => {
      const atBound = 'y'.repeat(500);
      const rec = t2({ title: atBound });
      expect(rec.title).toBe(atBound);
      expect(rec.data).not.toHaveProperty('rawTitle');
    });

    it('truncates an over-length title and keeps the full text', () => {
      // Prose, so truncate rather than replace — a clipped title still identifies the
      // finding. The result must be exactly at the bound, not one over.
      const tooLong = 'z'.repeat(501);
      const rec = t2({ title: tooLong });
      expect(rec.title).toHaveLength(500);
      expect(rec.title.endsWith('…')).toBe(true);
      expect(rec.data).toMatchObject({ rawTitle: tooLong });
    });

    it('falls back on a blank or whitespace-only title', () => {
      for (const blank of ['', '   ']) {
        const rec = t2({ title: blank });
        expect(rec.title).toBe('(untitled record)');
        expect(rec.data).not.toHaveProperty('rawTitle');
      }
    });

    it('nulls an over-length classification rather than truncating it', () => {
      // Categorical, not prose: a truncated category is a DIFFERENT category, so inventing
      // one is worse than declaring none.
      const tooLong = 'd'.repeat(51);
      const rec = t2({ classification: tooLong });
      expect(rec.classification).toBeNull();
      expect(rec.data).toMatchObject({ rawClassification: tooLong });
    });

    it('accepts a classification exactly at the 50-char bound', () => {
      const atBound = 'c'.repeat(50);
      const rec = t2({ classification: atBound });
      expect(rec.classification).toBe(atBound);
      expect(rec.data).not.toHaveProperty('rawClassification');
    });

    it('leaves an absent classification null without adding noise', () => {
      const rec = t2({ classification: null });
      expect(rec.classification ?? null).toBeNull();
      expect(rec.data).not.toHaveProperty('rawClassification');
    });

    it('keeps every field inside the SDK contract when all three are over-length at once', () => {
      // The whole point: the SDK validates the entire array, so one bad field loses the run.
      const rec = t2({
        recordType: 'q'.repeat(90),
        title: 'z'.repeat(900),
        classification: 'd'.repeat(120),
      });
      expect(rec.recordType.length).toBeLessThanOrEqual(50);
      expect(rec.title.length).toBeLessThanOrEqual(500);
      expect(rec.classification === null || rec.classification.length <= 50).toBe(true);
      expect(rec.data).toMatchObject({
        rawRecordType: 'q'.repeat(90),
        rawTitle: 'z'.repeat(900),
        rawClassification: 'd'.repeat(120),
      });
    });

    it('applies the same title bound on Tier 1 and Tier 4', () => {
      const tooLong = 'w'.repeat(600);
      const viaFence = extractor.extract(
        makeAgentResult({
          rawOutput: `# R\n\n\`\`\`json\n${JSON.stringify({
            agent: {}, result: {},
            analysis: { records: [{ recordType: 'fear', recordId: 'T1', title: tooLong, data: {} }] },
          })}\n\`\`\`\n`,
        }),
        makeResolvedDefinition(),
      ).records[0];
      const viaRecs = extractor.extract(
        makeAgentResult({
          recommendations: [{ agent: 'test-validator', title: tooLong, priority: 'suggested' }],
        }),
        makeResolvedDefinition(),
      ).records[0];
      for (const rec of [viaFence, viaRecs]) {
        expect(rec.title).toHaveLength(500);
        expect(rec.data).toMatchObject({ rawTitle: tooLong });
      }
    });
  });

  // data was the last field in the per-record contract with no guard, and it fails harder
  // than the others: measured against the SDK's own z.record(z.string(), z.unknown()), a
  // plain object is accepted and EVERY other shape is rejected — arrays including [], null,
  // undefined and primitives alike. Since the SDK validates the whole array before the
  // network, any of those loses the entire run's analysis.
  describe('record data sanitization', () => {
    const fenceWith = (analysis: Record<string, unknown>) =>
      `# R\n\n\`\`\`json\n${JSON.stringify({ agent: {}, result: {}, analysis })}\n\`\`\`\n`;

    const bothTiers = (data: unknown) => {
      const rec = { recordType: 'fear', recordId: 'R1', title: 't', data };
      return [
        extractor.extract(makeAgentResult({ rawOutput: fenceWith({ records: [rec] }) }), makeResolvedDefinition()).records[0],
        extractor.extract(makeAgentResult({ rawJson: { analysisRecords: [rec] } }), makeResolvedDefinition()).records[0],
      ];
    };

    const isPlainObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);

    it('yields a plain object for every input shape, on Tier 1 and Tier 2 alike', () => {
      for (const shape of [{ a: 1 }, [{ key: 'k', value: 'v' }], ['a', 'b'], [], null, 'hello', 42]) {
        for (const rec of bothTiers(shape)) {
          expect(isPlainObject(rec.data), `shape ${JSON.stringify(shape)}`).toBe(true);
        }
      }
    });

    it('converts entries-based data on BOTH tiers, not just Tier 2', () => {
      // The conversion used to live inline in extractStructuredRecords, so a fenced record
      // carrying the entries shape reached the SDK as an array and killed the whole save.
      for (const rec of bothTiers([{ key: 'status', value: 'confirmed' }, { key: 'n', value: 2 }])) {
        expect(rec.data).toEqual({ status: 'confirmed', n: 2 });
      }
    });

    it('preserves a non-entries array under rawData instead of mangling it', () => {
      // The old inline conversion mapped absent .key fields and produced {undefined: undefined}.
      for (const rec of bothTiers(['a', 'b'])) {
        expect(rec.data).toEqual({ rawData: ['a', 'b'] });
        expect(rec.data).not.toHaveProperty('undefined');
        expect(rec.data).not.toHaveProperty('0');
      }
    });

    it('maps empty array and null to an empty object, not to rawData noise', () => {
      for (const shape of [[], null]) {
        for (const rec of bothTiers(shape)) {
          expect(rec.data).toEqual({});
        }
      }
    });

    it('normalizes data BEFORE the other sanitizers spread it', () => {
      // Ordering is load-bearing: every other sanitizer preserves its rejected value by
      // spreading record.data, and spreading an array yields {0:…, 1:…}. This record fails
      // severity, type AND title while carrying array data — if data were normalized last,
      // the preserved keys would land on an index-keyed object.
      const [t1, t2] = [
        extractor.extract(makeAgentResult({
          rawOutput: fenceWith({ records: [{ recordType: 'q'.repeat(60), recordId: 'R1', title: '', severity: 'structural', data: ['x'] }] }),
        }), makeResolvedDefinition()).records[0],
        extractor.extract(makeAgentResult({
          rawJson: { analysisRecords: [{ recordType: 'q'.repeat(60), recordId: 'R2', title: '', severity: 'structural', data: ['x'] }] },
        }), makeResolvedDefinition()).records[0],
      ];
      for (const rec of [t1, t2]) {
        expect(isPlainObject(rec.data)).toBe(true);
        expect(rec.data).not.toHaveProperty('0');
        expect(rec.data).toMatchObject({
          rawData: ['x'],
          rawSeverity: 'structural',
          rawRecordType: 'q'.repeat(60),
        });
        expect(rec.title).toBe('(untitled record)');
      }
    });
  });

  describe('record tier precedence', () => {
    const fenceWith = (analysis: Record<string, unknown>) =>
      `# Report\n\n\`\`\`json\n${JSON.stringify({ agent: {}, result: {}, analysis })}\n\`\`\`\n`;

    it('Tier 1 (analysis block) wins over Tier 2 (structured) / Tier 4 (recommendations)', () => {
      const result = makeAgentResult({
        rawOutput: fenceWith({ records: [{ recordType: 'commitment', recordId: 'T1', title: 'tier-1', data: {} }] }),
        rawJson: { analysisRecords: [{ recordType: 'commitment', recordId: 'T2', title: 'tier-2', data: [] }] },
        recommendations: [{ agent: 'test-validator', title: 'tier-4', priority: 'suggested' }],
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records).toHaveLength(1);
      expect(records[0].recordId).toBe('T1');
    });

    it('Tier 2 (structured) wins over Tier 3 (exploration maps) / Tier 4 (recommendations)', () => {
      const result = makeAgentResult({
        rawJson: {
          analysisRecords: [{ recordType: 'commitment', recordId: 'T2', title: 'tier-2', data: [] }],
          explorationMaps: [{
            metadata: { explorerName: 'x', framework: 'y' },
            sections: [{ type: 'inventory', label: 'inv', entries: [{ key: 'M1', value: 'map item' }] }],
          }],
        },
        recommendations: [{ agent: 'test-validator', title: 'tier-4', priority: 'suggested' }],
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      expect(records).toHaveLength(1);
      expect(records[0].recordId).toBe('T2');
    });

    it('Tier 3 (exploration maps) wins over Tier 4 (recommendations)', () => {
      const result = makeAgentResult({
        rawJson: {
          explorationMaps: [{
            metadata: { explorerName: 'x', framework: 'y' },
            sections: [{ type: 'inventory', label: 'inv', entries: [{ key: 'M1', value: 'map item' }] }],
          }],
        },
        recommendations: [{ agent: 'test-validator', title: 'tier-4', priority: 'suggested' }],
      });
      const { records } = extractor.extract(result, makeResolvedDefinition());
      // Map-derived, not recommendation-derived.
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('M1');
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

    it('uses domain system_metrics from analysis block, with NO execution telemetry merged in', () => {
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

      // Cognitive metrics exactly as the agent submitted them (spec v0.1.2 D4)
      expect(summary.systemMetrics).toEqual({
        alignmentLevel: 'substantially aligned',
        statedClassificationsCount: 6,
        alignedClassificationsCount: 4,
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

    it('recovers the analysis block from rawJson.analysis when rawOutput is truncated mid-fence (d03bdb43)', () => {
      // rawOutput is capped at MAX_RAW_OUTPUT_BYTES in AgentExecutor; a report
      // exceeding the cap is clipped at the end, dropping the closing ```json fence.
      // OutputExtractor parsed the full (untruncated) output into rawJson, so
      // rawJson.analysis still carries the complete block. Simulate a clipped fence
      // (opening ```json present, closing ``` lost) and assert recovery.
      const clippedFence = `# Report\n\nLong prose...\n\n\`\`\`json\n{"agent":{"name":"test-validator"},"result":{"score":82},"analysis":{"category_scores":[{"name":"Impression Inventory","weight":20,"sc`;
      const result = makeAgentResult({
        rawOutput: clippedFence,
        rawJson: {
          agent: { name: 'test-validator' },
          result: { score: 82, decision: 'FACTUAL' },
          analysis: {
            category_scores: [
              { name: 'Impression Inventory', weight: 20, score: 17 },
              { name: 'Fact/Judgment Separation', weight: 30, score: 25 },
            ],
            records: [
              { recordType: 'commitment', recordId: 'R-1', title: 'Recovered finding', data: { status: 'OK' } },
            ],
          },
        },
      });
      const resolved = makeResolvedDefinition();
      const { summary, records } = extractor.extract(result, resolved);

      // The truncated fence yields no block; recovery comes from rawJson.analysis.
      expect(summary.categoryScores).toEqual([
        { name: 'Impression Inventory', weight: 20, score: 17 },
        { name: 'Fact/Judgment Separation', weight: 30, score: 25 },
      ]);
      expect(records).toHaveLength(1);
      expect(records[0].recordId).toBe('R-1');
      expect(records[0].recordType).toBe('commitment');
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
