import { OpsClient, type AnalysisSummaryInput, type AnalysisRecordInput } from '@uluops/ops-sdk';
import type { ResolvedConfig } from '../types/config.js';
import type { ExecutionResult, ExecutionMetrics } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineResult } from '../types/pipeline.js';
import type { CommandResult } from '../types/command.js';
import type { RunSubmission, RunSubmissionResponse, RunHistoryEntry, SubmissionQueryOptions } from '../types/submission.js';
import { AnalysisSummaryExtractor } from '../analysis/AnalysisSummaryExtractor.js';
import { EXTRACTION_CONFIDENCE_THRESHOLD } from '../constants.js';

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
export class SubmissionClient {
  private _ops?: OpsClient;
  private readonly analysisExtractor = new AnalysisSummaryExtractor();

  constructor(private config: ResolvedConfig) {}

  /**
   * Lazily construct the underlying OpsClient on first API use.
   *
   * Deferring construction avoids emitting "No credentials found" warnings
   * during offline usage: `submit()` short-circuits before any API call when
   * `trackingEnabled` is false, so the OpsClient — and its credential check —
   * is never instantiated.
   */
  private get ops(): OpsClient {
    if (!this._ops) {
      this._ops = new OpsClient({
        apiKey: this.config.apiKey,
        baseUrl: this.config.submissionUrl,
        timeout: this.config.timeout,
      });
    }
    return this._ops;
  }

  /**
   * Submit execution results to the submission service.
   *
   * When `config.trackingEnabled` is false, returns a synthesized local response
   * without any network call. Otherwise transforms the result and POSTs it.
   *
   * @param submission - The run to submit. `submission.resolvedDefinition`, when
   *   present, enables richer per-agent analysis extraction.
   * @returns The {@link RunSubmissionResponse} — run id/number, dashboard URL, and correlation counts.
   * @throws {SubmissionError} If the service rejects the submission.
   * @throws {SdkApiError} For transport/auth failures from the underlying OpsClient.
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
      dashboardUrl: this.buildDashboardUrl(response.run),
      allGatesPassed: response.run.allGatesPassed,
      averageScore: response.run.averageScore ?? null, // preserve null (scoreless run), don't fabricate 0
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
   *
   * @param project - Target project name.
   * @param workflowType - Workflow type (`agent`/`command`/`workflow`/`pipeline`).
   * @param result - The execution result that would be submitted.
   * @returns Whether the submit would create/update/regress, plus any validation errors.
   * @throws {SdkApiError} For transport/auth failures from the underlying OpsClient.
   */
  async previewSubmission(
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
   * Get run history for a project.
   *
   * @param project - Target project name.
   * @param options - Optional filters: `workflowType`, `limit`.
   * @returns An array of {@link RunHistoryEntry} ordered by the service default (most recent first).
   * @throws {SdkApiError} For transport/auth failures from the underlying OpsClient.
   */
  async getHistory(
    project: string,
    options?: Omit<SubmissionQueryOptions, 'project'>,
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
      averageScore: r.averageScore ?? null, // preserve null on read
      rawMarkdown: r.rawMarkdown ?? undefined,
      archivedAt: r.archivedAt ?? undefined,
      archiveReason: r.archiveReason ?? undefined,
      idempotencyKey: r.idempotencyKey ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt ?? r.createdAt,
    }));
  }

  /**
   * Get details for a specific run by ID.
   *
   * @param runId - The run's UUID.
   * @returns The {@link RunSubmissionResponse} for the run. Correlation counts are
   *   zeroed here — they are only meaningful on the original {@link SubmissionClient.submit}.
   * @throws {NotFoundError} If no run exists with that id.
   * @throws {SdkApiError} For transport/auth failures from the underlying OpsClient.
   */
  async getRun(runId: string): Promise<RunSubmissionResponse> {
    const run = await this.ops.runs.get(runId);
    return {
      runId: run.id,
      runNumber: run.runNumber,
      projectId: run.projectId,
      dashboardUrl: this.buildDashboardUrl(run),
      allGatesPassed: run.allGatesPassed,
      averageScore: run.averageScore ?? null, // preserve null on read
      correlation: { newIssues: 0, recurringIssues: 0, regressions: 0 },
      deduplicated: false,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build the dashboard URL for a saved run.
   *
   * Canonical path is `/orgs/<orgSlug>/<projectSlug>/runs/<runId>` — there is
   * no top-level `/runs/<id>` route on the dashboard. We need both slugs from
   * the API response to construct a working link. When either is missing
   * (older API that predates the slug fields), fall back to the run-id-only
   * path; it will 404, but that's strictly better than printing an invented
   * URL that silently misroutes.
   */
  private buildDashboardUrl(run: { id: string; projectSlug?: string; orgSlug?: string | null }): string {
    if (run.projectSlug && run.orgSlug) {
      return `${this.config.dashboardUrl}/orgs/${run.orgSlug}/${run.projectSlug}/runs/${run.id}`;
    }
    return `${this.config.dashboardUrl}/runs/${run.id}`;
  }

  /**
   * Determine if a decision is positive using decisionCategory (agents) or raw string fallback.
   * Resolves Aporia A3: cognitive lens agents with non-PASS positive decisions
   * (EXAMINED, VITAL, FLOWING, etc.) now correctly report allGatesPassed: true.
   *
   * A low-confidence extraction (regex-parsed prose, confidence < the trust
   * threshold) is not trustworthy enough to pass a gate even when a positive
   * decision string was parsed. The decision is preserved on the result for
   * analytics/reporting; gating simply refuses to treat it as a pass. This
   * scopes to agent results only — `extractionConfidence` is absent on command/
   * workflow ExecutionResults, so their gating is unchanged.
   */
  private isPositiveDecision(result: ExecutionResult | AgentResult): boolean {
    if (
      'extractionConfidence' in result &&
      result.extractionConfidence !== undefined &&
      result.extractionConfidence < EXTRACTION_CONFIDENCE_THRESHOLD
    ) {
      return false;
    }
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

    // Workflow/pipeline results: decompose phases/stages into per-agent entries
    const agents = this.isWorkflowResult(result)
      ? this.extractWorkflowAgents(result)
      : this.isPipelineResult(result)
        ? this.extractPipelineAgents(result)
        : [this.resultToAgent(result)];

    // Extract analysis summary and records from agent results
    let analysisSummary: AnalysisSummaryInput | undefined;
    let analysisRecords: AnalysisRecordInput[] | undefined;

    if (submission.resolvedDefinition) {
      if (this.isAgentResult(result)) {
        const analysis = this.analysisExtractor.extract(result as AgentResult, submission.resolvedDefinition);
        analysisSummary = analysis.summary;
        analysisRecords = analysis.records.length > 0 ? analysis.records : undefined;
      } else if (this.isPipelineResult(result)) {
        // Extract analysis from each preserved AgentResult across pipeline stages
        const allRecords: AnalysisRecordInput[] = [];
        for (const stage of (result as PipelineResult).stages) {
          if (stage.agentResults) {
            for (const agent of stage.agentResults) {
              const analysis = this.analysisExtractor.extract(agent, submission.resolvedDefinition);
              if (analysis.records.length > 0) allRecords.push(...analysis.records);
              // Use the first agent's summary as the run-level summary
              if (!analysisSummary && analysis.summary) analysisSummary = analysis.summary;
            }
          }
        }
        if (allRecords.length > 0) analysisRecords = allRecords;
      }
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
        // OMIT when scoreless — the tracker computes the average over scored agents
        // or stores null. Never fabricate 0. (score-nullability spec, averageScore decision.)
        ...(result.score != null ? { averageScore: result.score } : {}),
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
   * Extract agent name+version pairs from a result for per-agent execution recording.
   * Reuses the same decomposition logic used for tracker submission.
   *
   * @internal Used by `UluOpsClient.recordExecutions()`. Not part of the stable
   * public API — no semver guarantee; do not depend on it directly.
   */
  extractAgents(result: ExecutionResult | AgentResult): Array<{ name: string; version?: string }> {
    const entries = this.isWorkflowResult(result)
      ? this.extractWorkflowAgents(result)
      : this.isPipelineResult(result)
        ? this.extractPipelineAgents(result)
        : [this.resultToAgent(result)];
    return entries.map(a => ({ name: a.name, version: a.definitionVersion }));
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
   * Check if a result is a PipelineResult with decomposable stages.
   */
  private isPipelineResult(result: ExecutionResult | AgentResult): result is PipelineResult {
    return result.type === 'pipeline' && 'stages' in result && Array.isArray((result as PipelineResult).stages);
  }

  /**
   * Extract individual agent entries from pipeline stages.
   * Each stage contains a CommandResult or WorkflowResult — decompose into agent entries.
   */
  private extractPipelineAgents(result: PipelineResult): ReturnType<typeof this.resultToAgent>[] {
    const agents: ReturnType<typeof this.resultToAgent>[] = [];

    for (const stage of result.stages) {
      if (stage.status === 'skipped' || !stage.result) continue;

      // Prefer preserved individual agent results (inline-agent stages)
      if (stage.agentResults && stage.agentResults.length > 0) {
        for (const agent of stage.agentResults) {
          agents.push(this.resultToAgent(agent));
        }
        continue;
      }

      // Fall back to stage-level decomposition
      if (stage.type === 'workflow' && this.isWorkflowResult(stage.result as WorkflowResult)) {
        agents.push(...this.extractWorkflowAgents(stage.result as WorkflowResult));
      } else {
        agents.push(this.commandToAgent(stage.result as CommandResult));
      }
    }

    if (agents.length === 0) {
      agents.push(this.resultToAgent(result));
    }

    return agents;
  }

  /**
   * Convert a single ExecutionResult or AgentResult into an agent tracker entry.
   */
  private resultToAgent(result: ExecutionResult | AgentResult) {
    // Pair-resolution for the wire: score is null when scoreless (ops-sdk AgentInput.score
    // is number|null), and the scale is OMITTED (undefined) — AgentInput.maxScore is
    // number|undefined, and the tracker accepts an absent scale (column nullable). Never
    // fabricate maxScore: 100. ExecutionResult (base) carries no maxScore; AgentResult does.
    const score = result.score ?? null;
    const maxScore = score === null
      ? undefined
      : (('maxScore' in result ? result.maxScore : undefined) ?? 100);
    return {
      name: result.name,
      definitionVersion: result.version !== 'unknown' ? result.version : undefined,
      score,
      maxScore,
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
    const score = cmd.score ?? null;
    // Omit the scale on the wire when scoreless (see resultToAgent).
    const maxScore = score === null ? undefined : (cmd.maxScore ?? 100);
    return {
      name: cmd.name,
      definitionVersion: cmd.version !== 'unknown' ? cmd.version : undefined,
      score,
      maxScore,
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
      // Local response is a read-type (RunSubmissionResponse) — preserve null, don't omit
      // (only the wire payload to the tracker omits). No fabricated 0.
      averageScore: submission.result.score ?? null,
      correlation: {
        newIssues: submission.result.recommendations.length,
        recurringIssues: 0,
        regressions: 0,
      },
      deduplicated: false,
    };
  }
}
