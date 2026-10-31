import type { AgentExecutor } from './AgentExecutor.js';
import type { CommandExecutor } from './CommandExecutor.js';
import type { WorkflowExecutor } from './WorkflowExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { PipelineDefinition, StageDefinition, PipelineResult, StageResult, StepResult, PipelineState, PipelineWarning, ErroredReason, PipelineHandle as IPipelineHandle } from '../types/pipeline.js';
import { StepsExecutor } from './StepsExecutor.js';
import { nulParameter } from './stepTemplates.js';
import { evaluateCondition, E, type ConditionContext } from './conditions.js';
import { checkPipelineLoadRules, stagesReadingStepOutput, bindParameterDefaults } from './pipelineLoad.js';
import { unjudgeableCause, type UnjudgeableCause } from './agentVerdict.js';
import { agentsMissingVocabulary, vocabularyMissingMessage } from './vocabularyPrecheck.js';
import { gateMode, isBlocking, isPerAgentMode, gateHasThreshold, judgeGate, judgedOutcome, type GatedMember } from './stageGate.js';
import { computeAllGatesPassed, runDecision, runDecisionCategory, stageMetrics } from './runVerdict.js';
import { buildUpstreamContext } from './upstreamContext.js';
import type { ExecutionInput, ExecutionOptions, UpstreamStageContext } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import { PipelineError } from '../errors/index.js';
import { parseRef } from '../utils/parseRef.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { rollupCost, type CostFields } from '../utils/costRollup.js';
import { resolveDecisionCategory } from './classifyDecision.js';
import { worstExtractionConfidence } from '../utils/worstExtractionConfidence.js';
import { aggregateScores } from '../utils/aggregateScores.js';
import { crashPlaceholder, abortedPlaceholder, toCommandRecord, withDeadlineMark, ABORTED_DECISION, CRASH_PLACEHOLDER_VERSION } from '../utils/crashPlaceholder.js';
import { isDeadlineSignal, rejectionKind } from '../utils/runStop.js';
import { stopVerdict, crashInside, containerMarkers, stopReached } from '../utils/stopVerdict.js';
import { verifiedNothingExecuted } from '../utils/executionEvidence.js';
import type { Logger } from '@uluops/sdk-core';
import { registerRunTrip, unregisterRunTrip } from '../utils/runTrip.js';

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
    this.refuseBeforeLaunch(def, input, options);
    await this.refuseMissingVocabulary(def);
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

    // The run's own cancellation source. Held here rather than on PipelineState because
    // PipelineState is a PUBLIC type — a controller on it would become part of the shape
    // consumers construct and serialize, and an AbortController does not survive either.
    //
    // Merged with any caller-supplied signal rather than replacing it: a consumer that
    // already passes its own abortSignal (a request that went away, a parent job) must
    // keep working, and `handle.cancel()` must also work on that same run.
    const controller = new AbortController();
    const runOptions: ExecutionOptions = {
      ...options,
      abortSignal: options?.abortSignal
        ? AbortSignal.any([controller.signal, options.abortSignal])
        : controller.signal,
    };

    // A provider 402 inside any stage stops the whole run (OpenRouter plan D13): AIProvider
    // looks up the signal it was handed in this module-internal registry. Same sequence as
    // handle.cancel(), but the run ends `failed`, not `cancelled` (plan v0.6.3, Alex
    // 2026-10-05): nobody chose to stop it, and `cancelled` made a credit outage read as a
    // quiet, neutral non-failure to CI, gates and alerting (1d crew #107). wait() therefore
    // throws a PipelineError whose message is the provider's text. A run that already
    // finished, failed or was cancelled is left alone, and the trip says so.
    const runSignal = runOptions.abortSignal!;
    registerRunTrip(runSignal, (reason) => {
      if (state.status !== 'running') return false;
      stopRun(state, controller, 'failed', reason, 'run stopped (provider credit)');
      return true;
    });

    // A caller-supplied signal stops the run, not just the provider calls (aborted-agent-recording
    // OD-7). Before, it aborted in-flight calls through the merged signal while `state.status`
    // stayed `running`: later stages were dispatched against an already-aborted signal and the run
    // ended `completed`. An explicit abort is the caller choosing to stop: same sequence and status
    // as handle.cancel(). A DEADLINE (AbortSignal.timeout — reason TimeoutError) is a timeout, not
    // a choice: the run ends `failed` and wait() throws, as for a credit trip (Alex 2026-10-05,
    // crew #110 P1). An already-aborted signal fires no event, so it is checked up front.
    const callerSignal = options?.abortSignal;
    const onCallerAbort = () => {
      if (state.status !== 'running') return;
      if (isDeadlineSignal(callerSignal)) {
        stopRun(state, controller, 'failed', "Pipeline deadline exceeded: the caller's abortSignal timed out", 'run stopped (deadline)');
      } else {
        stopRun(state, controller, 'cancelled', 'Pipeline cancelled by caller signal');
      }
    };
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    // Start execution in background, capturing errors into state
    const execution = this.executeAsync(resolved, input, state, runOptions);
    execution.catch((error) => {
      if (state.status === 'running') {
        state.status = 'failed';
        state.error = formatErrorMessage(error);
      }
    });
    // Both arms, not .finally(): a .finally() promise re-rejects and would be unhandled.
    const unregister = () => {
      unregisterRunTrip(runSignal);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    execution.then(unregister, unregister);

    return new PipelineHandle(pipelineId, state, execution, controller);
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
   * @throws {PipelineError} If the resolved definition is not a pipeline, the run is refused before
   *   launch (load errors, steps disabled, `PARAM_NUL`, `VOCABULARY_MISSING`), or it ends `failed` (a
   *   deadline, a credit stop, or its own execution threw). A gate failure, an abort included, does
   *   not throw: the result's `decision` is FAIL (PDL 1.6.0).
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
    // Conditions and steps read the run's parameters with declared defaults bound first (PDL 1.6.0,
    // condition context). Agents do not read parameters by name.
    const runInput: ExecutionInput = { ...input, params: bindParameterDefaults(def.pipeline, input.params, input.target) };
    state.params = runInput.params;
    state.warnings ??= [];
    // `stages.<id>.passed` for every stage that has ended: its outcome is PASSED.
    const passed = new Map<string, boolean>();
    const conditionCtx: ConditionContext = { params: runInput.params ?? {}, stages: state.stageResults, passed };
    // Stages that ended FAILED or ERRORED behind `abort`, and every stage skipped because of one:
    // their dependents are skipped (D1). Nothing else is.
    const aborted = new Set<string>();
    const end = (result: StageResult): void => {
      state.stageResults.push(result);
      passed.set(result.id, result.outcome === 'PASSED');
      if (result.gateMode === 'abort' && (result.outcome === 'FAILED' || result.outcome === 'ERRORED')) aborted.add(result.id);
    };

    try {
      for (let i = 0; i < def.pipeline.stages.length; i++) {
        if (stoppedNow(state)) {
          // Record what did not run. A bare `break` left un-run stages ABSENT from stageResults[],
          // so a 6-stage pipeline stopped at stage 2 reported `stagesSkipped: 0`, and a consumer
          // could not distinguish "cancelled at stage 2" from "had 2 stages".
          this.skipRemaining(def.pipeline.stages, i, state, stopLabel(state));
          break;
        }

        const stage = def.pipeline.stages[i];
        if (!stage) break;
        state.currentStageIndex = i;

        // Check dependencies
        if (!this.checkStageDependencies(stage, def.pipeline.stages, state.stageResults)) {
          end(this.createSkippedStage(stage, 'dependencies_not_met'));
          continue;
        }

        // A stage downstream, directly or transitively, of one that failed behind `abort` is
        // skipped; every other stage launches as usual (PDL 1.6.0 D1, revised 0.7.0). `abort` means
        // "the work downstream of this stage is pointless", not "halt the pipeline": halting is
        // what a stop does. Before 1.6.0 an abort skipped every remaining stage and failed the run.
        if ((stage.depends_on ?? []).some(dep => aborted.has(dep))) {
          end(this.createSkippedStage(stage, 'gate_abort'));
          aborted.add(stage.id);
          continue;
        }

        // The stage condition (PDL 1.6.0, the condition language): the stage runs when it is true
        // and is SKIPPED when it is false. Load validation (start()) has refused every condition
        // that does not parse or references what does not exist, so the value is total: true,
        // false, or E — a read of a step that did not pass. E makes the stage ERRORED
        // (`condition_error`), and it then takes its gate's mode like any ERRORED stage.
        // Before 1.6.0 a condition core could not read made the stage run (fail-open), and a
        // deprecated `skip_if` was evaluated beside it; `skip_if` is now an undeclared key (D25).
        if (stage.condition) {
          const value = evaluateCondition(stage.condition, conditionCtx);
          if (value === false) {
            end(this.createSkippedStage(stage, 'condition_not_met'));
            continue;
          }
          if (value === E) {
            end(this.createConditionErrorStage(stage, `its condition "${stage.condition}" read a step that did not pass`, state));
            continue;
          }
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
        const stageResult = this.judgeStage(stage, await this.executeStage(stage, runInput, options, conditionCtx, upstreamContext), state);
        end(stageResult);

        // A stop that landed while this stage ran has been recorded on it (ERRORED, `stopped`) when
        // it reached the stage's work; either way nothing more launches. The stage's own result is
        // already recorded above.
        //
        // Read through `stoppedNow()`: `cancel()` and a credit trip mutate `state.status` from ANOTHER
        // task while this one is awaiting, and TypeScript's control-flow analysis cannot
        // see that. It narrows `state.status` at the top-of-loop check above and then
        // reports a direct comparison here as having no overlap — a compile error for the
        // one case this guard exists to catch.
        if (stoppedNow(state)) {
          this.skipRemaining(def.pipeline.stages, i + 1, state, stopLabel(state));
          break;
        }

        // The early-exit pattern (`on_success: skip_remaining`): a passing gate ends the run here.
        if (stageResult.outcome === 'PASSED' && stage.gate?.on_success === 'skip_remaining') {
          this.skipRemaining(def.pipeline.stages, i + 1, state, 'gate_early_exit');
          break;
        }
      }

      if (state.status === 'running') {
        state.status = 'completed';
      }
    } catch (error) {
      // A cancel is NOT a failure. If the in-flight stage throws AFTER cancel() flipped the
      // flag — likely, since cancelling often interrupts work in progress — this catch used
      // to overwrite `cancelled` with `failed`, and wait() then THREW a PipelineError at a
      // user who had asked to stop. The user-initiated outcome wins over the fallout it
      // caused.
      // The same holds for a credit trip: the run is already `failed` with the provider's
      // text as its reason, and the stage's own throw is fallout that would replace it.
      if (state.status === 'running') {
        state.status = 'failed';
        state.error = formatErrorMessage(error);
      } else {
        this.logger.warn(`Stage threw after the run was stopped (keeping ${state.status}): ${formatErrorMessage(error)}`);
      }
    }
  }

  /**
   * PDL 1.6.0 checks that run before anything launches, in this order. Thrown from `start()`, before
   * any state exists, so the caller gets the codes and nothing ran.
   *
   * 1. **Load validation** (`pipelineLoad.ts`): every load error the spec names, with its location,
   *    on `context.loadErrors`. Load warnings (`SKIP_DEPRECATED`) are logged.
   * 2. **Steps disabled, step output read** (`STEP_OUTPUT_STEPS_DISABLED`): a condition that reads
   *    step output while steps are off would read input that cannot exist.
   * 3. **Steps disabled, hard-gated steps stage** (G5, no code): a steps stage behind an `abort`
   *    gate would verify nothing. Before 1.6.0 this was thrown when the stage loop reached the
   *    stage, after earlier stages had run and been paid for.
   * 4. **`PARAM_NUL`**: a parameter value, declared defaults included, holds NUL.
   *
   * The two steps-disabled refusals name the same remedy, enabling steps for the run, and say what
   * the global switch also enables. They do not suggest downgrading a gate to `warn`: that does not
   * make a condition's input exist, and it turns a check the author made mandatory into advice.
   */
  private refuseBeforeLaunch(def: PipelineDefinition, input: ExecutionInput, options?: ExecutionOptions): void {
    const { errors, warnings } = checkPipelineLoadRules(def.pipeline);
    if (errors.length > 0) {
      throw new PipelineError(
        `Pipeline "${def.pipeline.interface.name}" failed load validation: ` +
          errors.map(e => `${e.code} at ${e.at}: ${e.message}`).join('; '),
        { loadErrors: errors },
      );
    }
    for (const w of warnings) this.logger.warn(`${w.code} at stage:${w.stage}: ${w.message}`);

    if (!(options?.allowStageSteps ?? this.allowStageSteps)) {
      const remedy =
        'Enable steps for this run (per-run options.allowStageSteps, or config.allowStageSteps). ' +
        'The global ULUOPS_ALLOW_STAGE_STEPS=true also enables host-shell steps for every pipeline, ' +
        'registry-resolved ones included.';
      const readers = stagesReadingStepOutput(def.pipeline);
      if (readers.length > 0) {
        throw new PipelineError(
          `Run refused (STEP_OUTPUT_STEPS_DISABLED): the condition of ${readers.map(r => `"${r}"`).join(', ')} ` +
            `reads step output, and steps are disabled, so that output cannot exist. ${remedy}`,
          { refusal: { code: 'STEP_OUTPUT_STEPS_DISABLED', stages: readers } },
        );
      }
      // The blocking class (abort, fail, and skip as fail; PDL 1.6.0 §3.1). Before 1.6.0 only `abort`
      // was refused here, and `fail` did not exist. A stage with no gate is not refused: with steps
      // off it passes through, as before.
      const hardGated = def.pipeline.stages.filter(
        s => isStepsStage(s) && s.gate !== undefined && isBlocking(gateMode(s.gate)),
      );
      if (hardGated.length > 0) {
        throw new PipelineError(
          `Run refused: ${hardGated.map(s => `"${s.id}"`).join(', ')} is a blocking gate (gate.on_failure: abort or fail) ` +
            `over steps, and steps are disabled, so it would verify nothing. ${remedy}`,
          {},
        );
      }
    }

    const nul = nulParameter(bindParameterDefaults(def.pipeline, input.params, input.target));
    if (nul !== undefined) {
      throw new PipelineError(
        `Run refused (PARAM_NUL): the value of parameter "${nul}" contains NUL`,
        { refusal: { code: 'PARAM_NUL', param: nul } },
      );
    }
  }

  /**
   * The pre-launch vocabulary check (PDL 1.6.0 P4a, `vocabularyPrecheck.ts`), after the load and
   * steps checks above: it resolves each blocking-gated agent, so the checks that need no I/O go
   * first. `VOCABULARY_MISSING` names the agents.
   */
  private async refuseMissingVocabulary(def: PipelineDefinition): Promise<void> {
    const missing = await agentsMissingVocabulary(
      def.pipeline.stages,
      // EXTERNAL-OK: the resolved definition is read only for whether it declares a vocabulary or is
      // an explorer (vocabularyPrecheck.ts); no value from it reaches a numeric context.
      (ref) => { const [name, version] = parseRef(ref); return this.registry.resolve(name, version, 'agent'); },
      (ref, error) => this.logger.debug(`Vocabulary pre-check: "${ref}" did not resolve (${formatErrorMessage(error)}); dispatch will report it`),
    );
    if (missing.length > 0) {
      throw new PipelineError(vocabularyMissingMessage(missing), { refusal: { code: 'VOCABULARY_MISSING', agents: missing } });
    }
  }

  private assertPipelineDefinition(resolved: ResolvedDefinition): PipelineDefinition {
    if (resolved.type !== 'pipeline') {
      throw new PipelineError(
        `PipelineExecutor received a '${resolved.type}' definition (expected 'pipeline')`,
        {},
      );
    }
    // The runtime check above narrows the discriminated union — no cast (a9d65912).
    return resolved.definition;
  }

  /**
   * Dispatch a stage to its per-type executor (issue 2d5f3913 decomposition).
   * The shared failure envelope lives here: any throw from a type executor
   * becomes a status:'failed' StageResult rather than aborting the pipeline.
   */
  private async executeStage(stage: StageDefinition, input: ExecutionInput, options: ExecutionOptions | undefined, conditionCtx: ConditionContext, upstreamContext: UpstreamStageContext[] = []): Promise<StageResult> {
    const startTime = Date.now();

    try {
      if (stage.type === 'agents' && stage.agents) {
        return await this.executeAgentsStage(stage, input, options, conditionCtx, upstreamContext, startTime);
      }
      if (isStepsStage(stage)) {
        return await this.executeStepsStage(stage, input, options, startTime);
      }
      return await this.executeRefStage(stage, input, startTime, options);
    } catch (error) {
      // A ref stage whose single agent was stopped by a stop of this run rejects with
      // CancelledError (single-agent commands do not contain it). Recorded as a completed stage
      // holding an ABORTED record, like an inline-agents stage, not as a failed stage — a throw
      // here counted in stagesFailed and the agent vanished from submission (Alex 2026-10-05,
      // crew #110 F4).
      // Under a caller DEADLINE the same rejection is a crash (OD-9), and it is recorded the same
      // way — a completed stage holding the deadline-marked crash record — so the agent reaches
      // submission and the stage FAILs through its negative record (run #113 L1). A plain failed
      // stage dropped the record and the deadline mark with it.
      const kind = rejectionKind(error, options?.abortSignal);
      if (kind === 'stopped' || kind === 'deadline') {
        const ref = stage.ref ?? stage.id;
        const record = kind === 'stopped'
          ? abortedPlaceholder(ref, error, { startedAt: startTime })
          : withDeadlineMark(crashPlaceholder(ref, error, { startedAt: startTime }));
        return {
          id: stage.id,
          name: stage.name,
          type: stage.type === 'workflow' ? 'workflow' : 'command',
          status: 'completed',
          result: toCommandRecord(record),
          agentResults: [record],
          durationMs: Date.now() - startTime,
        };
      }
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
   * Inline agents — PDL stages with agents[] run each agent directly in parallel.
   * Upstream context rides a per-stage shallow CLONE — never set on the shared
   * `input` reference (in-place mutation leaks context across stages and races
   * parallel agents; stage-output-forwarding spec §3.4, pre-impl run #31 A6).
   * Ref-based stages deliberately receive the original input: forwarding INTO
   * command/workflow executions is the workflow-twin phase (spec §3.6).
   */
  private async executeAgentsStage(
    stage: StageDefinition,
    input: ExecutionInput,
    options: ExecutionOptions | undefined,
    conditionCtx: ConditionContext,
    upstreamContext: UpstreamStageContext[],
    startTime: number,
  ): Promise<StageResult> {
    const agentInput = upstreamContext.length > 0 ? { ...input, upstreamContext } : input;
    const { results: agentResults, conditionErrors, dispatched } = await this.executeInlineAgents(stage.agents!, agentInput, options, conditionCtx);
    const refs = dispatched.map(a => a.ref);

    // Every agent skipped by its own condition (D10): the stage is SKIPPED and its gate is not
    // evaluated. Before 1.6.0 the gate failed (`verifiedNothing`), which still applies to a stage
    // that dispatched nothing for any other reason (no agents authored).
    if (agentResults.length === 0 && conditionErrors.length === 0 && stage.agents!.length > 0) {
      this.logger.info(`Stage "${stage.id}" is SKIPPED: every agent's condition was false`);
      return { ...this.createSkippedStage(stage, 'condition_not_met'), agentResults: [] };
    }
    // Exclude unscored results from the average to prevent one crash from poisoning
    // the entire stage score (e.g., 1 pass at 90 + 2 crashes → 30).
    // Discriminate on score nullity, NOT on the decision string: 'FAIL' is core
    // validator vocabulary (sdk-core classifyDecision: PASS/WARN/FAIL) and is also the
    // fallback AgentExecutor stamps for a missing decision, so it is NOT a crash
    // signature. A crashed inline agent is stamped score: null by the rejection path
    // below, which is what actually distinguishes it — a legitimately-evaluated
    // {decision:'FAIL', score:0} is a real worst-case score and must stay in the average.
    // The exclusion happens INSIDE aggregateScores, which applies the identical null
    // guard. This site used to pre-filter as well; that was removed 2026-08-24, because
    // pre-filtering destroyed the distinction the util needs — an all-scoreless stage
    // arrived as an empty array, indistinguishable from a stage with no agents, and the
    // util floored it to a fabricated 0. Hand it the nulls and let it report `null`.
    // AVERAGE — and the gate does not use this number. `gateScore` applies
    // `gate.aggregate ?? 'min'` over the same agents, so a panel scoring 66 and 90 reports a
    // stage score of 78 here and fails a threshold-70 gate on 66. Both behaviours are
    // deliberate (the reported score describes the panel; the gate applies the authored
    // aggregate), and until now the divergence was documented at neither site — so a reader
    // explaining an abort saw 78 against a threshold of 70 and concluded the gate misfired.
    const avgScore = aggregateScores(
      agentResults.map(r => ({ key: r.name, score: r.score ?? null })),
    );
    // Gate on vocabulary-resolved categories, not raw strings: lens agents emit
    // custom negatives (EXPOSED, BEWITCHED) that a literal-'FAIL' test reads as
    // passing (tracker run #55, SEM-INC/H). AgentExecutor stamps decisionCategory
    // from the definition's vocabulary; crashed agents fall back via classifyDecision.
    const stageFailed = agentResults.some(r => resolveDecisionCategory(r) === 'negative');
    // "Crash decides" (utils/stopVerdict.ts, OD-12): once a stop reached any agent, the stage is
    // FAIL if anything inside really crashed, else ABORTED — a lens's own negative over a stopped
    // panel does not keep FAIL.
    const verdict = stopVerdict(agentResults);
    const stageNegative = verdict === undefined ? stageFailed : verdict === 'negative';
    const stageAborted = verdict === 'aborted';
    const markers = containerMarkers(verdict, agentResults.some(crashInside));

    const stageDurationMs = Date.now() - startTime;

    // Aggregating AgentResult → CommandResult conversion for pipeline stages.
    // See CommandExecutor.wrapAgentResult for divergence rationale across all three sites.
    // An agent whose condition was E is ERRORED, and an ERRORED agent makes its stage ERRORED
    // (PDL 1.6.0, Semantics); the agents that did run keep their records.
    // An unjudgeable agent (D24) makes its stage ERRORED too: no score and no classifiable
    // decision, or no score at a gate with a threshold. A crashed agent (a timeout included) left
    // no output to read, so it is unjudgeable; its crash record still reaches submission. A record a
    // stop left is not judged here: the stage is ERRORED `stopped` (judgeStage).
    // An absent decision at a blocking gate is unjudgeable whatever its score (D12).
    const judging = { hasThreshold: gateHasThreshold(stage), blocking: stage.gate !== undefined && isBlocking(gateMode(stage.gate)) };
    const causeText: Record<UnjudgeableCause | 'crashed', string> = {
      crashed: 'crashed',
      absent_at_blocking_gate: 'gave no decision at a blocking gate',
      no_score_at_threshold: 'gave no score at a gate with a threshold',
      no_score_no_decision: 'gave no score and no classifiable decision',
    };
    const unjudgeable = agentResults
      .map((r, idx) => ({ r, ref: refs[idx] ?? r.name }))
      .filter(({ r }) => !stopReached(r))
      .map(({ r, ref }) => ({
        ref,
        cause: r.version === CRASH_PLACEHOLDER_VERSION
          ? 'crashed' as const
          : unjudgeableCause({ class: r.verdict?.class ?? resolveDecisionCategory(r), score: r.score ?? null }, judging),
      }))
      .filter((u): u is { ref: string; cause: UnjudgeableCause | 'crashed' } => u.cause !== undefined);
    const erroredReasons: ErroredReason[] = [
      ...(conditionErrors.length > 0 ? ['condition_error' as const] : []),
      ...(unjudgeable.length > 0 ? ['agent_unjudgeable' as const] : []),
    ];
    const reasonText = [
      ...(conditionErrors.length > 0 ? [`condition_error: the condition of ${conditionErrors.map(r => `"${r}"`).join(', ')} read a step that did not pass`] : []),
      ...(unjudgeable.length > 0 ? [`agent_unjudgeable: ${unjudgeable.map(u => `"${u.ref}" ${causeText[u.cause]}`).join(', ')}`] : []),
    ];
    const errored = erroredReasons.length > 0
      ? { status: 'errored' as const, erroredReasons, skipReason: reasonText.join('; ') }
      : { status: 'completed' as const };
    return withDispatched(dispatched, {
      id: stage.id,
      name: stage.name,
      type: 'command' as const,
      ...errored,
      result: {
        type: 'command',
        name: stage.name,
        // No definition backs this result — it's a synthesized aggregate over
        // the stage's child agent results, not a real command. The marker is
        // deliberately non-parseable as a real release (a genuine definition
        // is never versioned this way), so downstream consumers (SubmissionClient's
        // realVersion) can tell it apart from an actual 1.0.0 release instead of
        // reporting an invented version as real definition identity.
        version: CRASH_PLACEHOLDER_VERSION,
        definitionHash: '',
        agentType: 'analyst',
        decision: stageNegative ? 'FAIL' : stageAborted ? ABORTED_DECISION : 'PASS',
        decisionCategory: stageNegative ? 'negative' as const : stageAborted ? 'neutral' as const : 'positive' as const,
        // KEEP: avgScore is a real average over child agents; maxScore 100 is its scale,
        // not a fabrication. An all-scoreless stage now reports `null` rather than a
        // fabricated 0 (the residual zero routed to composition-aggregation-spec, closed
        // 2026-08-24) — so gateScore's documented fail-open for scoreless stages actually
        // fires instead of being defeated by a 0 that reads as a failing score.
        score: avgScore,
        maxScore: 100,
        extractionConfidence: worstExtractionConfidence(agentResults),
        recommendations: agentResults.flatMap(r => r.recommendations),
        durationMs: stageDurationMs,
        metrics: {
          ...sumTokenMetrics(agentResults.map(r => r.metrics)),
          ...rollupCost(agentResults.map(r => r.metrics)),
          durationMs: stageDurationMs,
          model: 'mixed',
      // FABRICATION-OK: summing a count of events; see CommandExecutor.
          toolCalls: agentResults.reduce((sum, r) => sum + (r.metrics.toolCallCount ?? 0), 0),
        },
        ...(markers ? { degradationMarkers: markers } : {}),
      },
      agentResults,
      durationMs: stageDurationMs,
    });
  }

  /** Steps stages (PDL shell preflight / build gates). */
  private async executeStepsStage(
    stage: StageDefinition,
    input: ExecutionInput,
    options: ExecutionOptions | undefined,
    startTime: number,
  ): Promise<StageResult> {
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

  /** Ref-based stages (command / workflow refs), plus the no-content guards. */
  private async executeRefStage(
    stage: StageDefinition,
    input: ExecutionInput,
    startTime: number,
    // Carried solely to forward the cancellation signal into a nested workflow or command.
    // Everything else on ExecutionOptions is already resolved by the time a ref stage
    // dispatches; a cancel is the one thing that arrives DURING execution.
    options?: ExecutionOptions,
  ): Promise<StageResult> {
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
      const result = await this.workflowExecutor.execute(resolved, input, { abortSignal: options?.abortSignal });
      return {
        id: stage.id,
        name: stage.name,
        type: 'workflow',
        status: 'completed',
        result,
        durationMs: Date.now() - startTime,
      };
    }

    const result = await this.commandExecutor.execute(resolved, input, { abortSignal: options?.abortSignal });
    return {
      id: stage.id,
      name: stage.name,
      type: 'command',
      status: 'completed',
      result,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute inline agent refs in parallel, resolving each from the registry.
   */
  private async executeInlineAgents(
    agents: NonNullable<StageDefinition['agents']>,
    input: ExecutionInput,
    options: ExecutionOptions | undefined,
    conditionCtx: ConditionContext,
  ): Promise<{ results: AgentResult[]; conditionErrors: string[]; dispatched: NonNullable<StageDefinition['agents']> }> {
    // Per-agent conditions (PDL 1.6.0): an agent whose condition is false is not dispatched and
    // not scored, and no result is recorded for it. One whose condition is E (it read a step that
    // did not pass) is not dispatched either; it is ERRORED, and the caller marks the stage.
    // Conditions read earlier stages' results and the run's parameters.
    const conditionErrors: string[] = [];
    const dispatched = agents.filter((a) => {
      if (!a.condition) return true;
      const value = evaluateCondition(a.condition, conditionCtx);
      if (value === true) return true;
      if (value === E) {
        conditionErrors.push(a.ref);
        this.logger.warn(`Inline agent "${a.ref}" is ERRORED (condition_error): its condition "${a.condition}" read a step that did not pass`);
      } else {
        this.logger.info(`Skipping inline agent "${a.ref}" — condition not met: ${a.condition}`);
      }
      return false;
    });

    // Per-agent elapsed time, captured so a CRASHED agent can report how long it actually
    // ran. crashMetrics defaults durationMs to 0 when the error carries no billed metrics,
    // which meant an inline agent that consumed 45 s before failing reported 0 ms — a
    // number nobody measured, in the field that says how much work was done.
    const dispatchStart = dispatched.map(() => Date.now());
    // Classified at rejection time — see CommandExecutor.executeParallel (crew #110 F5).
    const kinds = dispatched.map((): 'stopped' | 'deadline' | 'crash' => 'crash');
    const settled = await Promise.allSettled(
      dispatched.map(async (a, idx) => {
        dispatchStart[idx] = Date.now();
        try {
          const [name, version] = parseRef(a.ref);
          const resolved = await this.registry.resolve(name, version, 'agent');
          // `agentRef.timeout` (ms) overrides the run's timeout for this agent. AgentExecutor
          // validates it (finitePositive) like every other timeout seam.
          const agentOptions = a.timeout !== undefined ? { ...options, timeoutMs: a.timeout } : options;
          return await this.agentExecutor.execute(resolved, input, agentOptions);
        } catch (error) {
          kinds[idx] = rejectionKind(error, options?.abortSignal);
          throw error;
        }
      }),
    );

    const results: AgentResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        // The SHARED factory — this was the third hand-built copy, and it had drifted on
        // every field that classifies the event: no decisionCategory, no priority,
        // severity 'high' and PRA-FRA/H where the other two stamp 'critical' and
        // PRA-FRA/C. The same crash reached the tracker at two different severities
        // depending on which executor dispatched it.
        // An agent stopped by a stop of THIS run is not a crash (aborted-agent-recording §4):
        // it gets the aborted twin — no recommendation, neutral, not completed.
        const ref = dispatched[i]?.ref ?? 'unknown';
        const kind = kinds[i]!;
        if (kind === 'stopped') results.push(abortedPlaceholder(ref, outcome.reason, { startedAt: dispatchStart[i] }));
        else {
          const crash = crashPlaceholder(ref, outcome.reason, { startedAt: dispatchStart[i] });
          results.push(kind === 'deadline' ? withDeadlineMark(crash) : crash);
        }
      }
    }
    return { results, conditionErrors, dispatched };
  }

  /**
   * Whether a stage's `depends_on` is satisfied (PDL 1.6.0, D3): every dependency has reached a
   * terminal status. **Any terminal status satisfies**, a skipped or failed dependency included;
   * `depends_on` orders and forwards, and whether a stage runs is decided by its condition. The
   * one exception, a stage downstream of one that failed behind `abort`, is enforced in the stage
   * loop (D1).
   *
   * Before 1.6.0 a dependency had to be `completed`, so the dependents of a skipped stage were
   * skipped in turn (`dependencies_not_met`), and two corpus stages vanished whenever their only
   * upstream was a skipped conditional stage (spec §2.2).
   *
   * Load validation refuses a dependency declared later in the array, or on the stage itself
   * (`forward_reference`), so every dependency that exists has ended by now. A dependency on a
   * stage id that does not exist is not a load error in 1.6.0 (the factory warns); it can never
   * be satisfied, and the stage is skipped with a warning naming it.
   */
  private checkStageDependencies(stage: StageDefinition, allStages: StageDefinition[], results: StageResult[]): boolean {
    let allMet = true;
    for (const dep of stage.depends_on ?? []) {
      if (results.some(r => r.id === dep)) continue;
      allMet = false;
      if (!allStages.some(s => s.id === dep)) {
        this.logger.warn(
          `Stage "${stage.id}" declares depends_on: "${dep}", but no stage with that id exists in this pipeline ` +
          `(unknown dependency) — this dependency can never be satisfied and "${stage.id}" will always be skipped.`,
        );
      }
    }
    return allMet;
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
        // No definition backs this result — it's a synthesized summary of a
        // steps-only stage, not a real command. The marker is deliberately
        // non-parseable as a real release, so downstream consumers (SubmissionClient's
        // realVersion) can tell it apart from an actual 1.0.0 release.
        version: CRASH_PLACEHOLDER_VERSION,
        definitionHash: '',
        agentType: 'analyst',
        decision,
        decisionCategory: decision === 'FAIL' ? 'negative' as const : 'positive' as const,
        score: null,
        maxScore: null,
        recommendations: [],
        durationMs,
        // FABRICATION-OK: a steps stage runs NO LLM by construction, so these are MEASURED zeros for a
      // non-event. sumCostUsd documents this exact case (run #69 F5): a real $0 that sums
      // cleanly, as opposed to the absent cost that poisons a roll-up to undefined.
        metrics: { durationMs, model: 'none', toolCalls: 0, inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0,
          // REAL zero, not absent: a steps stage runs no LLM by construction, so its
          // cost is a known $0. Leaving it undefined would poison every mixed
          // pipeline's sumCostUsd rollup (run #69 F5) — undefined is reserved for
          // LLM work that cannot be priced (unpriced model, crash with unreported usage).
          // FABRICATION-OK: see above — a steps stage genuinely cost $0. Absent here would poison every
      // mixed pipeline rollup to undefined forever.
          costUsd: 0,
          // NEUTRAL in rollupCost: billed agents plus this stage stay 'billed', not 'mixed'.
          // FABRICATION-OK: a real $0 for a stage that runs no LLM by construction (see above).
          costUsdTotal: 0, costBasis: 'none' },
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
      outcome: 'SKIPPED',
      skipReason: reason,
      // FABRICATION-OK: nothing ran, so no time elapsed — 0 is the MEASURED duration of a
      // non-event, not an unknown standing in for one.
      durationMs: 0,
    };
  }

  /**
   * A stage whose condition evaluated to E (PDL 1.6.0: ERRORED, reason `condition_error`). It did not
   * run. It takes its gate's mode like any ERRORED stage: behind `abort` its dependents are skipped.
   */
  private createConditionErrorStage(stage: StageDefinition, detail: string, state: PipelineState): StageResult {
    this.logger.warn(`Stage "${stage.id}" is ERRORED (condition_error): ${detail}`);
    raise(state, { code: 'STAGE_ERRORED', stage: stage.id, reason: 'condition_error' });
    return {
      id: stage.id,
      name: stage.name,
      type: stage.type === 'workflow' ? 'workflow' : 'command',
      status: 'errored',
      outcome: 'ERRORED',
      gateMode: gateMode(stage.gate),
      erroredReasons: ['condition_error'],
      skipReason: `condition_error: ${detail}`,
      // FABRICATION-OK: the stage did not run; 0 is the measured duration of a non-event.
      durationMs: 0,
    };
  }

  /**
   * Judge a stage that launched (PDL 1.6.0 §3.1, §3.2): set its outcome and gate mode, and raise
   * its run-level warnings. Called once per stage; the outcome sets `stages.<id>.passed`, the abort
   * cascade and the run verdict.
   *
   * In order:
   * 1. **A stop reached it** (an agent or the stage result holds a stopped or deadline record): ERRORED
   *    `stopped`. The gate is not evaluated; the stop has already made `allGatesPassed` false.
   * 2. **SKIPPED** (every agent skipped by its own condition): left as is; no gate.
   * 3. **ERRORED** by an unjudgeable agent or an agent condition (executeAgentsStage): no gate.
   * 4. **The gate** (`stageGate.ts`): PASSED, or WARNED behind `warn`, else FAILED. A stage that
   *    threw, a steps stage whose step failed without `continue_on_error`, and a gated stage that
   *    verifiably executed nothing all fail it. A stage with no gate is judged as `warn` (D43).
   */
  private judgeStage(stage: StageDefinition, result: StageResult, state: PipelineState): StageResult {
    if (result.outcome === 'SKIPPED') return result;
    const mode = gateMode(stage.gate);
    result.gateMode = mode;

    if ((result.result !== undefined && stopReached(result.result)) || (result.agentResults?.some(stopReached) ?? false)) {
      const reasons = [...(result.erroredReasons?.filter(r => r === 'condition_error') ?? []), 'stopped' as const];
      this.logger.warn(`Stage "${stage.id}" is ERRORED (stopped): it was in flight when the run was stopped`);
      for (const reason of reasons) raise(state, { code: 'STAGE_ERRORED', stage: stage.id, reason });
      return { ...result, status: 'errored', outcome: 'ERRORED', erroredReasons: reasons };
    }

    if (result.status === 'errored') {
      for (const reason of result.erroredReasons ?? []) {
        this.logger.warn(`Stage "${stage.id}" is ERRORED (${reason})`);
        raise(state, { code: 'STAGE_ERRORED', stage: stage.id, reason });
      }
      return { ...result, outcome: 'ERRORED' };
    }

    const { failed, conditionalAccepted, causes } = this.gateFailed(stage, result);
    for (const agent of conditionalAccepted) {
      this.logger.warn(`Stage "${stage.id}": a blocking gate accepted "${agent}" as CONDITIONAL, so allGatesPassed is false`);
      raise(state, { code: 'CONDITIONAL_ACCEPTED', stage: stage.id, agent });
    }
    const outcome = judgedOutcome(failed, mode);
    if (failed) this.logger.warn(`Stage "${stage.id}" failed its gate (on_failure: ${mode}): ${causes.join('; ')} — ${outcome}`);
    return { ...result, outcome };
  }

  /**
   * Whether a launched, judgeable stage fails its gate, and the CONDITIONAL agents a blocking gate
   * accepted. Members: each dispatched inline agent (its decision class and contract score, P4a), or
   * a ref stage's one result, classified through the referenced definition's own decision.
   */
  private gateFailed(stage: StageDefinition, result: StageResult): { failed: boolean; conditionalAccepted: string[]; causes: string[] } {
    if (result.status === 'failed') return { failed: true, conditionalAccepted: [], causes: [`the stage failed: ${result.skipReason ?? 'error'}`] };
    if (stepsFailed(result)) return { failed: true, conditionalAccepted: [], causes: ['a step without continue_on_error failed'] };

    // A gate over work that never ran fails, whether or not a threshold was declared: an agents
    // stage that dispatched nothing (no agents authored; all-skipped is SKIPPED, above) or a
    // workflow ref whose every phase was skipped. Determined POSITIVELY: an empty `agentResults`,
    // or `phasesExecuted === 0` counted by WorkflowExecutor itself. Sibling of G5 in start().
    if (stage.gate && this.verifiedNothing(result)) {
      this.logger.warn(`Stage "${stage.id}" has a gate but executed nothing — failing the gate rather than passing unverified work.`);
      return { failed: true, conditionalAccepted: [], causes: ['the stage executed nothing'] };
    }

    const perAgent = isPerAgentMode(stage);
    let members: GatedMember[];
    if (result.agentResults) {
      // Each result is paired with the agentRef that dispatched it (executeAgentsStage), for its
      // threshold and its authored name.
      const refs = dispatchedAgents.get(result) ?? [];
      members = result.agentResults.map((r, idx) => {
        const ref = refs[idx];
        return {
          name: ref?.ref ?? r.name,
          class: r.verdict?.class ?? resolveDecisionCategory(r, this.warnUnclassified),
          score: r.score ?? null,
          ...(ref?.threshold !== undefined ? { threshold: ref.threshold } : {}),
        };
      });
    } else if (result.result) {
      members = [{ name: stage.ref ?? stage.id, class: resolveDecisionCategory(result.result, this.warnUnclassified), score: result.result.score ?? null }];
      if (stage.gate?.threshold !== undefined && members[0]!.score === null) {
        this.logger.warn(`Gate threshold on stage "${stage.id}" is not evaluable (no score) — passing on score (fail-open)`);
      }
    } else {
      members = [];
    }
    return judgeGate(stage.gate, members, perAgent);
  }

  /**
   * Whether a gated stage demonstrably executed NOTHING.
   *
   * Returns true only on positive evidence, so an unrecognized stage shape, or any stage
   * that genuinely ran, falls through to the ordinary gate checks. Absence of evidence is
   * not evidence here — this decides whether to fail a gate.
   */
  private verifiedNothing(stageResult: StageResult): boolean {
    // Inline-agents stage: the array is present and empty — nothing was dispatched.
    if (stageResult.agentResults && stageResult.agentResults.length === 0) return true;

    // Workflow-ref stage: WorkflowExecutor counts this itself — a phase is "executed" only
    // when it is neither skipped nor aborted. Shared with SubmissionClient, which applies the
    // same check at the submission boundary (the fabricated-0 reach a gate does not cover).
    return verifiedNothingExecuted(stageResult.result);
  }

  /** Record every not-yet-run stage as skipped with the given reason, so
   *  the result accounts for all authored stages (nothing silently vanishes). */
  private skipRemaining(stages: StageDefinition[], from: number, state: PipelineState, reason: string): void {
    for (let j = from; j < stages.length; j++) {
      const s = stages[j];
      if (s) state.stageResults.push(this.createSkippedStage(s, reason));
    }
  }
}

/**
 * Whether a steps stage's step without `continue_on_error` failed (its decision is FAIL). Such a stage
 * is FAILED, or WARNED behind a `warn` gate, whatever the gate's decision key (PDL 1.6.0 §3.1).
 */
function stepsFailed(stageResult: StageResult): boolean {
  return stageResult.steps !== undefined && stageResult.result?.decision === 'FAIL';
}

/** Steps-stage predicate — explicit `type: 'steps'` (stamped by
 *  normalizePipelineSection) or the structural steps-only shape. */
function isStepsStage(stage: StageDefinition): boolean {
  return stage.type === 'steps' ||
    (Array.isArray(stage.steps) && stage.steps.length > 0 && !stage.ref && !stage.agents);
}

/**
 * Whether the run was stopped mid-flight from another task: a user `cancel()` (`cancelled`) or
 * a provider-credit trip (`failed`).
 *
 * INVARIANT this relies on (1d re-check L2): inside the stage loop, stopRun — the credit trip and,
 * since aborted-agent-recording, a caller deadline — is the ONLY writer of `failed`. (A gate abort wrote `failed` here
 * before PDL 1.6.0; it no longer touches the run status, since an abort is not a stop.) The catch
 * and `execution.catch` run after the loop. A new writer of `failed` inside the loop that does
 * not break would be read here as a credit stop and its remaining stages skipped under that
 * label — give it its own break, or key this on a dedicated flag.
 *
 * Read through a function, not a direct comparison: the
 * status is mutated from another task while this one awaits, which TypeScript's control-flow
 * narrowing cannot see — it narrows at the top-of-loop check and then reports a later direct
 * comparison as having no overlap, a compile error for the one case the guard exists for.
 */
function stoppedNow(state: PipelineState): boolean {
  return state.status === 'cancelled' || state.status === 'failed';
}

/**
 * The skip reason recorded on stages a stopped run never reached: a short token, like the gate
 * and cancel reasons. The provider's full text lives once on `state.error` (and so on the
 * thrown PipelineError), not copied into every skipped stage (1d re-check L1).
 */
function stopLabel(state: PipelineState): string {
  return state.status === 'cancelled' ? 'cancelled' : stopLabels.get(state) ?? 'run stopped';
}

/** The short skip label of a `failed` stop, recorded by stopRun: a credit trip or a deadline. */
const stopLabels = new WeakMap<PipelineState, string>();

/**
 * The agentRef behind each of an agents stage's results, in result order (the stage's agents with
 * the condition-skipped ones removed). The gate reads each agent's own threshold and authored name
 * from it. Held beside the result, not on the public StageResult.
 */
const dispatchedAgents = new WeakMap<StageResult, NonNullable<StageDefinition['agents']>>();
function withDispatched(dispatched: NonNullable<StageDefinition['agents']>, result: StageResult): StageResult {
  dispatchedAgents.set(result, dispatched);
  return result;
}

/** Add a run-level warning (PDL 1.6.0) to the run's state. */
function raise(state: PipelineState, warning: PipelineWarning): void {
  (state.warnings ??= []).push(warning);
}


/**
 * Stop a run: the ONE sequence shared by `handle.cancel()` and a provider-credit trip (D13).
 *
 * Abort the in-flight provider call, not just the loop between stages. Until cancel() aborted,
 * it set a flag that executeAsync only read at stage boundaries, so the agent currently talking
 * to the model ran to completion and was billed in full — a cancel stopped the NEXT stage from
 * starting and nothing that cost money. The status flag is set first: it is what the loop, the
 * catch, and buildResult read to report `cancelled`, and aborting alone would surface as a
 * provider error. The abort carries no custom reason, exactly as before.
 */
function stopRun(
  state: PipelineState,
  controller: AbortController,
  status: 'cancelled' | 'failed',
  reason: string,
  label?: string,
): void {
  if (label !== undefined) stopLabels.set(state, label);
  state.status = status;
  state.error = reason;
  controller.abort();
}

/**
 * Handle for monitoring and controlling an async pipeline execution
 */
class PipelineHandle implements IPipelineHandle {
  readonly executionId: string;
  private state: PipelineState;
  private execution: Promise<void>;
  private controller: AbortController;

  /** True once the execution promise has settled — status alone is set before a stopped run unwinds. */
  private settled = false;

  constructor(executionId: string, state: PipelineState, execution: Promise<void>, controller: AbortController) {
    this.executionId = executionId;
    this.state = state;
    this.execution = execution;
    this.controller = controller;
    const markSettled = () => { this.settled = true; };
    execution.then(markSettled, markSettled);
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
    // A run already STOPPED — by an earlier cancel(), the caller's own abortSignal (OD-7), a caller
    // deadline or a credit trip — and still unwinding is a no-op, not an "already complete"
    // rejection: it is not complete, and teardown code that both aborts its signal and calls
    // cancel() must not get a rejection the pre-OD-7 run never produced (crew #110 F3, re-check
    // M2). A run that has SETTLED still rejects, as before.
    if (this.state.status === 'cancelled' || (stoppedNow(this.state) && !this.settled)) return;
    if (this.isComplete()) {
      throw new PipelineError(
        `Pipeline ${this.executionId} is already complete (status: ${this.state.status})`,
        {},
      );
    }
    stopRun(this.state, this.controller, 'cancelled', 'Pipeline cancelled by user');
  }

  private buildResult(): PipelineResult {
    const durationMs = Date.now() - this.state.startTime;

    // A stage whose nested result demonstrably executed nothing enters the roll-up as
    // SCORELESS, not as 0. WorkflowExecutor hands an all-skipped workflow `score: 0` on
    // purpose (aggregateScores' empty-input branch) so that a GATE over that stage blocks;
    // gateFailed reads the execution count before trusting that 0. When the stage has no
    // gate, nothing reads it — and this line used to carry it straight into the pipeline
    // average as a measured zero, where `stagesExecuted` (correctly 1: the stage ran) meant
    // SubmissionClient's own check could no longer tell. One ungated all-skipped stage
    // beside a genuine 85 averaged to 43 (score-aggregation-semantics spec v0.2.0 §7 L3-2).
    // A stage that ran and legitimately scored 0 still enters as 0.
    const score = aggregateScores(
      this.state.stageResults.map(s => ({
        key: s.id,
        score: verifiedNothingExecuted(s.result) ? null : (s.result?.score ?? null),
      })),
    );

    const recommendations = this.state.stageResults
      .flatMap(s => s.result?.recommendations ?? []);

    // The run verdict, computed once (PDL 1.6.0 §3.1, D13; executor/runVerdict.ts). The decision,
    // its category and the stage metrics are derived from it, and SubmissionClient saves it as is.
    const warnings = [...(this.state.warnings ?? [])];
    const allGatesPassed = computeAllGatesPassed(this.state.stageResults, warnings, {
      stopReached: this.stopReachedAnyStage(),
      // A run whose own execution threw (not a stop: a stop records its label) did not reach the
      // end of its stages.
      executionFailed: this.state.status === 'failed' && !stopLabels.has(this.state),
    });
    const decision = runDecision(allGatesPassed, this.state.stageResults);
    const decisionCategory = runDecisionCategory(decision);

    return {
      type: 'pipeline',
      name: this.state.definitionName,
      version: this.state.definitionVersion,
      definitionHash: this.state.definitionHash,
      minSubscription: this.state.minSubscription,
      decision,
      decisionCategory,
      allGatesPassed,
      warnings,
      ...(this.state.params ? { params: this.state.params } : {}),
      score,
      extractionConfidence: worstExtractionConfidence(
        this.state.stageResults.map(s => s.result).filter((r): r is NonNullable<typeof r> => r != null),
      ),
      durationMs,
      status: mapPipelineStatus(this.state.status),
      stages: this.state.stageResults,
      recommendations,
      metrics: {
        ...sumTokenMetrics(this.rollupTokenChildren()),
        ...rollupCost(this.rollupCostChildren()),
        durationMs,
        model: 'mixed',
        ...stageMetrics(this.state.stageResults),
      },
    };
  }

  /**
   * Children of the TOKEN roll-up: every stage that actually produced metrics.
   * Token sums deliberately coalesce absent components to 0 (see sumTokenMetrics) —
   * an absent token component is a visibility artifact over a real, counted run.
   */
  private rollupTokenChildren() {
    return this.state.stageResults
      .map(s => s.result?.metrics)
      .filter((m): m is NonNullable<typeof m> => m != null);
  }

  /**
   * Children of the COST roll-up. Its polarity is the opposite of the token roll-up's
   * and the difference is load-bearing (see sumCostUsd's contract).
   *
   * A stage that THREW has no `result` at all — executeStage's catch returns a bare
   * failed StageResult — so filtering on `result != null` silently DROPPED it. That made
   * a stage which crashed after its child agents had already billed indistinguishable
   * from a stage that ran no LLM by construction, and the surviving stages' partial sum
   * was then presented as the run's total. The polarity sumCostUsd exists to enforce was
   * implemented correctly at the agent level (crash placeholders omit costUsd) and broken
   * one level up, here.
   *
   * So each failed stage with no metrics contributes an explicitly UNPRICED child, and
   * the roll-up degrades to undefined — worst-child discipline. `skipped` still
   * contributes nothing, which is correct: nothing ran, so there is nothing unknown.
   */
  private rollupCostChildren(): ReadonlyArray<CostFields> {
    const children: CostFields[] = [];
    for (const s of this.state.stageResults) {
      if (s.result?.metrics) children.push(s.result.metrics);
      else if (s.status === 'failed') children.push({ costUsd: undefined, costBasis: 'unpriced' });
    }
    return children;
  }

  /**
   * A run stop reached a stage (§3.1, the stop clause): a stage it kept from starting, a stage it
   * found in flight (ERRORED `stopped`), or a stage holding a stopped or deadline record. A stop that
   * landed after the last stage ended reached nothing, and leaves the stages' own verdict (F2,
   * Alex 2026-10-06: "stopped" means a stop REACHED something).
   */
  private stopReachedAnyStage(): boolean {
    const label = stopLabel(this.state);
    return this.state.stageResults.some(s =>
      (s.status === 'skipped' && s.skipReason === label)
      || (s.erroredReasons?.includes('stopped') ?? false)
      || (s.result !== undefined && stopReached(s.result))
      || (s.agentResults?.some(stopReached) ?? false));
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
