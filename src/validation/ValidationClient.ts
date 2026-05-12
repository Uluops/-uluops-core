import { OpsClient, type AnalysisSummaryInput, type AnalysisRecordInput } from '@uluops/ops-sdk';
import type { ResolvedConfig } from '../types/config.js';
import type { ExecutionResult, ExecutionMetrics } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { CommandResult } from '../types/command.js';
import type { RunSubmission, RunSubmissionResponse, RunHistoryEntry, ValidationQueryOptions } from '../types/validation.js';
import { AnalysisSummaryExtractor } from '../analysis/AnalysisSummaryExtractor.js';

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
  private readonly analysisExtractor = new AnalysisSummaryExtractor();

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
   * Determine if a decision is positive using decisionCategory (agents) or raw string fallback.
   * Resolves Aporia A3: cognitive lens agents with non-PASS positive decisions
   * (EXAMINED, VITAL, FLOWING, etc.) now correctly report allGatesPassed: true.
   */
  private isPositiveDecision(result: ExecutionResult | AgentResult): boolean {
    if ('decisionCategory' in result && result.decisionCategory) {
      return result.decisionCategory === 'positive';
    }
    return result.decision === 'PASS' || result.decision === 'SHIP';
  }

  /**
   * Transform SDK RunSubmission to OpsClient SaveFeaturesListInput format
   */
  private transformToOpsInput(submission: RunSubmission): Parameters<OpsClient['runs']['save']>[0] {
    const { result } = submission;

    // Workflow/pipeline results: decompose phases into per-agent entries
    const agents = this.isWorkflowResult(result)
      ? this.extractWorkflowAgents(result)
      : [this.resultToAgent(result)];

    // Extract analysis summary and records when definition is available and result is an agent
    let analysisSummary: AnalysisSummaryInput | undefined;
    let analysisRecords: AnalysisRecordInput[] | undefined;

    if (submission.resolvedDefinition && this.isAgentResult(result)) {
      const analysis = this.analysisExtractor.extract(result as AgentResult, submission.resolvedDefinition);
      analysisSummary = analysis.summary;
      analysisRecords = analysis.records.length > 0 ? analysis.records : undefined;
    }

    return {
      project: submission.project,
      workflowType: submission.workflowType,
      idempotencyKey: submission.idempotencyKey,
      agents,
      recommendations: result.recommendations.map(r => ({
        agent: r.agent ?? 'unknown',
        title: r.title,
        priority: r.priority,
        severity: r.severity,
        failureCode: r.failureCode && /^(STR|SEM|PRA|EPI)-[A-Z]{3}\/[CHMLI]$/.test(r.failureCode) ? r.failureCode : undefined,
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
        allGatesPassed: this.isPositiveDecision(result),
        averageScore: result.score ?? 0,
      },
      definitionType: result.type,
      definitionName: result.name,
      definitionVersion: result.version !== 'unknown' ? result.version : undefined,
      definitionHash: result.definitionHash?.replace(/^sha256:/, ''),
      definitionMinSubscription: result.minSubscription,
      analysisSummary,
      analysisRecords,
    };
  }

  /**
   * Check if a result is an AgentResult (type === 'agent').
   */
  private isAgentResult(result: ExecutionResult | AgentResult): result is AgentResult {
    return result.type === 'agent';
  }

  /**
   * Check if a result is a WorkflowResult with decomposable phases.
   */
  private isWorkflowResult(result: ExecutionResult | AgentResult): result is WorkflowResult {
    return result.type === 'workflow' && 'phases' in result && Array.isArray((result as WorkflowResult).phases);
  }

  /**
   * Extract individual agent entries from workflow phases.
   * Each command result within a phase becomes its own agent entry.
   */
  private extractWorkflowAgents(result: WorkflowResult): ReturnType<typeof this.resultToAgent>[] {
    const agents: ReturnType<typeof this.resultToAgent>[] = [];

    for (const phase of result.phases) {
      if (phase.decision === 'skipped' || phase.decision === 'aborted') continue;
      for (const cmd of phase.commands) {
        agents.push(this.commandToAgent(cmd));
      }
    }

    // Fallback: if no agents were extracted (all phases skipped), create a single entry
    if (agents.length === 0) {
      agents.push(this.resultToAgent(result));
    }

    return agents;
  }

  /**
   * Convert a single ExecutionResult or AgentResult into an agent tracker entry.
   */
  private resultToAgent(result: ExecutionResult | AgentResult) {
    return {
      name: result.name,
      definitionVersion: result.version !== 'unknown' ? result.version : undefined,
      score: result.score ?? 0,
      maxScore: 100,
      decision: result.decision,
      summary: 'summary' in result ? (result as AgentResult).summary : undefined,
      model: result.metrics.model,
      tokens: this.extractTokens(result.metrics),
      durationMs: result.metrics.durationMs,
    };
  }

  /**
   * Convert a CommandResult into an agent tracker entry.
   */
  private commandToAgent(cmd: CommandResult) {
    return {
      name: cmd.name,
      definitionVersion: cmd.version !== 'unknown' ? cmd.version : undefined,
      score: cmd.score ?? 0,
      maxScore: cmd.maxScore ?? 100,
      decision: cmd.decision,
      summary: undefined as string | undefined,
      model: cmd.metrics.model,
      tokens: this.extractTokens(cmd.metrics),
      durationMs: cmd.metrics.durationMs,
    };
  }

  /** Extract token metrics into the tracker's expected shape. */
  private extractTokens(metrics: ExecutionMetrics) {
    return {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheCreationTokens: metrics.cacheCreationTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      thinkingTokens: metrics.thinkingTokens,
      totalEffectiveTokens: metrics.totalEffectiveTokens,
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
      allGatesPassed: this.isPositiveDecision(submission.result),
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
