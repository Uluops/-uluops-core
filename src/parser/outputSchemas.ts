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
 * Category breakdown for validators
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
 * Base output schema — shared by all agent types.
 *
 * Decision is z.string() (not an enum) because agents use diverse
 * decision vocabularies: PASS/FAIL, EXAMINED/UNEXAMINED, ALIGNED/MISALIGNED,
 * CALIBRATED/OVERCONFIDENT, etc. normalizeDecision() handles synonym mapping.
 */
const baseOutputSchema = z.object({
  decision: z.string()
    .describe('Overall decision (e.g., PASS, FAIL, EXAMINED, ALIGNED)'),
  score: z.number().min(0).max(100)
    .describe('Overall score from 0 to 100'),
  maxScore: z.number()
    .describe('Maximum possible score (typically 100)'),
  summary: z.string().nullable()
    .describe('Brief human-readable summary of the result'),
});

/**
 * Validator output schema — extends base with category breakdown.
 */
export const validatorOutputSchema = baseOutputSchema.extend({
  categories: z.array(categorySchema).nullable()
    .describe('Category breakdown with individual findings'),
});

/**
 * Executor output schema — extends base with artifacts.
 */
export const executorOutputSchema = baseOutputSchema.extend({
  artifacts: z.array(z.object({
    type: z.string().describe('Artifact type (e.g., "file", "report")'),
    path: z.string().nullable().describe('File path if applicable'),
    content: z.string().nullable().describe('Artifact content'),
  })).nullable().describe('Generated artifacts'),
});

/**
 * Generic agent output schema — for analyst, generator, explorer, forecaster types.
 * Uses the base schema without type-specific extensions.
 */
export const genericOutputSchema = baseOutputSchema;

export type ValidatorOutput = z.infer<typeof validatorOutputSchema>;
export type ExecutorOutput = z.infer<typeof executorOutputSchema>;
export type GenericOutput = z.infer<typeof genericOutputSchema>;

/**
 * Compile-time check: issueSchema fields must be a superset of Issue fields.
 * If Issue gains a field not in issueSchema, this line will produce a type error,
 * preventing silent data loss from Zod dropping unknown fields.
 *
 * Note: Zod uses nullable (T | null), Issue uses optional (T | undefined).
 * The null→undefined mapping happens in mapStructuredOutput/OutputExtractor.
 */
type ZodIssue = z.infer<typeof issueSchema>;
export type _AssertIssueFieldsCovered = {
  [K in keyof Required<Issue>]: K extends keyof ZodIssue ? true : never;
};
