import type { AgentExecutor } from './AgentExecutor.js';
import type { CommandExecutor } from './CommandExecutor.js';
import type { WorkflowExecutor } from './WorkflowExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { PipelineDefinition, StageDefinition, GateDefinition, PipelineResult, StageResult, StepResult, PipelineState, PipelineHandle as IPipelineHandle } from '../types/pipeline.js';
import { StepsExecutor } from './StepsExecutor.js';
import { evaluateConditionExpr } from './conditions.js';
import { buildUpstreamContext } from './upstreamContext.js';
import type { ExecutionInput, ExecutionOptions, UpstreamStageContext } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import { PipelineError } from '../errors/index.js';
import { parseRef } from '../utils/parseRef.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { resolveDecisionCategory } from './classifyDecision.js';
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

  /** Gate-boundary tripwire for unclassifiable decisions — see CommandExecutor.warnUnclassified (issue 3e74bc69). */
  private warnUnclassified = (decision: string): void => {
    this.logger.warn(
      `Decision "${decision.slice(0, 80)}" has no stamped decisionCategory and is not in the core register — ` +
      `resolving 'neutral' (non-gating). A custom-vocabulary negative from a pre-0.30 producer would not gate here.`,
    );
  };

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

        // Evaluate execution condition. SEMANTICS (Phase 3, spec D5):
        // `condition` is a RUN-gate per the PDL spec — the stage runs when it
        // holds and is skipped when it is definitively false. This flips the
        // engine's pre-Phase-3 skip-if reading, which never actually fired for
        // any corpus condition (the old grammar could not parse them).
        // `skip_if` (deprecated) keeps skip-if-true semantics. Unknown verdicts
        // (unresolvable path / unparseable expression) FAIL OPEN: run + warn.
        const conditionCtx = { stages: state.stageResults, params: input.params };
        if (stage.condition) {
          const verdict = evaluateConditionExpr(stage.condition, conditionCtx);
          if (verdict === false) {
            state.stageResults.push(this.createSkippedStage(stage, 'condition_not_met'));
            continue;
          }
          if (verdict === null) {
            this.logger.warn(`Condition "${stage.condition}" on stage "${stage.id}" could not be resolved — running stage (fail-open)`);
          }
        } else if (stage.skip_if) {
          const verdict = evaluateConditionExpr(stage.skip_if, conditionCtx);
          if (verdict === true) {
            state.stageResults.push(this.createSkippedStage(stage, 'condition_met'));
            continue;
          }
          if (verdict === null) {
            this.logger.warn(`skip_if "${stage.skip_if}" on stage "${stage.id}" could not be resolved — running stage (fail-open)`);
          }
        }

        // Hard gates must not silently pass unexecuted (G5): a steps stage
        // whose gate resolves to on_failure:abort verifies nothing when
        // allowStageSteps is off. That is a configuration error — the author
        // declared the gate mandatory, the operator cannot run it — so fail
        // the run loudly with the remedy instead of stamping PASS.
        if (
          isStepsStage(stage) &&
          stage.gate &&
          resolveOnFailure(stage.gate) === 'abort' &&
          !(options?.allowStageSteps ?? this.allowStageSteps)
        ) {
          throw new PipelineError(
            `Stage "${stage.id}" is a hard gate (gate.on_failure: abort) but its steps ` +
            `cannot run — allowStageSteps is disabled. Enable it (config.allowStageSteps, ` +
            `ULUOPS_ALLOW_STAGE_STEPS=true, or per-run options.allowStageSteps) or ` +
            `downgrade the gate to on_failure: warn.`,
            {},
          );
        }

        // Execute stage. Upstream forwarding (stage-output-forwarding spec §3.4):
        // slices of depends_on results, built per-stage, honoring forward/receives
        // opt-outs and the kill switch. Empty for non-dependent stages.
        const upstreamContext = buildUpstreamContext(
          stage,
          def.pipeline.stages,
          state.stageResults,
          (msg) => this.logger.debug(msg),
        );
        const stageResult = await this.executeStage(stage, input, options, state.stageResults, upstreamContext);
        state.stageResults.push(stageResult);

        // Enact the stage gate (PDL $defs/gate). Until now gates were parsed
        // but never read — on_failure:abort flowed on like warn (G5).
        const flow = this.applyGate(stage, stageResult);
        if (flow === 'abort') {
          this.skipRemaining(def.pipeline.stages, i + 1, state, 'gate_abort');
          state.error = `Stage "${stage.id}" failed its gate (on_failure: abort)`;
          state.status = 'failed';
          break;
        }
        if (flow === 'skip' || flow === 'skip_remaining') {
          this.skipRemaining(
            def.pipeline.stages, i + 1, state,
            flow === 'skip' ? 'gate_skip' : 'gate_early_exit',
          );
          break;
        }
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

  private async executeStage(stage: StageDefinition, input: ExecutionInput, options?: ExecutionOptions, priorResults: StageResult[] = [], upstreamContext: UpstreamStageContext[] = []): Promise<StageResult> {
    const startTime = Date.now();

    try {
      // Inline agents — PDL stages with agents[] run each agent directly in parallel.
      // Upstream context rides a per-stage shallow CLONE — never set on the shared
      // `input` reference (in-place mutation leaks context across stages and races
      // parallel agents; stage-output-forwarding spec §3.4, pre-impl run #31 A6).
      // Ref-based stages below deliberately receive the original input: forwarding
      // INTO command/workflow executions is the workflow-twin phase (spec §3.6).
      if (stage.type === 'agents' && stage.agents) {
        const agentInput = upstreamContext.length > 0 ? { ...input, upstreamContext } : input;
        const agentResults = await this.executeInlineAgents(stage.agents, agentInput, options, priorResults);
        // Exclude crashed agents (decision=FAIL, score=0) from average to prevent
        // one crash from poisoning the entire stage score (e.g., 1 pass at 90 + 2 crashes → 30).
        // Literal 'FAIL' is intentional here: it is the crash signature stamped by
        // executeInlineAgents' rejection path, not a gating check — a lens agent's
        // custom negative (EXPOSED) with a real score stays in the average.
        const successResults = agentResults.filter(r => r.decision !== 'FAIL' || (r.score ?? 0) > 0);
        const avgScore = aggregateScores(
          successResults.map(r => ({ key: r.name, score: r.score ?? null })),
        );
        // Gate on vocabulary-resolved categories, not raw strings: lens agents emit
        // custom negatives (EXPOSED, BEWITCHED) that a literal-'FAIL' test reads as
        // passing (tracker run #55, SEM-INC/H). AgentExecutor stamps decisionCategory
        // from the definition's vocabulary; crashed agents fall back via classifyDecision.
        const stageFailed = agentResults.some(r => resolveDecisionCategory(r) === 'negative');

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
            decision: stageFailed ? 'FAIL' : 'PASS',
            decisionCategory: stageFailed ? 'negative' as const : 'positive' as const,
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
      if (isStepsStage(stage)) {
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
    agents: Array<{ ref: string; condition?: string }>,
    input: ExecutionInput,
    options?: ExecutionOptions,
    priorResults: StageResult[] = [],
  ): Promise<AgentResult[]> {
    // Per-agent condition gate (Phase 3, spec D5): agents whose condition is
    // definitively false are not dispatched and not scored — no fabricated
    // result is recorded for them. Unknown verdicts fail open (run + warn),
    // matching stage-level semantics. Conditions read prior-stage results
    // (e.g. stages.preflight.steps['Detect TypeScript'].output) and params.
    const conditionCtx = { stages: priorResults, params: input.params };
    const dispatched = agents.filter((a) => {
      if (!a.condition) return true;
      const verdict = evaluateConditionExpr(a.condition, conditionCtx);
      if (verdict === false) {
        this.logger.info(`Skipping inline agent "${a.ref}" — condition not met: ${a.condition}`);
        return false;
      }
      if (verdict === null) {
        this.logger.warn(`Condition "${a.condition}" on inline agent "${a.ref}" could not be resolved — running agent (fail-open)`);
      }
      return true;
    });

    const settled = await Promise.allSettled(
      dispatched.map(async (a) => {
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
          name: dispatched[i]?.ref ?? 'unknown',
          agentType: 'validator',
          decision: 'FAIL',
          // Crashed inline agent — no agent ran, so no score. Null pair, not fabricated 0/100.
          score: null,
          maxScore: null,
          recommendations: [{
            title: `Inline agent failed: ${dispatched[i]?.ref ?? 'unknown'}`,
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
        decisionCategory: decision === 'FAIL' ? 'negative' as const : 'positive' as const,
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

  /**
   * Evaluate a completed stage against its gate and return the flow action.
   * 'continue' means no gate effect (no gate, gate passed, or on_failure:warn).
   */
  private applyGate(stage: StageDefinition, stageResult: StageResult): 'continue' | 'abort' | 'skip' | 'skip_remaining' {
    const gate = stage.gate;
    if (!gate) return 'continue';

    if (this.gateFailed(gate, stage, stageResult)) {
      const action = resolveOnFailure(gate);
      if (action === 'warn') {
        this.logger.warn(`Stage "${stage.id}" failed its gate — continuing (on_failure: warn)`);
        return 'continue';
      }
      return action;
    }

    if (gate.on_success === 'skip_remaining') return 'skip_remaining';
    return 'continue';
  }

  /**
   * A gate fails on stage error, vocabulary-resolved negative decision, or —
   * when `threshold` is set — an aggregated score below it. Scoreless stages
   * are fail-open for the threshold check (WorkflowExecutor.evaluateGate
   * precedent): steps stages score null by design and a missing score is a
   * scoring gap, not evidence of failure. Decision-negative still fails.
   */
  private gateFailed(gate: GateDefinition, stage: StageDefinition, stageResult: StageResult): boolean {
    if (stageResult.status === 'failed') return true;
    if (resolveDecisionCategory(stageResult.result, this.warnUnclassified) === 'negative') return true;

    if (gate.threshold !== undefined) {
      const score = this.gateScore(gate, stageResult);
      if (score === null) {
        this.logger.warn(`Gate threshold on stage "${stage.id}" is not evaluable (no scores) — passing (fail-open)`);
        return false;
      }
      return score < gate.threshold;
    }

    return false;
  }

  /**
   * The score a gate threshold evaluates: `gate.aggregate` (PDL default 'min')
   * over inline-agent scores when present — crashed/scoreless agents excluded,
   * matching the stage-average exclusion — else the stage result's own score.
   */
  private gateScore(gate: GateDefinition, stageResult: StageResult): number | null {
    const agentScores = (stageResult.agentResults ?? [])
      .map(r => r.score)
      .filter((s): s is number => s !== null && s !== undefined);
    if (agentScores.length > 0) {
      switch (gate.aggregate ?? 'min') {
        case 'min': return Math.min(...agentScores);
        case 'max': return Math.max(...agentScores);
        case 'average': return agentScores.reduce((a, b) => a + b, 0) / agentScores.length;
      }
    }
    return stageResult.result?.score ?? null;
  }

  /** Record every not-yet-run stage as skipped with the gate-flow reason, so
   *  the result accounts for all authored stages (nothing silently vanishes). */
  private skipRemaining(stages: StageDefinition[], from: number, state: PipelineState, reason: string): void {
    for (let j = from; j < stages.length; j++) {
      const s = stages[j];
      if (s) state.stageResults.push(this.createSkippedStage(s, reason));
    }
  }
}

/** Steps-stage predicate — explicit `type: 'steps'` (stamped by
 *  normalizePipelineSection) or the structural steps-only shape. */
function isStepsStage(stage: StageDefinition): boolean {
  return stage.type === 'steps' ||
    (Array.isArray(stage.steps) && stage.steps.length > 0 && !stage.ref && !stage.agents);
}

/** PDL schema default: a gate without on_failure is an abort gate. Corpus
 *  audit (2026-07-10, udl/pdl/v1): every stage gate declares on_failure
 *  explicitly, so the default activates nothing silently. */
function resolveOnFailure(gate: GateDefinition): 'abort' | 'warn' | 'skip' {
  return gate.on_failure ?? 'abort';
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
    // Pipeline decisions live in the core register, but stamp the category anyway
    // so the result is self-describing like every other ExecutionResult — and so
    // CANCELLED is deliberately 'neutral' rather than an accident of the
    // classifyDecision default branch.
    const decisionCategory =
      decision === 'PASS' ? 'positive' as const :
      decision === 'WARN' ? 'conditional' as const :
      decision === 'CANCELLED' ? 'neutral' as const :
      'negative' as const;

    return {
      type: 'pipeline',
      name: this.state.definitionName,
      version: this.state.definitionVersion,
      definitionHash: this.state.definitionHash,
      minSubscription: this.state.minSubscription,
      decision,
      decisionCategory,
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
      const category = resolveDecisionCategory(s.result);
      if (category === 'positive') stagesPassed++;
      else if (category === 'negative') stagesFailed++;
      else if (category === 'conditional') stagesWarned++;
    }

    return { stagesExecuted, stagesPassed, stagesFailed, stagesWarned, stagesSkipped };
  }

  private computeDecision(): string {
    if (this.state.status === 'cancelled') return 'CANCELLED';
    if (this.state.status === 'failed') return 'FAIL';

    // Thrown-error stages have status='failed' but no result.decision.
    // resolveDecisionCategory prefers the stage result's propagated decisionCategory
    // (vocabulary-resolved at the producing executor) over raw-string classification,
    // so custom-vocabulary negatives from command/workflow refs gate correctly.
    const hasFailures = this.state.stageResults.some(s =>
      s.status === 'failed' || resolveDecisionCategory(s.result) === 'negative',
    );
    if (hasFailures) return 'FAIL';

    const hasWarnings = this.state.stageResults.some(s =>
      resolveDecisionCategory(s.result) === 'conditional',
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
