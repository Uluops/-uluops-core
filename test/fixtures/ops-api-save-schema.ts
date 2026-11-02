/**
 * Test oracle: the analysis-bearing parts of ops-api's `POST /runs` input schema, translated to
 * this package's zod (v4). The submission-analysis-fidelity spec (v0.2.1 §6) requires every
 * payload assertion to pass BOTH this and ops-sdk's `SaveRunInputSchema`. ops-sdk alone cannot
 * be the oracle: it accepts non-integer category scores, 21-50 exploration maps, 51-100
 * sections, non-object section items and unbounded metric blobs, all of which the API rejects
 * with a 400 that loses the whole save.
 *
 * Translated from ops-uluops-api at commit e5532bc2 (2026-11-01):
 *   - src/controllers/run-transformers.ts:21-49 (BoundedJsonRecord), :54-60 (AgentInputSchema),
 *     :120-168 (AnalysisRecordInputSchema, CategoryScoreInputSchema, AnalysisSummaryInputSchema),
 *     :217-222 (analysisRecords / analysisSummary on SaveRunSchema)
 *   - src/business-objects/analysis-summary.ts:10-86 (ExplorationSectionSchema, ExplorationMapSchema)
 *
 * This proves conformance to THAT SNAPSHOT, not to the live server. Nothing re-checks it when
 * ops-api changes; refresh it (and the commit above) whenever those files change. The durable fix
 * is server-side per-entry acceptance (spec §8). Recommendation fields and the rest of
 * SaveRunSchema are omitted: they are not what this spec changes.
 */
import { z } from 'zod';

const MAX_ANALYSIS_BLOB_BYTES = 64 * 1024;
const MAX_ANALYSIS_BLOB_DEPTH = 8;

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_ANALYSIS_BLOB_DEPTH) return depth;
  if (value === null || typeof value !== 'object') return depth;
  let max = depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    max = Math.max(max, jsonDepth(child, depth + 1));
    if (max > MAX_ANALYSIS_BLOB_DEPTH) return max;
  }
  return max;
}

const BoundedJsonRecord = z.record(z.string(), z.unknown())
  .refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_ANALYSIS_BLOB_BYTES, {
    message: `analysis blob exceeds ${MAX_ANALYSIS_BLOB_BYTES} bytes`,
  })
  .refine(v => jsonDepth(v) <= MAX_ANALYSIS_BLOB_DEPTH, {
    message: `analysis blob exceeds ${MAX_ANALYSIS_BLOB_DEPTH} levels of nesting`,
  });

const AGENT_TYPES = ['validator', 'analyst', 'explorer', 'forecaster', 'executor', 'generator'] as const;
const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const objectItems = z.array(z.record(z.string(), z.unknown())).optional();

const SectionBase = z.object({ type: z.string(), label: z.string(), summary: z.string().optional() });
const ExplorationSectionSchema = z.discriminatedUnion('type', [
  SectionBase.extend({ type: z.literal('inventory'), items: objectItems, gaps: z.array(z.string()).optional() }).loose(),
  SectionBase.extend({ type: z.literal('topology'), entities: objectItems, relationships: objectItems, clusters: objectItems }).loose(),
  SectionBase.extend({ type: z.literal('landscape'), dimensions: z.array(z.string()).optional(), findings: objectItems }).loose(),
  SectionBase.extend({ type: z.literal('classification'), hierarchy: objectItems }).loose(),
  SectionBase.extend({ type: z.literal('mapping'), sourceDomain: z.string().optional(), targetDomain: z.string().optional(), translations: objectItems }).loose(),
  SectionBase.extend({ type: z.literal('synthesis'), patterns: objectItems, archetypes: objectItems }).loose(),
  SectionBase.extend({ type: z.literal('limitation'), blindSpots: objectItems }).loose(),
  SectionBase.extend({ type: z.literal('agenda'), questions: objectItems }).loose(),
]);

const ExplorationMapSchema = z.object({
  metadata: z.object({ explorerName: z.string(), framework: z.string(), artifactPath: z.string().optional() }),
  sections: z.array(ExplorationSectionSchema).max(50),
});

const AgentInputSchema = z.object({
  name: z.string().min(1),
  decision: z.string().min(1),
}).loose();

const AnalysisRecordInputSchema = z.object({
  agentName: z.string().max(100).optional(),
  agentType: z.enum(AGENT_TYPES).optional().nullable(),
  recordType: z.string().min(1).max(50),
  recordId: z.string().max(100),
  title: z.string().max(500),
  classification: z.string().max(50).optional().nullable(),
  severity: Severity.optional().nullable(),
  data: BoundedJsonRecord,
});

const CategoryScoreInputSchema = z.object({
  name: z.string(),
  weight: z.number().int().min(1),
  score: z.number().int().min(0),
});

const AnalysisSummaryInputSchema = z.object({
  agentName: z.string().max(100).optional(),
  agentType: z.enum(AGENT_TYPES).optional().nullable(),
  decision: z.string().max(50),
  score: z.number().min(0).max(100).optional().nullable(),
  decisionVocabulary: z.string().max(100).optional().nullable(),
  systemMetrics: BoundedJsonRecord.optional().nullable(),
  categoryScores: z.array(CategoryScoreInputSchema).max(50).optional().nullable(),
  epistemicAssessment: BoundedJsonRecord.optional().nullable(),
  auditImplications: z.array(z.string().max(2000)).max(50).optional().nullable(),
  explorationMaps: z.array(ExplorationMapSchema).max(20).optional().nullable(),
});

/** The analysis-bearing slice of ops-api's SaveRunSchema (see header for what is omitted). */
export const OpsApiSaveRunAnalysisSchema = z.object({
  agents: z.array(AgentInputSchema).min(1).max(100),
  analysisRecords: z.array(AnalysisRecordInputSchema).max(100).optional(),
  analysisSummary: z.union([
    AnalysisSummaryInputSchema,
    z.array(AnalysisSummaryInputSchema).max(20),
  ]).optional(),
}).loose();
