import type { AgentExecutor } from './AgentExecutor.js';
import type { CommandExecutor } from './CommandExecutor.js';
import type { WorkflowExecutor } from './WorkflowExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { PipelineDefinition, StageDefinition, PipelineResult, StageResult, StepResult, PipelineState, PipelineHandle as IPipelineHandle } from '../types/pipeline.js';
import { StepsExecutor } from './StepsExecutor.js';
import type { ExecutionInput, ExecutionOptions } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import { PipelineError } from '../errors/index.js';
import { parseRef } from '../utils/parseRef.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { classifyDecision } from './classifyDecision.js';
import { aggregateScores } from '../utils/aggregateScores.js';
import type { Logger } from '@uluops/sdk-core';

/**
 * Executes pipelines with multi-stage orchestration and async support.
 *
 * Handles stage dependency resolution, conditional execution,
 * mix of workflow and command stages, and state tracking.
 */
export class PipelineExecutor {
  private stepsExecutor: StepsExecutor;

  constructor(
    private workflowExecutor: WorkflowExecutor,
    private commandExecutor: CommandExecutor,
    private agentExecutor: AgentExecutor,
    private registry: RegistryClient,
    private logger: Logger,
    /** Config-level opt-in for executing PDL stage steps (host shell access).
     *  Per-run ExecutionOptions.allowStageSteps overrides. Default false. */
    private allowStageSteps: boolean = false,
  ) {
    this.stepsExecutor = new StepsExecutor(logger);
  }

  /**
   * Start pipeline execution asynchronously.
   *
   * Launches stage execution in the background and returns immediately. Errors
   * during background execution are captured into the handle's state rather than
   * thrown here; await {@link PipelineHandle.wait} to surface the final result.
   *
   * @param resolved - Registry-resolved pipeline definition (must have `type: 'pipeline'`).
   * @param input - Execution input; `target` is the absolute project path.
   * @param options - Optional execution overrides (`timeoutMs`, `model`).
   * @returns A {@link PipelineHandle} for polling status, waiting, and cancellation.
   * @throws {PipelineError} If the resolved definition is not a pipeline.
   */
  async start(resolved: ResolvedDefinition, input: ExecutionInput, options?: ExecutionOptions): Promise<PipelineHandle> {
    const def = this.assertPipelineDefinition(resolved);
    const pipelineId = `pipeline_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;

    const state: PipelineState = {
      pipelineId,
      definitionName: def.pipeline.interface.name,
      definitionVersion: def.pipeline.interface.version,
      definitionHash: resolved.hash,
      minSubscription: resolved.minSubscription,
      status: 'running',
      currentStageIndex: 0,
      stageResults: [],
      startTime: Date.now(),
    };

    // Start execution in background, capturing errors into state
    const execution = this.executeAsync(resolved, input, state, options);
    execution.catch((error) => {
      if (state.status === 'running') {
        state.status = 'failed';
        state.error = formatErrorMessage(error);
      }
    });

    return new PipelineHandle(pipelineId, state, execution);
  }

  /**
   * Execute a pipeline synchronously (blocking).
   *
   * Convenience wrapper that {@link PipelineExecutor.start}s the pipeline and
   * awaits completion.
   *
   * @param resolved - Registry-resolved pipeline definition (must have `type: 'pipeline'`).
   * @param input - Execution input; `target` is the absolute project path.
   * @param options - Optional execution overrides (`timeoutMs`, `model`).
   * @returns The final {@link PipelineResult} with per-stage results and aggregate metrics.
   * @throws {PipelineError} If the resolved definition is not a pipeline, or a stage fails.
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput, options?: ExecutionOptions): Promise<PipelineResult> {
    const handle = await this.start(resolved, input, options);
    return handle.wait();
  }

  private async executeAsync(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    state: PipelineState,
    options?: ExecutionOptions,
  ): Promise<void> {
    const def = this.assertPipelineDefinition(resolved);

    try {
      for (let i = 0; i < def.pipeline.stages.length; i++) {
        if (state.status === 'cancelled') break;

        const stage = def.pipeline.stages[i];
        if (!stage) break;
        state.currentStageIndex = i;

        // Check dependencies
        if (!this.checkStageDependencies(stage.depends_on, state.stageResults)) {
          state.stageResults.push(this.createSkippedStage(stage, 'dependencies_not_met'));
          continue;
        }

        // Evaluate execution condition (condition takes precedence over deprecated skip_if)
        const skipCondition = stage.condition ?? stage.skip_if;
        if (skipCondition && this.evaluateCondition(skipCondition, state.stageResults)) {
          state.stageResults.push(this.createSkippedStage(stage, 'condition_met'));
          continue;
        }

        // Execute stage
        const stageResult = await this.executeStage(stage, input, options);
        state.stageResults.push(stageResult);
      }

      if (state.status === 'running') {
        state.status = 'completed';
      }
    } catch (error) {
      state.status = 'failed';
      state.error = formatErrorMessage(error);
    }
  }

  private assertPipelineDefinition(resolved: ResolvedDefinition): PipelineDefinition {
    if (resolved.type !== 'pipeline') {
      throw new PipelineError(
        `PipelineExecutor received a '${resolved.type}' definition (expected 'pipeline')`,
        {},
      );
    }
    return resolved.definition as PipelineDefinition;
  }

  private async executeStage(stage: StageDefinition, input: ExecutionInput, options?: ExecutionOptions): Promise<StageResult> {
    const startTime = Date.now();

    try {
      // Inline agents — PDL stages with agents[] run each agent directly in parallel
      if (stage.type === 'agents' && stage.agents) {
        const agentResults = await this.executeInlineAgents(stage.agents, input, options);
        // Exclude crashed agents (decision=FAIL, score=0) from average to prevent
        // one crash from poisoning the entire stage score (e.g., 1 pass at 90 + 2 crashes → 30).
        const successResults = agentResults.filter(r => r.decision !== 'FAIL' || (r.score ?? 0) > 0);
        const avgScore = aggregateScores(
          successResults.map(r => ({ key: r.name, score: r.score ?? null })),
        );

        const stageEnd = Date.now() - startTime;

        // Aggregating AgentResult → CommandResult conversion for pipeline stages.
        // See CommandExecutor.wrapAgentResult for divergence rationale across all three sites.
        return {
          id: stage.id,
          name: stage.name,
          type: 'command' as const,
          status: 'completed',
          result: {
            type: 'command',
            name: stage.name,
            version: '1.0.0',
            definitionHash: '',
            agentType: 'analyst',
            decision: agentResults.every(r => r.decision !== 'FAIL') ? 'PASS' : 'FAIL',
            // KEEP: avgScore is a real average over child agents; maxScore 100 is its scale,
            // not a fabrication. (Caveat: aggregateScores floors an all-null-scoring stage to
            // 0 — a residual fabricated zero routed to composition-aggregation-spec, not fixed here.)
            score: avgScore,
            maxScore: 100,
            recommendations: agentResults.flatMap(r => r.recommendations),
            durationMs: stageEnd,
            metrics: {
              ...sumTokenMetrics(agentResults.map(r => r.metrics)),
              durationMs: stageEnd,
              model: 'mixed',
              toolCalls: agentResults.reduce((sum, r) => sum + (r.metrics.toolCallCount ?? 0), 0),
            },
          },
          agentResults,
          durationMs: stageEnd,
        };
      }

      // Steps stages (PDL shell preflight / build gates).
      if (stage.type === 'steps' || (Array.isArray(stage.steps) && stage.steps.length > 0 && !stage.ref && !stage.agents)) {
        const allowSteps = options?.allowStageSteps ?? this.allowStageSteps;

        // Opt-in gate (spec D3): step commands come from resolved definitions,
        // so running them is host shell access. Without the opt-in, keep the
        // spec D2 interim posture — status:completed + decision:PASS so
        // depends_on:[preflight] chains keep flowing, but score:null so the
        // unexecuted stage is EXCLUDED from pipeline-level aggregation instead
        // of injecting a fabricated 100 (steps-block investigation, G1).
        if (!allowSteps || !stage.steps?.length) {
          this.logger.warn(`Stage "${stage.id}" has steps — allowStageSteps is off; passing through with null score`);
          return this.buildStepsStageResult(stage, 'PASS', undefined, startTime);
        }

        const stepResults = await this.stepsExecutor.execute(stage.steps, input);
        const failed = stepResults.some(s => s.status === 'failed' &&
          !stage.steps!.find(d => d.name === s.name)?.continue_on_error);
        return this.buildStepsStageResult(stage, failed ? 'FAIL' : 'PASS', stepResults, startTime);
      }

      // Stages with no content the engine can run (no ref, no agents, no steps —
      // e.g. multi-entry workflows:/commands: arrays): fail loud instead of
      // fabricating a PASS (pdl-steps-execution-spec D7). Single-entry workflows
      // arrays are hoisted to ref by normalizePipelineSection and never land here.
      if (!stage.ref && !stage.agents) {
        throw new PipelineError(
          `Stage "${stage.id}" has no executable content the engine supports ` +
          `(no ref, no agents, no steps). Multi-entry workflows/commands arrays ` +
          `are not executed — give the stage a stage-level ref.`,
          {},
        );
      }

      // Standard ref-based stages
      if (!stage.ref) {
        throw new PipelineError(
          `Stage "${stage.id}" has type "${stage.type}" but no ref. ` +
          `Non-inline stages must specify a ref (e.g., "agent-name@latest").`,
          {},
        );
      }
      const [refName, refVersion] = parseRef(stage.ref);
      const resolved = await this.registry.resolve(refName, refVersion, stage.type as 'command' | 'workflow');

      if (stage.type === 'workflow') {
        const result = await this.workflowExecutor.execute(resolved, input);
        return {
          id: stage.id,
          name: stage.name,
          type: 'workflow',
          status: 'completed',
          result,
          durationMs: Date.now() - startTime,
        };
      }

      const result = await this.commandExecutor.execute(resolved, input);
      return {
        id: stage.id,
        name: stage.name,
        type: 'command',
        status: 'completed',
        result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        id: stage.id,
        name: stage.name,
        // StageResult.type is 'workflow' | 'command'; agents and steps stages
        // (and untyped no-content stages) map to 'command' (agents precedent).
        type: stage.type === 'workflow' ? 'workflow' : 'command',
        status: 'failed',
        skipReason: formatErrorMessage(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute inline agent refs in parallel, resolving each from the registry.
   */
  private async executeInlineAgents(
    agents: Array<{ ref: string }>,
    input: ExecutionInput,
    options?: ExecutionOptions,
  ): Promise<AgentResult[]> {
    const settled = await Promise.allSettled(
      agents.map(async (a) => {
        const [name, version] = parseRef(a.ref);
        const resolved = await this.registry.resolve(name, version, 'agent');
        return this.agentExecutor.execute(resolved, input, options);
      }),
    );

    const results: AgentResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        // Surface rejected inline agents as failed results instead of silently dropping them
        const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        results.push({
          name: agents[i]?.ref ?? 'unknown',
          agentType: 'validator',
          decision: 'FAIL',
          // Crashed inline agent — no agent ran, so no score. Null pair, not fabricated 0/100.
          score: null,
          maxScore: null,
          recommendations: [{
            title: `Inline agent failed: ${agents[i]?.ref ?? 'unknown'}`,
            description: errorMsg,
            severity: 'high',
            failureCode: 'PRA-FRA/H',
          }],
          metrics: { inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 0, model: 'unknown' },
        } as AgentResult);
      }
    }
    return results;
  }

  private checkStageDependencies(deps: string[] | undefined, results: StageResult[]): boolean {
    if (!deps || deps.length === 0) return true;
    return deps.every(dep =>
      results.some(r => r.id === dep && r.status === 'completed'),
    );
  }

  /**
   * Safe condition evaluator for stage conditions.
   * Supports: "stage.field op value" expressions
   */
  private evaluateCondition(condition: string, results: StageResult[]): boolean {
    const context = Object.fromEntries(results.map(r => [r.id, r.result]));

    const match = condition.match(
      /^([\w-]+)\.([\w]+)\s*(==|!=|>=|<=|>|<)\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))$/,
    );

    if (!match) {
      // Unrecognized condition format — return false (don't skip) but surface
      // a recommendation so operators notice typos in condition expressions.
      this.logger.warn(`Unrecognized condition: "${condition}" — stage will not be skipped`);
      return false;
    }

    const [, stageId, field, op, strVal1, strVal2, numVal] = match;
    const stageResult = stageId ? context[stageId] : undefined;
    if (!stageResult || typeof stageResult !== 'object') return false;

    const actual = this.getField(stageResult, field!);
    const expected = numVal !== undefined ? Number(numVal) : (strVal1 ?? strVal2);

    switch (op) {
      case '==': return String(actual) === String(expected);
      case '!=': return String(actual) !== String(expected);
      case '>=': return Number(actual) >= Number(expected);
      case '<=': return Number(actual) <= Number(expected);
      case '>':  return Number(actual) > Number(expected);
      case '<':  return Number(actual) < Number(expected);
      default:   return false;
    }
  }

  /** Safely access a field on an object via runtime narrowing (avoids double assertion). */
  private getField(obj: object, field: string): unknown {
    return field in obj ? (obj as Record<string, unknown>)[field] : undefined;
  }

  /**
   * StageResult for a steps stage — executed (stepResults present, decision
   * derived from step outcomes) or passed through under the D2 interim posture
   * (no stepResults, decision PASS). Score is null either way: steps verify
   * preconditions, they do not score (null iff null, score-nullability spec).
   */
  private buildStepsStageResult(
    stage: StageDefinition,
    decision: 'PASS' | 'FAIL',
    stepResults: StepResult[] | undefined,
    startTime: number,
  ): StageResult {
    const durationMs = Date.now() - startTime;
    return {
      id: stage.id,
      name: stage.name,
      type: 'command' as const,
      status: 'completed',
      ...(stepResults ? { steps: stepResults } : {}),
      result: {
        type: 'command',
        name: stage.name,
        version: '1.0.0',
        definitionHash: '',
        agentType: 'analyst',
        decision,
        score: null,
        maxScore: null,
        recommendations: [],
        durationMs,
        metrics: { durationMs, model: 'none', toolCalls: 0, inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0 },
      },
      durationMs,
    };
  }

  private createSkippedStage(stage: StageDefinition, reason: string): StageResult {
    return {
      id: stage.id,
      name: stage.name,
      // StageResult.type is 'workflow' | 'command'; agents/steps map to 'command'.
      type: stage.type === 'workflow' ? 'workflow' : 'command',
      status: 'skipped',
      skipReason: reason,
      durationMs: 0,
    };
  }
}

/**
 * Handle for monitoring and controlling an async pipeline execution
 */
class PipelineHandle implements IPipelineHandle {
  readonly executionId: string;
  private state: PipelineState;
  private execution: Promise<void>;

  constructor(executionId: string, state: PipelineState, execution: Promise<void>) {
    this.executionId = executionId;
    this.state = state;
    this.execution = execution;
  }

  async status(): Promise<PipelineResult> {
    return this.buildResult();
  }

  isComplete(): boolean {
    return this.state.status !== 'running' && this.state.status !== 'pending';
  }

  async wait(_pollIntervalMs?: number): Promise<PipelineResult> {
    // Await the actual execution promise instead of polling
    await this.execution;

    const result = this.buildResult();

    if (this.state.status === 'failed') {
      throw new PipelineError(
        `Pipeline ${this.executionId} failed: ${this.state.error ?? 'Unknown error'}`,
        { partialResult: result },
      );
    }

    return result;
  }

  async cancel(): Promise<void> {
    if (this.isComplete()) {
      throw new PipelineError(
        `Pipeline ${this.executionId} is already complete (status: ${this.state.status})`,
        {},
      );
    }
    this.state.status = 'cancelled';
    this.state.error = 'Pipeline cancelled by user';
  }

  private buildResult(): PipelineResult {
    const durationMs = Date.now() - this.state.startTime;

    const score = aggregateScores(
      this.state.stageResults.map(s => ({ key: s.id, score: s.result?.score ?? null })),
    );

    const recommendations = this.state.stageResults
      .flatMap(s => s.result?.recommendations ?? []);

    const decision = this.computeDecision();

    return {
      type: 'pipeline',
      name: this.state.definitionName,
      version: this.state.definitionVersion,
      definitionHash: this.state.definitionHash,
      minSubscription: this.state.minSubscription,
      decision,
      score,
      durationMs,
      status: mapPipelineStatus(this.state.status),
      stages: this.state.stageResults,
      recommendations,
      metrics: {
        ...sumTokenMetrics(
          this.state.stageResults
            .map(s => s.result?.metrics)
            .filter((m): m is NonNullable<typeof m> => m != null),
        ),
        durationMs,
        model: 'mixed',
        ...this.computeStageMetrics(),
      },
    };
  }

  /** Single-pass stage metric computation (replaces five separate filter calls). */
  private computeStageMetrics() {
    let stagesExecuted = 0;
    let stagesPassed = 0;
    let stagesFailed = 0;
    let stagesWarned = 0;
    let stagesSkipped = 0;

    for (const s of this.state.stageResults) {
      if (s.status === 'skipped') { stagesSkipped++; continue; }
      stagesExecuted++;
      // Thrown-error stages have status='failed' but no result — count as failed
      if (s.status === 'failed') { stagesFailed++; continue; }
      const category = classifyDecision(s.result?.decision);
      if (category === 'positive') stagesPassed++;
      else if (category === 'negative') stagesFailed++;
      else if (category === 'conditional') stagesWarned++;
    }

    return { stagesExecuted, stagesPassed, stagesFailed, stagesWarned, stagesSkipped };
  }

  private computeDecision(): string {
    if (this.state.status === 'cancelled') return 'CANCELLED';
    if (this.state.status === 'failed') return 'FAIL';

    // Thrown-error stages have status='failed' but no result.decision
    const hasFailures = this.state.stageResults.some(s =>
      s.status === 'failed' || classifyDecision(s.result?.decision) === 'negative',
    );
    if (hasFailures) return 'FAIL';

    const hasWarnings = this.state.stageResults.some(s =>
      classifyDecision(s.result?.decision) === 'conditional',
    );
    if (hasWarnings) return 'WARN';

    return 'PASS';
  }
}

/** Map internal PipelineState status to PipelineResult status (completed → complete).
 *
 * NAMING (2026-04-16): PipelineState uses 'completed' (past-tense, internal) while
 * PipelineResult uses 'complete' (adjective, public contract). This inconsistency
 * is cosmetic — the mapping is exhaustive and type-checked. Unifying would require
 * changing either the internal state machine or the public result contract, both of
 * which have downstream consumers. */
function mapPipelineStatus(status: PipelineState['status']): PipelineResult['status'] {
  switch (status) {
    case 'completed': return 'complete';
    case 'pending': return 'pending';
    case 'running': return 'running';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
  }
}
