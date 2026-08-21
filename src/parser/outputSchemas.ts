import { z } from 'zod';
import type { Issue } from '../types/command.js';

/**
 * Optional field that also tolerates an explicit `null` from the model.
 *
 * Emits NO union in the JSON schema — the field is simply absent from `required` — which is what
 * keeps the Anthropic union count under its ceiling. But models have been taught by the previous
 * all-nullable schema to send `"field": null`, and bare `.optional()` REJECTS that, which would
 * turn a previously-working run into a hard ExecutionError at mapStructuredOutput's safeParse.
 * The preprocess coerces null to absent before validation, so both shapes parse identically.
 */
const optionalNullTolerant = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === null ? undefined : v), inner);

/**
 * Issue within a finding — matches the Issue type from types/command.ts
 *
 * NULLABLE vs OPTIONAL — this file balances two provider constraints that pull opposite ways.
 *
 * OpenAI strict mode rejects `.optional()` (every property must be in `required`), which is why
 * this schema was originally all-`.nullable()` — see docs/spikes/nullable-structured-output.md.
 * But Zod renders every `.nullable()` as a JSON-Schema union, and ANTHROPIC rejects a schema with
 * more than 16 union-typed parameters with HTTP 400 *before the model runs*. At 29 nullables the
 * schema was unusable on Anthropic entirely while working fine on OpenAI — invisible until a live
 * run, because most traffic goes through the Claude Code harness rather than this engine.
 *
 * Resolution: fields whose consumers cannot distinguish null from absent are `.optional()`
 * (verified per-field — every reader uses `?? default`, and AnalysisSummaryExtractor's
 * extractJsonField collapses the two), and OpenAI strict mode is disabled via
 * `providerOptions.openai.strictJsonSchema: false` in AIProvider.buildOpenAIOptions.
 *
 * SIX fields stay `.nullable()` deliberately:
 *   - score / maxScore, and category score / maxScore — null carries meaning ("failed to score",
 *     NOT zero) and the null-iff invariant is enforced by a compile-time assertion at the bottom
 *     of this file. `.optional()` yields `number | undefined` and hard-fails tsc there.
 *   - finding pointsEarned / pointsPossible — same "null for scoreless" family (types/parser.ts),
 *     and converting them is not needed to stay under the limit.
 *
 * The union budget is enforced by test/parser/schemaUnionBudget.test.ts, which converts this
 * schema through the same path the AI SDK uses and asserts the count Anthropic would see.
 */
const issueSchema = z.object({
  title: z.string().describe('Short description of the issue'),
  description: optionalNullTolerant(z.string().optional().describe('Detailed explanation')),
  priority: optionalNullTolerant(z.enum(['critical', 'suggested', 'backlog']).optional()
    .describe('Issue priority level')),
  severity: optionalNullTolerant(z.enum(['critical', 'high', 'medium', 'low', 'info']).optional()
    .describe('Issue severity level')),
  filePath: optionalNullTolerant(z.string().optional().describe('File path where the issue was found')),
  lineNumber: optionalNullTolerant(z.number().optional().describe('Line number in the file')),
  failureCode: optionalNullTolerant(z.string().optional().describe('Machine-readable failure code')),
});

/**
 * Category breakdown — universal across all agent types.
 */
const categorySchema = z.object({
  name: z.string().describe('Category name (e.g., "Code Quality", "Security")'),
  score: z.number().nullable().describe('Points earned in this category (null iff maxScore null)'),
  maxScore: z.number().nullable().describe('Maximum score possible (null for scoreless agents)'),
  findings: z.array(z.object({
    criterion: z.string().describe('What is being evaluated'),
    pointsEarned: z.number().nullable(),
    pointsPossible: z.number().nullable(),
    issues: z.array(issueSchema).describe('Issues found for this criterion'),
  })).describe('Findings within this category'),
});

/**
 * Artifact produced by executor agents.
 */
const artifactSchema = z.object({
  type: z.string().describe('Artifact type (e.g., "file", "report")'),
  path: optionalNullTolerant(z.string().optional().describe('File path if applicable')),
  content: optionalNullTolerant(z.string().optional().describe('Artifact content')),
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
  summary: optionalNullTolerant(z.string().optional().describe('Brief section summary')),
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
    artifactPath: optionalNullTolerant(z.string().optional().describe('Path to the artifact being explored')),
  }),
  sections: z.array(explorationSectionSchema).describe('Typed structural sections of the exploration'),
});

/**
 * Epistemic assessment — confidence and grounding analysis from cognitive lens agents.
 */
const epistemicAssessmentSchema = z.object({
  confidence: z.enum(['high', 'medium', 'low']).describe('Overall confidence in the analysis'),
  groundingRatio: optionalNullTolerant(z.number().optional().describe('Ratio of grounded claims to total claims (0-1)')),
  keyUncertainties: optionalNullTolerant(z.array(z.string()).optional().describe('Major sources of uncertainty in the analysis')),
  methodology: optionalNullTolerant(z.string().optional().describe('Analytical methodology applied')),
});

/**
 * Audit implication — forward-looking projection from forecaster/analyst agents.
 */
const auditImplicationSchema = z.string()
  .describe('A forward-looking implication or trajectory projection from the analysis');

/**
 * Analysis record — typed finding from cognitive lens, explorer, or forecaster agents.
 *
 * Uses key-value entries for data (OpenAI strict mode compatible) instead of
 * z.record(). The AnalysisSummaryExtractor converts entries to the API's
 * Record<string, unknown> data format.
 */
const analysisRecordSchema = z.object({
  recordType: z.string()
    .describe('Record type matching the agent\'s domain vocabulary (e.g., commitment, inquiry_question, evidence_claim, convention, tension, decay_vector, reification_candidate)'),
  recordId: z.string()
    .describe('Agent-local ID within this run. Semantic, namespaced IDs allowed (e.g., R-1, foundations-api-aristotle-20260626). Max 100 characters.'),
  title: z.string()
    .describe('Human-readable title of the finding'),
  classification: optionalNullTolerant(z.string().optional()
    .describe('Classification label (e.g., PROMISING, SPECULATIVE, INTERPRETED-OPAQUE, FACTUAL)')),
  severity: optionalNullTolerant(z.string().optional()
    .describe('Severity or significance level (e.g., critical, high, medium, low, info)')),
  data: z.array(explorationEntrySchema)
    .describe('Structured data as key-value entries. Keys vary by record type — include relevant fields like status, evidence, filePath, lineNumber, description, rationale.'),
});

/**
 * Domain metric — agent-specific quantitative measurement.
 *
 * Uses key-value pairs instead of z.record() for OpenAI strict mode compatibility.
 * The AnalysisSummaryExtractor converts these to the API's systemMetrics format,
 * merged with execution metrics (tokens, duration, model).
 */
const domainMetricSchema = z.object({
  key: z.string().describe('Metric key matching the agent definition\'s metrics vocabulary (e.g., atomsIdentified, candidatesIdentified, feedbackLoopsIdentified)'),
  value: z.string().describe('Metric value (stringified number or enum)'),
});

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
  // Nullable for generators/executors that produce artifacts, not scores.
  // No .min/.max here: structured-output spike (0a) found Anthropic rejects
  // min/max on numbers and OpenAI strict rejects .optional(); required+nullable
  // is the only cross-provider shape. Range (0-100) is enforced at the
  // AgentExecutor mapping layer instead. Invariant: score null iff maxScore null.
  score: z.number().nullable()
    .describe('Overall score 0-100, or null for generators/executors producing artifacts not scores'),
  maxScore: z.number().nullable()
    .describe('Maximum possible score; null iff score is null'),
  summary: optionalNullTolerant(z.string().optional()
    .describe('Brief human-readable summary of the result')),
  categories: optionalNullTolerant(z.array(categorySchema).optional()
    .describe('Category breakdown with individual findings')),
  artifacts: optionalNullTolerant(z.array(artifactSchema).optional()
    .describe('Generated artifacts (executor agents)')),
  explorationMaps: optionalNullTolerant(z.array(explorationMapSchema).optional()
    .describe('Structural mappings from explorer agents — level maps, inventories, topologies, claim extractions, inquiry agendas. Null for non-explorer agents.')),
  epistemicAssessment: optionalNullTolerant(epistemicAssessmentSchema.optional()
    .describe('Epistemic confidence and grounding assessment from cognitive lens agents. Null for validators/executors.')),
  auditImplications: optionalNullTolerant(z.array(auditImplicationSchema).optional()
    .describe('Forward-looking trajectory projections and audit implications from analyst/forecaster agents. Null for validators/executors.')),
  analysisRecords: optionalNullTolerant(z.array(analysisRecordSchema).optional()
    .describe('Typed analysis records — structured findings with domain-specific record types (commitment, inquiry_question, evidence_claim, convention, tension, reification_candidate, etc.) and meaningful IDs (R-1, IQ-2, EC-3). Null for validators/executors.')),
  domainMetrics: optionalNullTolerant(z.array(domainMetricSchema).optional()
    .describe('Agent-specific quantitative metrics as defined in the agent\'s metrics vocabulary (e.g., atomsIdentified:20, candidatesIdentified:5). Null when no domain metrics are applicable.')),
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

/**
 * Score-shaped fields (overall score/maxScore and per-category score/maxScore)
 * must remain EXACTLY `number | null` — the null-iff invariant (score null iff
 * maxScore null) and every `?? null` coercion site depend on it. This guard is a
 * hard compile-fail if any of the four drifts (e.g. back to `number`, or widens
 * to `number | undefined`). Added by agent-schema-score-nullability-spec.
 */
type _Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type _AssertTrue<T extends true> = T;
type _AgentOutput = z.infer<typeof agentOutputSchema>;
type _AgentCategory = NonNullable<_AgentOutput['categories']>[number];
export type _AssertScoreShapedFieldsNullable = [
  _AssertTrue<_Equals<_AgentOutput['score'], number | null>>,
  _AssertTrue<_Equals<_AgentOutput['maxScore'], number | null>>,
  _AssertTrue<_Equals<_AgentCategory['score'], number | null>>,
  _AssertTrue<_Equals<_AgentCategory['maxScore'], number | null>>,
];
