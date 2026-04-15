import type { ExecutionResult, Recommendation } from './execution.js';
import type { AgentResult } from './agent.js';

/**
 * SDK's high-level run submission input
 */
export interface RunSubmission {
  /** Project name */
  project: string;

  /** Workflow/definition name */
  workflowType: string;

  /** Execution result to submit (agent results are also accepted) */
  result: ExecutionResult | AgentResult;

  /** Optional idempotency key */
  idempotencyKey?: string;

  /** Optional raw markdown output */
  rawMarkdown?: string;
}

/**
 * SDK's high-level response after submission.
 *
 * Correlation contains issue counts from the Validation API.
 * For full issue details (CorrelatedIssue arrays), use `@uluops/ops-sdk` directly.
 */
export interface RunSubmissionResponse {
  /** Unique run identifier */
  runId: string;

  /** Run number within project */
  runNumber: number;

  /** Project ID */
  projectId: string;

  /** Dashboard URL for this run */
  dashboardUrl: string;

  /** Whether all validation gates passed */
  allGatesPassed: boolean;

  /** Average score across validators */
  averageScore: number;

  /** Issue correlation counts from validation API */
  correlation: {
    newIssues: number;
    recurringIssues: number;
    regressions: number;
  };

  /** Whether this was a deduplicated response */
  deduplicated: boolean;
}

/**
 * Recommendation with fingerprint from validation service
 */
export interface FingerprintedRecommendation extends Recommendation {
  /** Stable fingerprint for correlation */
  fingerprint: string;

  /** First seen timestamp */
  firstSeen: string;

  /** Occurrence count across runs */
  occurrenceCount: number;

  /** Status */
  status: 'new' | 'recurring' | 'resolved';
}

/**
 * Regression information
 */
export interface RegressionInfo {
  /** Recommendation that regressed */
  recommendation: FingerprintedRecommendation;

  /** Previous run where it was resolved */
  previousRunId: string;

  /** How long it was resolved */
  resolvedDuration: string;
}

/**
 * Query options for validation service run history
 */
export interface ValidationQueryOptions {
  /** Filter by project */
  project?: string;

  /** Filter by workflow type */
  workflowType?: string;

  /** Limit results (1-100) */
  limit?: number;
}

/**
 * Run history entry - matches Validation API Run model
 */
export interface RunHistoryEntry {
  /** Run UUID */
  id: string;

  /** Project UUID */
  projectId: string;

  /** Sequential run number within project */
  runNumber: number;

  /** Workflow type */
  workflowType: string;

  /** Run timestamp */
  timestamp: string;

  /** Whether all validation gates passed */
  allGatesPassed: boolean;

  /** Average score across validators */
  averageScore: number;

  /** Raw markdown output (if stored) */
  rawMarkdown?: string;

  /** Archive timestamp (if archived) */
  archivedAt?: string;

  /** Archive reason (if archived) */
  archiveReason?: string;

  /** Idempotency key (if provided) */
  idempotencyKey?: string;

  /** Creation timestamp */
  createdAt: string;

  /** Last update timestamp */
  updatedAt: string;
}
