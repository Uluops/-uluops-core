import { OpsClient } from '@uluops/ops-sdk';
import type { ResolvedConfig } from '../types/config.js';
import type { ExecutionResult } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { RunSubmission, RunSubmissionResponse, RunHistoryEntry, ValidationQueryOptions } from '../types/validation.js';

/**
 * Thin wrapper around @uluops/ops-sdk for execution result submission.
 *
 * Delegates all API operations to OpsClient (which handles retry,
 * rate limiting, error mapping, auth). This class transforms
 * SDK ExecutionResult objects into the format expected by OpsClient.
 *
 * For full issue management, analytics, and taxonomy operations,
 * use `@uluops/ops-sdk` directly.
 */
export class ValidationClient {
  private ops: OpsClient;

  constructor(private config: ResolvedConfig) {
    this.ops = new OpsClient({
      apiKey: config.apiKey,
      baseUrl: config.validationUrl,
      timeout: config.timeout,
    });
  }

  /**
   * Submit execution results to validation service
   */
  async submit(submission: RunSubmission): Promise<RunSubmissionResponse> {
    if (!this.config.trackingEnabled) {
      return this.createLocalResponse(submission);
    }

    const input = this.transformToOpsInput(submission);
    const response = await this.ops.runs.save(input);

    return {
      runId: response.run.id,
      runNumber: response.run.runNumber,
      projectId: response.run.projectId,
      dashboardUrl: `${this.config.dashboardUrl}/runs/${response.run.id}`,
      allGatesPassed: response.run.allGatesPassed,
      averageScore: response.run.averageScore ?? 0,
      correlation: {
        newIssues: response.correlation?.newIssues ?? 0,
        recurringIssues: response.correlation?.recurringIssues ?? 0,
        regressions: response.correlation?.regressions ?? 0,
      },
      deduplicated: response.deduplicated,
    };
  }

  /**
   * Preview what a submission would do without saving (dry run).
   *
   * Accepts individual parameters matching the public UluOpsClient API.
   */
  async validateRun(
    project: string,
    workflowType: string,
    result: ExecutionResult | AgentResult,
  ): Promise<{
    wouldCreate: boolean;
    wouldUpdate: boolean;
    wouldRegress: boolean;
    validationErrors: string[];
  }> {
    const input = this.transformToOpsInput({ project, workflowType, result });
    const response = await this.ops.runs.validate(input);

    return {
      wouldCreate: Boolean(response.wouldCreate),
      wouldUpdate: Boolean(response.wouldUpdate),
      wouldRegress: Boolean(response.wouldRegress),
      validationErrors: response.validationErrors,
    };
  }

  /**
   * Get run history for a project
   */
  async getHistory(
    project: string,
    options?: Omit<ValidationQueryOptions, 'project'>,
  ): Promise<RunHistoryEntry[]> {
    const runs = await this.ops.runs.listByProject(project, {
      workflowType: options?.workflowType,
      limit: options?.limit,
    });

    return runs.map(r => ({
      id: r.id,
      projectId: r.projectId,
      runNumber: r.runNumber,
      workflowType: r.workflowType,
      timestamp: r.timestamp,
      allGatesPassed: r.allGatesPassed,
      averageScore: r.averageScore ?? 0,
      rawMarkdown: (r as Record<string, unknown>).rawMarkdown as string ?? undefined,
      archivedAt: r.archivedAt ?? undefined,
      archiveReason: r.archiveReason ?? undefined,
      idempotencyKey: (r as Record<string, unknown>).idempotencyKey as string | undefined,
      createdAt: r.createdAt,
      updatedAt: (r as Record<string, unknown>).updatedAt as string ?? r.createdAt,
    }));
  }

  /**
   * Get details for a specific run by ID
   */
  async getRun(runId: string): Promise<RunSubmissionResponse> {
    const run = await this.ops.runs.get(runId);
    return {
      runId: run.id,
      runNumber: run.runNumber,
      projectId: run.projectId,
      dashboardUrl: `${this.config.dashboardUrl}/runs/${run.id}`,
      allGatesPassed: run.allGatesPassed,
      averageScore: run.averageScore ?? 0,
      correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
      deduplicated: false,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Transform SDK RunSubmission to OpsClient SaveFeaturesListInput format
   */
  private transformToOpsInput(submission: RunSubmission): Parameters<OpsClient['runs']['save']>[0] {
    const { result } = submission;

    return {
      project: submission.project,
      workflowType: submission.workflowType,
      idempotencyKey: submission.idempotencyKey,
      agents: [{
        name: result.name,
        score: result.score ?? 0,
        maxScore: 100,
        decision: result.decision,
        model: result.metrics.model,
        tokens: {
          inputTokens: result.metrics.inputTokens,
          outputTokens: result.metrics.outputTokens,
          cacheCreationTokens: result.metrics.cacheCreationTokens,
          cacheReadTokens: result.metrics.cacheReadTokens,
          totalEffectiveTokens: result.metrics.totalEffectiveTokens,
        },
        durationMs: result.metrics.durationMs,
      }],
      recommendations: result.recommendations.map(r => ({
        agent: r.agent ?? 'unknown',
        title: r.title,
        priority: r.priority,
        severity: r.severity,
        failureCode: r.failureCode,
        failureDomain: r.failureDomain,
        failureMode: r.failureMode,
        category: r.category,
        filePath: r.filePath,
        lineNumber: r.lineNumber,
        description: r.description,
        classificationConfidence: r.classificationConfidence,
        classifiedBy: r.classifiedBy,
        secondaryFailureCodes: r.secondaryFailureCodes,
        taxonomyVersion: r.taxonomyVersion,
      })),
      timestamp: new Date().toISOString(),
      rawMarkdown: submission.rawMarkdown,
      summary: {
        allGatesPassed: result.decision === 'PASS' || result.decision === 'SHIP',
        averageScore: result.score ?? 0,
      },
      definitionType: result.type,
      definitionName: result.name,
      definitionVersion: result.version !== 'unknown' ? result.version : undefined,
      definitionHash: result.definitionHash?.replace(/^sha256:/, ''),
    };
  }

  /**
   * Create a local-only response when tracking is disabled
   */
  private createLocalResponse(submission: RunSubmission): RunSubmissionResponse {
    return {
      runId: 'local',
      runNumber: 0,
      projectId: 'local',
      dashboardUrl: '',
      allGatesPassed: submission.result.decision === 'PASS' || submission.result.decision === 'SHIP',
      averageScore: submission.result.score ?? 0,
      correlation: {
        newIssues: submission.result.recommendations.length,
        recurringIssues: 0,
        regressions: 0,
      },
      deduplicated: false,
    };
  }
}
