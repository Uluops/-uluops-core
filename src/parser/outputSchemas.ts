import { z } from 'zod';
import type { Issue } from '../types/command.js';

/**
 * Issue within a finding — matches the Issue type from types/command.ts
 *
 * NOTE: All optional fields use .nullable() instead of .optional() because
 * OpenAI's strict structured output mode rejects optional properties.
 * See: https://platform.openai.com/docs/guides/structured-outputs/supported-schemas
 */
const issueSchema = z.object({
  title: z.string().describe('Short description of the issue'),
  description: z.string().nullable().describe('Detailed explanation'),
  priority: z.enum(['critical', 'suggested', 'backlog']).nullable()
    .describe('Issue priority level'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable()
    .describe('Issue severity level'),
  filePath: z.string().nullable().describe('File path where the issue was found'),
  lineNumber: z.number().nullable().describe('Line number in the file'),
  failureCode: z.string().nullable().describe('Machine-readable failure code'),
});

/**
 * Category breakdown — universal across all agent types.
 */
const categorySchema = z.object({
  name: z.string().describe('Category name (e.g., "Code Quality", "Security")'),
  score: z.number().describe('Points earned in this category'),
  maxScore: z.number().describe('Maximum score possible'),
  findings: z.array(z.object({
    criterion: z.string().describe('What is being evaluated'),
    pointsEarned: z.number(),
    pointsPossible: z.number(),
    issues: z.array(issueSchema).describe('Issues found for this criterion'),
  })).describe('Findings within this category'),
});

/**
 * Artifact produced by executor agents.
 */
const artifactSchema = z.object({
  type: z.string().describe('Artifact type (e.g., "file", "report")'),
  path: z.string().nullable().describe('File path if applicable'),
  content: z.string().nullable().describe('Artifact content'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Extension Schemas
//
// These fields extend the universal output schema to capture structured
// analytical output from cognitive lens, explorer, and forecaster agents.
// Validators and executors leave these null. The AnalysisSummaryExtractor
// reads them from rawJson at submission time.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key-value entry for exploration section data.
 *
 * OpenAI strict mode rejects z.record(z.string(), z.unknown()) because
 * additionalProperties needs a type key. Array of {key, value} entries
 * is the compatible alternative that preserves arbitrary structured data.
 */
const explorationEntrySchema = z.object({
  key: z.string().describe('Entry identifier'),
  value: z.string().describe('Entry content (JSON-stringified if complex)'),
});

/**
 * Exploration map section — typed structural output from explorer agents.
 *
 * Uses a simplified schema (type + label + entries) compatible with
 * OpenAI strict structured output. The AnalysisSummaryExtractor
 * reshapes entries back into typed section objects downstream.
 */
const explorationSectionSchema = z.object({
  type: z.enum(['inventory', 'topology', 'landscape', 'classification', 'mapping', 'synthesis', 'limitation', 'agenda'])
    .describe('Section type: inventory (items), topology (entities+relationships), landscape (findings across dimensions), classification (hierarchy), mapping (source→target), synthesis (patterns), limitation (blind spots), agenda (inquiry questions)'),
  label: z.string().describe('Human-readable section title'),
  summary: z.string().nullable().describe('Brief section summary'),
  entries: z.array(explorationEntrySchema)
    .describe('Section data as key-value entries. Keys vary by type — inventory: item names; topology: entity/relationship names; landscape: dimension names; agenda: question identifiers. Values contain the structured content.'),
});

/**
 * Structural mapping produced by explorer-class agents.
 */
const explorationMapSchema = z.object({
  metadata: z.object({
    explorerName: z.string().describe('Name of the explorer agent'),
    framework: z.string().describe('Analytical framework used (e.g., "logical-levels", "reductive-decomposition")'),
    artifactPath: z.string().nullable().describe('Path to the artifact being explored'),
  }),
  sections: z.array(explorationSectionSchema).describe('Typed structural sections of the exploration'),
});

/**
 * Epistemic assessment — confidence and grounding analysis from cognitive lens agents.
 */
const epistemicAssessmentSchema = z.object({
  confidence: z.enum(['high', 'medium', 'low']).describe('Overall confidence in the analysis'),
  groundingRatio: z.number().nullable().describe('Ratio of grounded claims to total claims (0-1)'),
  keyUncertainties: z.array(z.string()).nullable().describe('Major sources of uncertainty in the analysis'),
  methodology: z.string().nullable().describe('Analytical methodology applied'),
});

/**
 * Audit implication — forward-looking projection from forecaster/analyst agents.
 */
const auditImplicationSchema = z.string()
  .describe('A forward-looking implication or trajectory projection from the analysis');

/**
 * Universal agent output schema — used by all 6 agent types.
 *
 * Decision is z.string() (not an enum) because agents use diverse
 * decision vocabularies: PASS/FAIL, EXAMINED/UNEXAMINED, ALIGNED/MISALIGNED,
 * VITAL/DECADENT, etc. classifyDecision() normalizes via vocabulary maps.
 *
 * Categories and artifacts are both nullable — validators and analysts
 * produce categories; executors produce artifacts; some agents produce both.
 *
 * DESIGN TRADE-OFF (2026-04-16): one universal schema is intentionally lossy.
 * It erases distinctions between agent families (a validator's score categories
 * vs an executor's task artifacts vs a forecaster's scenario analysis) in
 * exchange for a uniform pipeline. The alternative — per-agentType schemas —
 * would be more faithful but would fork the extraction, tracking, and
 * aggregation paths. The loss is acceptable because downstream processing
 * (tracker, analytics, RAH) already branches on agentType when it matters.
 */
export const agentOutputSchema = z.object({
  decision: z.string()
    .describe('Overall decision (e.g., PASS, FAIL, EXAMINED, ALIGNED, VITAL)'),
  score: z.number().min(0).max(100)
    .describe('Overall score from 0 to 100'),
  maxScore: z.number()
    .describe('Maximum possible score (typically 100)'),
  summary: z.string().nullable()
    .describe('Brief human-readable summary of the result'),
  categories: z.array(categorySchema).nullable()
    .describe('Category breakdown with individual findings'),
  artifacts: z.array(artifactSchema).nullable()
    .describe('Generated artifacts (executor agents)'),
  explorationMaps: z.array(explorationMapSchema).nullable()
    .describe('Structural mappings from explorer agents — level maps, inventories, topologies, claim extractions, inquiry agendas. Null for non-explorer agents.'),
  epistemicAssessment: epistemicAssessmentSchema.nullable()
    .describe('Epistemic confidence and grounding assessment from cognitive lens agents. Null for validators/executors.'),
  auditImplications: z.array(auditImplicationSchema).nullable()
    .describe('Forward-looking trajectory projections and audit implications from analyst/forecaster agents. Null for validators/executors.'),
});

/**
 * Compile-time check: issueSchema fields must be a superset of Issue fields.
 * If Issue gains a field not in issueSchema, this line will produce a type error,
 * preventing silent data loss from Zod dropping unknown fields.
 *
 * Note: Zod uses nullable (T | null), Issue uses optional (T | undefined).
 * The null→undefined mapping happens in mapStructuredOutput/OutputExtractor.
 *
 * LOAD-BEARING TRIAD (2026-04-16): this check, the Issue type in command.ts,
 * and AgentExecutor.flattenRecommendations() form a tight coupling triangle.
 * A field change to any one silently alters recommendation shape across all
 * agents. This compile-time guard catches field additions but not semantic
 * drift (e.g., changing what a field means without changing its name).
 */
type ZodIssue = z.infer<typeof issueSchema>;
export type _AssertIssueFieldsCovered = {
  [K in keyof Required<Issue>]: K extends keyof ZodIssue ? true : never;
};
