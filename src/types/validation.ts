import type { ExecutionResult, Recommendation } from './execution.js';
import type { AgentResult } from './agent.js';

/**
 * Validator snapshot for API submission
 * Matches Validation API's validator object format
 */
export interface ValidatorSnapshot {
  /** Validator name */
  name: string;

  /** Score (0-100) */
  score: number;

  /** Maximum possible score */
  max_score?: number;

  /** Status (e.g., 'PASS', 'FAIL', 'WARN') */
  status: string;

  /** Model used */
  model?: string;

  /** Token usage metrics */
  tokens?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation?: number;
    cache_read?: number;
    total_effective?: number;
  };

  /** Execution duration in milliseconds */
  duration_ms?: number;
}

/**
 * Recommendation payload for API submission
 * Uses snake_case to match Validation API format
 */
export interface RecommendationPayload {
  /** Source validator */
  validator: string;

  /** Issue title */
  title: string;

  /** Priority level */
  priority: 'critical' | 'suggested' | 'backlog';

  /** Severity level */
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';

  /** Failure code (e.g., 'STR-SYN/C') */
  failure_code?: string;

  /** Failure domain */
  failure_domain?: 'STR' | 'SEM' | 'PRA' | 'EPI';

  /** Failure mode code */
  failure_mode?: string;

  /** Issue category */
  category?: string;

  /** File path */
  file_path?: string;

  /** Line number */
  line_number?: number;

  /** Detailed description */
  description?: string;

  /** Classification confidence */
  classification_confidence?: 'high' | 'medium' | 'low';

  /** Who classified this */
  classified_by?: 'validator' | 'classifier' | 'human';

  /** Secondary failure codes */
  secondary_failure_codes?: string[];

  /** Taxonomy version */
  taxonomy_version?: string;
}

/**
 * Run submission request to Validation API
 */
export interface ValidationRunRequest {
  /** Project name */
  project: string;

  /** Workflow type (e.g., 'post-implementation', 'ship') */
  workflow_type: string;

  /** Idempotency key for duplicate prevention */
  idempotency_key?: string;

  /** Validator snapshots */
  validators: ValidatorSnapshot[];

  /** Recommendations/issues found */
  recommendations: RecommendationPayload[];

  /** Run timestamp */
  timestamp?: string;

  /** Raw markdown output */
  raw_markdown?: string;

  /** Summary statistics */
  summary?: {
    all_gates_passed: boolean;
    average_score: number;
  };
}

/**
 * Correlated issue from API response
 */
export interface CorrelatedIssue {
  /** Issue UUID */
  id: string;

  /** Issue title */
  title: string;

  /** SHA-256 fingerprint */
  fingerprint: string;

  /** Occurrence count (for recurring issues) */
  occurrenceCount?: number;

  /** Run ID where resolved (for regressions) */
  resolvedRunId?: string;
}

/**
 * Raw API response from POST /v1/runs
 */
export interface ValidationAPIRunResponse {
  data: {
    run: {
      id: string;
      projectId: string;
      runNumber: number;
      workflowType: string;
      timestamp: string;
      allGatesPassed: boolean;
      averageScore: number;
      idempotencyKey?: string;
    };
    validators: ValidatorSnapshot[];
    correlation: {
      new_issues: CorrelatedIssue[];
      recurring_issues: CorrelatedIssue[];
      regressions: CorrelatedIssue[];
    };
    deduplicated: boolean;
  };
}

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
 * SDK's high-level response after submission
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

  /** New issues found in this run */
  newIssues: CorrelatedIssue[];

  /** Recurring issues seen again */
  recurringIssues: CorrelatedIssue[];

  /** Regressions (previously resolved issues that reappeared) */
  regressions: CorrelatedIssue[];

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
