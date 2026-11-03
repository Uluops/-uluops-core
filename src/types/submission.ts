import type { AnalysisRejection } from '@uluops/ops-sdk';
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

  /**
   * An agent definition to take the decision vocabulary and category weights from, for a
   * TOP-LEVEL `AgentResult` that carries no stamp of its own (hand-built, or serialized by core
   * <= 0.56.2). Since core 0.57.0 every result core's executors build carries those two facts
   * (`AgentResult.decisionVocabulary` / `categoryWeights`), analysis is extracted with or without
   * this field, and `UluOpsClient` no longer sets it. It is never applied to a composite's
   * children: a command, workflow or pipeline definition is not their definition. To stamp a
   * hand-built result instead, use `definitionFacts` (exported).
   */
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

  /** Whether all gates passed. null = NOT_A_GATE — the run carried no
   *  gate-bearing agents (read shape since ops-sdk 5.10.0; distinct from
   *  false, a gate ran and failed) */
  allGatesPassed: boolean | null;

  /** Average score across validators; null for scoreless (generator/executor) runs */
  averageScore: number | null;

  /** Issue correlation counts from submission API */
  correlation: {
    newIssues: number;
    recurringIssues: number;
    regressions: number;
  };

  /** Whether this was a deduplicated response */
  deduplicated: boolean;

  /**
   * Count of recommendations `sanitizeRecommendation` had to repair (coerce an
   * invalid required field, omit an invalid optional field, or truncate an
   * oversize one) before sending. Per-recommendation detail (which field, what
   * value) is emitted via the configured logger's `warn`; this is the run-level
   * tally so a caller can read/threshold on a number without grepping logs.
   * Absent on `getRun()` (a later read of an already-saved run — repair
   * happened, if at all, at the original `submit()` and isn't re-derivable
   * from a fetched run).
   */
  repairedRecommendations?: number;

  /**
   * How many entries the client DROPPED before sending, so the save could go through:
   * - `agents` (wire cap 100), `recommendations` (500), `analysisRecords` (100, plus any
   *   dropped from the end to keep the body under the tracker's 2 MB limit). Each cap is
   *   enforced inside `@uluops/ops-sdk` before any HTTP call and would otherwise abort the
   *   whole save, so core truncates the tail and warns (ship run #95, anxiety-reader).
   * - `analysisSummaries` (core >= 0.57.0): per-agent summaries past the wire's 20, or dropped
   *   from the end for the body limit.
   * - `analysisSummariesInvalid`: **always 0 since core 0.58.0, deprecated**, kept so a reader of
   *   the 0.57.0 shape does not break. 0.57.0 dropped summaries that failed ops-sdk's entry schema
   *   after repair; 0.58.0 sends them, and the tracker's verdict arrives in {@link analysisRejected}.
   *
   * A dropped summary is visible only here and in the warning log: nothing on the tracker
   * records it, so a run whose agent shows no summary may have had one dropped. Zeros are
   * measured: `{ agents: 0, ... }` means nothing was dropped. Absent on `getRun()` for the same
   * reason as `repairedRecommendations`.
   */
  truncated?: {
    agents: number;
    recommendations: number;
    analysisRecords: number;
    analysisSummaries: number;
    analysisSummariesInvalid: number;
  };

  /**
   * Agents whose analysis the tracker REJECTED while keeping the run (core >= 0.58.0; ops-api
   * R2, analysis-never-loses-the-run). The server judges analysis per agent: one invalid entry
   * rejects that agent's records and summary as a unit, and the save still succeeds. Each item is
   * ops-sdk's {@link AnalysisRejection}: `agentName` (null for an entry that is its own unit, and
   * for the `units_omitted` row), an open-string `reason`, the counts not stored, and `detail`.
   *
   * Unlike {@link truncated}, this is the SERVER's verdict, not a client-side drop. Present when
   * the server reported it (`[]` = nothing rejected); absent for a server before R2, a local
   * (tracking-off) response and `getRun()`. Repair with ops-sdk's `runs.update` on this run,
   * sending each rejected agent's complete set; submitting again creates a second run.
   */
  analysisRejected?: AnalysisRejection[];
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

  /** Whether all gates passed. null = NOT_A_GATE — the run carried no
   *  gate-bearing agents (read shape since ops-sdk 5.10.0; distinct from
   *  false, a gate ran and failed) */
  allGatesPassed: boolean | null;

  /** Average score across validators; null for scoreless (generator/executor) runs */
  averageScore: number | null;

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
