import {
  OpsClient,
  FailureCodeSchema,
  FailureDomainSchema,
  SeveritySchema,
  PrioritySchema,
  type AnalysisSummaryInput,
  type AnalysisRecordInput,
  type RecommendationInput,
} from '@uluops/ops-sdk';
import type { Logger } from '@uluops/sdk-core';
import type { ResolvedConfig } from '../types/config.js';
import type { ExecutionResult, ExecutionMetrics } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineResult } from '../types/pipeline.js';
import type { CommandResult } from '../types/command.js';
import type { RunSubmission, RunSubmissionResponse, RunHistoryEntry, SubmissionQueryOptions } from '../types/submission.js';
import { AnalysisSummaryExtractor } from '../analysis/AnalysisSummaryExtractor.js';
import { EXTRACTION_CONFIDENCE_THRESHOLD } from '../constants.js';
import { isCanonicalMode } from '@uluops/taxonomy';

/**
 * Ceiling on `analysisRecords` in one `runs.save` payload. Mirrors
 * `analysisRecords: z.array(...).max(100)` in `@uluops/ops-sdk`'s
 * `SaveRunInputSchema` (dist/types/schemas.js). That cap is enforced
 * CLIENT-SIDE inside ops-sdk before any HTTP call — exceeding it throws a
 * ZodError that loses the entire run's analysis, not just the excess
 * records. Kept as a local constant (rather than importing from ops-sdk) so
 * the coupling is visible here and re-checked whenever the ops-sdk pin
 * moves, per the sanitizeRecommendation policy below: truncate and warn,
 * never let a ceiling become a submission-aborting throw.
 */
const MAX_ANALYSIS_RECORDS = 100;

/**
 * Ceiling on `agents` in one `runs.save` payload. Mirrors
 * `agents: z.array(AgentInputSchema).min(1).max(100)` in
 * `@uluops/ops-sdk`'s `SaveRunInputSchema`. Same rationale as
 * {@link MAX_ANALYSIS_RECORDS} — a workflow/pipeline with many phases/stages
 * can decompose into more than 100 per-agent entries with no ceiling on the
 * core side.
 */
const MAX_RUN_AGENTS = 100;

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

  constructor(private config: ResolvedConfig, private logger: Logger) {}

  /**
   * Repair one recommendation so it cannot abort the submission.
   *
   * WHY: `RecommendationInputSchema` validates CLIENT-SIDE inside ops-sdk, before any
   * HTTP call. One malformed field on one recommendation therefore throws a ZodError
   * that aborts the whole `runs.save` payload — every agent's recommendations and all
   * analysis records for that run. One agent's typo destroying nine other agents'
   * output is not an acceptable failure mode for a non-fatal tracking side-channel.
   *
   * POLICY, applied uniformly to every field:
   *  1. repair or omit only what the WIRE would reject, so a bad value can never abort
   *     the save;
   *  2. never drop a value the wire would have accepted — imperfect data beats none;
   *  3. warn on every repair, naming field and value, so nothing is lost silently.
   *
   * This replaces four different policies on four consecutive lines: `failureCode`
   * stripped silently, `failureDomain` and `severity` thrown (killing the save),
   * `failureMode` unvalidated. (tracker 07355df7, 271271d8)
   */
  private sanitizeRecommendation(
    r: ExecutionResult['recommendations'][number],
  ): { sanitized: RecommendationInput; repairs: string[] } {
    const repairs: string[] = [];

    const keepIfValid = <T>(
      schema: { safeParse(v: unknown): { success: boolean } },
      value: T | undefined,
      field: string,
    ): T | undefined => {
      if (value === undefined || value === null) return undefined;
      if (schema.safeParse(value).success) return value;
      repairs.push(`${field}=${JSON.stringify(value)} omitted (wire schema would reject it)`);
      return undefined;
    };

    const clamp = (value: string | undefined, max: number, field: string): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (value.length <= max) return value;
      repairs.push(`${field} truncated ${value.length}→${max} chars`);
      return value.slice(0, max);
    };

    // `priority` is REQUIRED on the wire, so an invalid value cannot be omitted — only
    // replaced. 'suggested' is the neutral middle of the vocabulary; coercing to
    // 'critical' or 'backlog' would editorialise someone's triage.
    let priority = r.priority;
    if (!PrioritySchema.safeParse(priority).success) {
      repairs.push(`priority=${JSON.stringify(priority)} coerced to 'suggested' (required field)`);
      priority = 'suggested' as typeof priority;
    }

    // The wire accepts any string ≤50 for failureMode, so an off-taxonomy value is NOT
    // dropped — rule 2. It is still worth saying out loud, because a mode that is not in the
    // taxonomy will not join against it downstream: `byMode` is built by iterating the
    // catalog, so a non-member vanishes from mode-level analytics entirely.
    //
    // **This used to test SHAPE while calling the result "off-taxonomy".** `/^[A-Z]{3}$/`
    // accepts `ZZZ`, `QQQ` and every other three-letter string, so the warning stayed silent
    // for precisely the values it named — and that shape is the mechanism by which 242
    // invented codes reached the datastore. It now checks MEMBERSHIP, which is what the
    // message always claimed.
    //
    // Safe to tighten here where it is not safe elsewhere: this only appends to `repairs` and
    // sends the value unchanged. Systems spec §7.3 defers membership because ENFORCING it
    // rejects data; nothing is rejected here.
    const failureMode = clamp(r.failureMode, 50, 'failureMode');
    if (failureMode !== undefined) {
      // Membership is only defined on the fully-qualified code — `INC` is both STR-INC and
      // SEM-INC — so qualify from the domain in the same payload. With no domain there is
      // nothing to decide against, and the shape check is the most that can be said.
      const domain = typeof r.failureDomain === 'string' ? r.failureDomain : undefined;
      const qualified = domain ? `${domain}-${failureMode}` : null;
      const offTaxonomy = qualified
        ? !isCanonicalMode(qualified)
        : !/^[A-Z]{3}$/.test(failureMode);
      if (offTaxonomy) {
        repairs.push(
          `failureMode=${JSON.stringify(failureMode)}${qualified ? ` (as ${qualified})` : ''} ` +
          `is off-taxonomy (sent as-is; the wire accepts any string ≤50)`,
        );
      }
    }

    const sanitized = {
      agent: clamp(r.agent, 100, 'agent') ?? 'unknown',
      // `title` is required and `min(1)` on the wire; an empty one would abort the save.
      title: clamp(r.title, 500, 'title') || '(untitled recommendation)',
      priority,
      severity: keepIfValid(SeveritySchema, r.severity, 'severity'),
      failureCode: keepIfValid(FailureCodeSchema, r.failureCode, 'failureCode'),
      failureDomain: keepIfValid(FailureDomainSchema, r.failureDomain, 'failureDomain'),
      failureMode,
      category: clamp(r.category, 100, 'category'),
      filePath: clamp(r.filePath, 1000, 'filePath'),
      lineNumber: r.lineNumber,
      description: clamp(r.description, 10_000, 'description'),
      classificationConfidence: r.classificationConfidence,
      classifiedBy: r.classifiedBy,
      secondaryFailureCodes: r.secondaryFailureCodes,
      taxonomyVersion: r.taxonomyVersion,
    };

    if (repairs.length > 0) {
      this.logger.warn(
        `Recommendation "${String(r.title ?? '(untitled)').slice(0, 80)}" from agent ` +
        `"${r.agent ?? 'unknown'}" was repaired before submission: ${repairs.join('; ')}`,
      );
    }

    return { sanitized, repairs };
  }

  /**
   * Cap an accumulated array at the wire's client-side ceiling, warning once
   * when truncation occurs. See {@link MAX_ANALYSIS_RECORDS} / {@link MAX_RUN_AGENTS}
   * for why this exists: the ops-sdk schema throws a ZodError past the cap,
   * which would lose the entire run's payload — truncating loses only the
   * tail, and the warning names exactly how much.
   */
  private capWithWarning<T>(items: T[], max: number, label: string): T[] {
    if (items.length <= max) return items;
    this.logger.warn(
      `Submission produced ${items.length} ${label}, exceeding the wire limit of ${max}; ` +
      `dropping the last ${items.length - max} (mirrors the @uluops/ops-sdk client-side schema cap).`,
    );
    return items.slice(0, max);
  }

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
        // EXTERNAL-OK: an HTTP/SDK timeout handed straight to a client that validates its own options; it reaches
    // no arithmetic and no threshold in this package.
        timeout: this.config.timeout,
        onSecurityEvent: this.config.onSecurityEvent,
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

    const { input, repairedRecommendations } = this.transformToOpsInput(submission);
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
      repairedRecommendations,
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
    const { input } = this.transformToOpsInput({ project, workflowType, result });
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
   * analytics/reporting; gating simply refuses to treat it as a pass. Since
   * issue e037aa98, composite results (command/workflow/pipeline) carry the
   * WORST child's extractionConfidence, so this gate covers composites too —
   * a phase whose agent parsed PASS at confidence 0.4 no longer launders to
   * allGatesPassed through aggregation.
   *
   * POLARITY (deliberate asymmetry with executor gating): executor gates fail
   * OPEN on ambiguity — a result must resolve 'negative' to block, so an
   * unclassifiable decision does not halt a pipeline. This gate fails CLOSED —
   * a result must affirmatively resolve 'positive' (or literal PASS/SHIP when
   * unstamped) to report allGatesPassed. Blocking wants evidence of failure;
   * asserting success wants evidence of success. An ambiguous result therefore
   * flows through stages but is never reported as a pass.
   *
   * READ/WRITE asymmetry (since ops-sdk 5.10.0): the READ shape is
   * boolean | null (null = NOT_A_GATE, a run with no gate-bearing agents —
   * save-run-decision-semantics spec v0.2.1). This WRITE path deliberately
   * still asserts an explicit boolean verdict from the polarity classifier;
   * null is never a valid input value (spec D6). Whether the SDK submission
   * path should instead omit the verdict for lens-only runs (letting the API
   * infer NOT_A_GATE) is an open question deferred with Change 2.
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
   * Transform SDK RunSubmission to OpsClient SaveFeaturesListInput format.
   *
   * Also returns `repairedRecommendations` — the count of recommendations
   * `sanitizeRecommendation` had to repair (coerce/omit/truncate a field). The
   * per-recommendation warn at the bottom of `sanitizeRecommendation` names the
   * field/value detail; this is the run-level tally so a caller can read/threshold
   * on a number instead of grepping logs (tracker 97efa7e2).
   */
  private transformToOpsInput(submission: RunSubmission): {
    input: Parameters<OpsClient['runs']['save']>[0];
    repairedRecommendations: number;
  } {
    const { result } = submission;

    // Workflow/pipeline results: decompose phases/stages into per-agent entries.
    // extractWorkflowAgents / extractPipelineAgents each cap at MAX_RUN_AGENTS.
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
        analysisRecords = analysis.records.length > 0
          ? this.capWithWarning(analysis.records, MAX_ANALYSIS_RECORDS, 'analysis records')
          : undefined;
        for (const w of analysis.warnings ?? []) this.logger.warn(w);
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
              for (const w of analysis.warnings ?? []) this.logger.warn(w);
            }
          }
        }
        if (allRecords.length > 0) {
          analysisRecords = this.capWithWarning(allRecords, MAX_ANALYSIS_RECORDS, 'analysis records');
        }
      }
    }

    // sanitizeRecommendation returns { sanitized, repairs } per recommendation — take
    // .sanitized for the wire payload, tally .repairs.length for the run-level count.
    const sanitizedRecommendations = result.recommendations.map(r => this.sanitizeRecommendation(r));
    const repairedRecommendations = sanitizedRecommendations.filter(r => r.repairs.length > 0).length;
    if (repairedRecommendations > 0) {
      const distinctFields = new Set(
        sanitizedRecommendations.flatMap(r => r.repairs.map(msg => msg.split('=')[0]?.split(' ')[0])),
      ).size;
      this.logger.warn(
        `Submission repaired ${repairedRecommendations} of ${sanitizedRecommendations.length} ` +
        `recommendations before sending (${distinctFields} distinct fields).`,
      );
    }

    return {
      input: {
        project: submission.project,
        workflowType: submission.workflowType,
        idempotencyKey: submission.idempotencyKey,
        agents,
        recommendations: sanitizedRecommendations.map(r => r.sanitized),
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
      },
      repairedRecommendations,
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

    return this.capWithWarning(agents, MAX_RUN_AGENTS, 'agent entries (from workflow phases)');
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

    return this.capWithWarning(agents, MAX_RUN_AGENTS, 'agent entries (from pipeline stages)');
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
      definitionVersion: this.realVersion(result.version),
      score,
      maxScore,
      decision: result.decision,
      summary: 'summary' in result ? (result as AgentResult).summary : undefined,
      model: result.metrics.model,
      // The engine stamps harness: 'uluops-core' on every ExecutionMetrics and the wire
      // type declares AgentInput.harness — it was simply never forwarded, so every run
      // this package produced was indistinguishable on the wire from one produced by any
      // other harness. Asserted at the producer by a test that passed identically whether
      // this line existed or not.
      harness: result.metrics.harness,
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
      definitionVersion: this.realVersion(cmd.version),
      score,
      maxScore,
      decision: cmd.decision,
      summary: undefined as string | undefined,
      model: cmd.metrics.model,
      harness: cmd.metrics.harness,
      tokens: this.extractTokens(cmd.metrics),
      durationMs: cmd.metrics.durationMs,
    };
  }

  /**
   * Guard a version string against the engine's placeholder sentinels before it
   * reaches the wire as real definition identity.
   *
   * `'unknown'` marks a registry lookup that found nothing; `'1.0.0-synthesized'`
   * marks a PipelineExecutor/WorkflowExecutor result with no backing definition at
   * all (an aggregated stage, a steps-only stage, a step that crashed before its
   * definition resolved — see the version-field comments at those call sites).
   * Neither is real version data, so both are omitted rather than forwarded —
   * forwarding '1.0.0-synthesized' would be indistinguishable from a genuine
   * 1.0.0 release on the tracker. Deliberately does NOT also treat a bare
   * '1.0.0' as a placeholder: that IS a legitimate version for a real
   * definition, and suppressing it would drop genuine data.
   */
  private realVersion(v: string | undefined): string | undefined {
    return v && v !== 'unknown' && v !== '1.0.0-synthesized' ? v : undefined;
  }

  /**
   * Extract token metrics into the tracker's expected shape.
   *
   * `cachedInputTokens` and `reasoningOutputTokens` were being DROPPED here despite being
   * populated on `ExecutionMetrics` and declared on the wire type
   * (`ops-sdk` `TokenUsage`). An OpenAI reasoning run's entire reasoning pool therefore
   * never reached the tracker, and the cached-input pool the engine prices was invisible
   * to anything reading a run back.
   *
   * The omission also falsified a justification recorded elsewhere — that `costUsd` need
   * not be sent because it "is derivable from tokens + pricing". It is not derivable from
   * a token set with the cache-served pool removed. Same shape as the rest of this
   * release: a value computed correctly and then not carried across a boundary.
   */
  private extractTokens(metrics: ExecutionMetrics) {
    return {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheCreationTokens: metrics.cacheCreationTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cachedInputTokens: metrics.cachedInputTokens,
      reasoningOutputTokens: metrics.reasoningOutputTokens,
      thinkingTokens: metrics.thinkingTokens,
      totalEffectiveTokens: metrics.totalEffectiveTokens,
    };
  }

  /**
   * Create a local-only response when tracking is disabled
   */
  private createLocalResponse(submission: RunSubmission): RunSubmissionResponse {
    // No network call is made, but running the same sanitize pass here keeps
    // repairedRecommendations meaningful offline too — it's what WOULD be
    // repaired if this run were submitted (tracker 97efa7e2).
    const repairedRecommendations = submission.result.recommendations
      .filter(r => this.sanitizeRecommendation(r).repairs.length > 0).length;
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
      repairedRecommendations,
    };
  }
}
