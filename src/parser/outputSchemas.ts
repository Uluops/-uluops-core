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
