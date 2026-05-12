import type { ExecutionResult, Recommendation } from './execution.js';
import type { AgentResult } from './agent.js';
import type { ResolvedDefinition } from './registry.js';

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

  /** Resolved definition — enables analysis summary extraction at submission time.
   * Passed through from UluOpsClient.trackIfEnabled() when available. */
  resolvedDefinition?: ResolvedDefinition;
}

/**
 * SDK's high-level response after submission.
 *
 * Correlation contains issue counts from the Submission API.
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

  /** Whether all gates passed */
  allGatesPassed: boolean;

  /** Average score across validators */
  averageScore: number;

  /** Issue correlation counts from submission API */
  correlation: {
    newIssues: number;
    recurringIssues: number;
    regressions: number;
  };

  /** Whether this was a deduplicated response */
  deduplicated: boolean;
}

/**
 * Recommendation with fingerprint from submission service
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
 * Query options for submission service run history
 */
export interface SubmissionQueryOptions {
  /** Filter by project */
  project?: string;

  /** Filter by workflow type */
  workflowType?: string;

  /** Limit results (1-100) */
  limit?: number;
}

/**
 * Run history entry - matches Submission API Run model
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

  /** Whether all gates passed */
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
