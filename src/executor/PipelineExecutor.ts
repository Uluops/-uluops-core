import type { AgentExecutor } from './AgentExecutor.js';
import { finiteNonNegative } from '../utils/externalValue.js';
import type { CommandExecutor } from './CommandExecutor.js';
import type { WorkflowExecutor } from './WorkflowExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { PipelineDefinition, StageDefinition, GateDefinition, PipelineResult, StageResult, StepResult, PipelineState, PipelineHandle as IPipelineHandle } from '../types/pipeline.js';
import { StepsExecutor } from './StepsExecutor.js';
import { nulParameter } from './stepTemplates.js';
import { evaluateCondition, E, type ConditionContext } from './conditions.js';
import { checkPipelineLoadRules, stagesReadingStepOutput, bindParameterDefaults } from './pipelineLoad.js';
import { isUnjudgeable } from './agentVerdict.js';
import { agentsMissingVocabulary, vocabularyMissingMessage } from './vocabularyPrecheck.js';
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
import { crashPlaceholder, abortedPlaceholder, isStoppedResult, toCommandRecord, withDeadlineMark, ABORTED_DECISION, CRASH_PLACEHOLDER_VERSION } from '../utils/crashPlaceholder.js';
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
    // Conditions and steps read the run's parameters with declared defaults bound first (PDL 1.6.0,
    // condition context). Agents do not read parameters by name.
    const runInput: ExecutionInput = { ...input, params: bindParameterDefaults(def.pipeline, input.params, input.target) };
    // `stages.<id>.passed` for every stage that has ended: PASSED in the spec's status model.
    const passed = new Map<string, boolean>();
    const conditionCtx: ConditionContext = { params: runInput.params ?? {}, stages: state.stageResults, passed };

    try {
      for (let i = 0; i < def.pipeline.stages.length; i++) {
        if (stoppedNow(state)) {
          // Record what did not run, exactly as the gate-abort path does via skipRemaining.
          // A bare `break` left un-run stages ABSENT from stageResults[], so
          // computeStageMetrics reported `stagesSkipped: 0` for a 6-stage pipeline stopped
          // at stage 2, and buildResult computed a full-looking score over a partial run.
          // A consumer could not distinguish "cancelled at stage 2" from "had 2 stages".
          this.skipRemaining(def.pipeline.stages, i, state, stopLabel(state));
          break;
        }

        const stage = def.pipeline.stages[i];
        if (!stage) break;
        state.currentStageIndex = i;

        // Check dependencies
        if (!this.checkStageDependencies(stage, def.pipeline.stages, state.stageResults)) {
          state.stageResults.push(this.createSkippedStage(stage, 'dependencies_not_met'));
          continue;
        }

        // The stage condition (PDL 1.6.0, the condition language): the stage runs when it is true
        // and is SKIPPED when it is false. Load validation (start()) has refused every condition
        // that does not parse or references what does not exist, so the value is total: true,
        // false, or E — a read of a step that did not pass. E makes the stage ERRORED
        // (`condition_error`). Until P4b adds that status, an E stage is recorded `failed` with
        // `condition_error` as its reason, and its gate decides the flow as for any failed stage.
        // Before 1.6.0 a condition core could not read made the stage run (fail-open), and a
        // deprecated `skip_if` was evaluated beside it; `skip_if` is now an undeclared key (D25).
        if (stage.condition) {
          const value = evaluateCondition(stage.condition, conditionCtx);
          if (value === false) {
            state.stageResults.push(this.createSkippedStage(stage, 'condition_not_met'));
            passed.set(stage.id, false);
            continue;
          }
          if (value === E) {
            state.stageResults.push(this.createConditionErrorStage(stage, `its condition "${stage.condition}" read a step that did not pass`));
            passed.set(stage.id, false);
            if (this.enactGate(stage, true, def.pipeline.stages, i, state)) break;
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
        const stageResult = await this.executeStage(stage, runInput, options, conditionCtx, upstreamContext);
        state.stageResults.push(stageResult);

        // A cancel that landed WHILE this stage was running wins over anything the gate
        // would decide about it. This is the same defect as the catch below, one ring out:
        // there the stage THREW after cancel() flipped the flag and the catch overwrote
        // `cancelled` with `failed`; here the stage COMPLETED, failed its gate, and the
        // unconditional `state.status = 'failed'` twelve lines down overwrote the cancel
        // exactly the same way — so wait() threw a PipelineError at a user who had asked
        // to stop. Only the catch half was fixed. The gate's sole output is a flow
        // decision about stages that are not going to run now either way, so there is
        // nothing lost by not consulting it; the completed stage's own result is already
        // recorded above.
        //
        // Read through `stoppedNow()`: `cancel()` and a credit trip mutate `state.status` from ANOTHER
        // task while this one is awaiting, and TypeScript's control-flow analysis cannot
        // see that. It narrows `state.status` at the top-of-loop check above and then
        // reports a direct comparison here as having no overlap — a compile error for the
        // one case this guard exists to catch.
        // A credit trip (stopRun → `failed`) stops the run the same way: the remaining stages
        // are skipped and the gate is not consulted, since the run has already failed.
        if (stoppedNow(state)) {
          this.skipRemaining(def.pipeline.stages, i + 1, state, stopLabel(state));
          break;
        }

        // Enact the stage gate (PDL $defs/gate). Until now gates were parsed
        // but never read — on_failure:abort flowed on like warn (G5).
        // The gate is judged once: the same verdict sets `stages.<id>.passed` and the flow.
        const gateFailed = stage.gate ? this.gateFailed(stage.gate, stage, stageResult) : stepsFailed(stageResult);
        passed.set(stage.id, stageResult.status === 'completed' && !gateFailed);
        if (this.enactGate(stage, gateFailed, def.pipeline.stages, i, state)) break;
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
      const hardGated = def.pipeline.stages.filter(
        s => isStepsStage(s) && s.gate !== undefined && resolveOnFailure(s.gate) === 'abort',
      );
      if (hardGated.length > 0) {
        throw new PipelineError(
          `Run refused: ${hardGated.map(s => `"${s.id}"`).join(', ')} is a hard gate (gate.on_failure: abort) ` +
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
    const { results: agentResults, conditionErrors } = await this.executeInlineAgents(stage.agents!, agentInput, options, conditionCtx);
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
    // (PDL 1.6.0, Semantics). Until P4b adds that status, the stage is recorded `failed` with
    // `condition_error` as its reason; the agents that did run keep their records.
    // An unjudgeable agent (D24) makes its stage ERRORED too: no score and no classifiable
    // decision, or no score at a gate with a threshold. Same interim as a condition error until
    // P4b. Stopped and crashed records are P4b's (a stop's ERRORED, a timeout's): excluded here.
    const gateHasThreshold = stage.gate?.threshold !== undefined || (stage.agents ?? []).some(a => a.threshold !== undefined);
    const unjudgeable = agentResults
      .filter(r => !isStoppedResult(r) && r.version !== CRASH_PLACEHOLDER_VERSION)
      .filter(r => isUnjudgeable({ class: r.verdict?.class ?? resolveDecisionCategory(r), score: r.score ?? null }, gateHasThreshold))
      .map(r => r.name);
    const reasons = [
      ...(conditionErrors.length > 0 ? [`condition_error: the condition of ${conditionErrors.map(r => `"${r}"`).join(', ')} read a step that did not pass`] : []),
      ...(unjudgeable.length > 0 ? [`agent_unjudgeable: ${unjudgeable.map(r => `"${r}"`).join(', ')} gave no score${gateHasThreshold ? ' at a gate with a threshold' : ' and no classifiable decision'}`] : []),
    ];
    for (const reason of reasons) this.logger.warn(`Stage "${stage.id}" is ERRORED (${reason})`);
    const conditionError = reasons.length > 0
      ? { status: 'failed' as const, skipReason: reasons.join('; ') }
      : { status: 'completed' as const };
    return {
      id: stage.id,
      name: stage.name,
      type: 'command' as const,
      ...conditionError,
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
    };
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
    agents: Array<{ ref: string; condition?: string }>,
    input: ExecutionInput,
    options: ExecutionOptions | undefined,
    conditionCtx: ConditionContext,
  ): Promise<{ results: AgentResult[]; conditionErrors: string[] }> {
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
          return await this.agentExecutor.execute(resolved, input, options);
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
    return { results, conditionErrors };
  }

  /**
   * Whether a stage's `depends_on` is satisfied (PDL 1.6.0, D3): every dependency has reached a
   * terminal status. **Any terminal status satisfies**, a skipped or failed dependency included;
   * `depends_on` orders and forwards, and whether a stage runs is decided by its condition. (The
   * one exception, a stage downstream of one that failed behind `abort`, is P4b's; until then an
   * abort ends the loop, so no dependent is reached.)
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
      skipReason: reason,
      // FABRICATION-OK: nothing ran, so no time elapsed — 0 is the MEASURED duration of a
      // non-event, not an unknown standing in for one.
      durationMs: 0,
    };
  }

  /**
   * A stage whose condition evaluated to E (PDL 1.6.0: ERRORED, reason `condition_error`). Until
   * P4b adds the ERRORED status it is recorded `failed`, with `condition_error` as its reason. It
   * did not run.
   */
  private createConditionErrorStage(stage: StageDefinition, detail: string): StageResult {
    this.logger.warn(`Stage "${stage.id}" is ERRORED (condition_error): ${detail}`);
    return {
      id: stage.id,
      name: stage.name,
      type: stage.type === 'workflow' ? 'workflow' : 'command',
      status: 'failed',
      skipReason: `condition_error: ${detail}`,
      // FABRICATION-OK: the stage did not run; 0 is the measured duration of a non-event.
      durationMs: 0,
    };
  }

  /**
   * Enact a judged stage's gate flow. Returns true when the stage loop must stop: an abort, or a
   * gate whose `skip` / `on_success: skip_remaining` ends the run early. Remaining stages are
   * recorded skipped with the gate's reason.
   */
  private enactGate(stage: StageDefinition, failed: boolean, stages: StageDefinition[], i: number, state: PipelineState): boolean {
    const flow = this.applyGate(stage, failed);
    if (flow === 'abort') {
      this.skipRemaining(stages, i + 1, state, 'gate_abort');
      state.error = `Stage "${stage.id}" failed its gate (on_failure: abort)`;
      state.status = 'failed';
      return true;
    }
    if (flow === 'skip' || flow === 'skip_remaining') {
      this.skipRemaining(stages, i + 1, state, flow === 'skip' ? 'gate_skip' : 'gate_early_exit');
      return true;
    }
    return false;
  }

  /**
   * Evaluate a completed stage against its gate and return the flow action.
   * 'continue' means no gate effect (no gate, gate passed, or on_failure:warn).
   */
  private applyGate(stage: StageDefinition, failed: boolean): 'continue' | 'abort' | 'skip' | 'skip_remaining' {
    const gate = stage.gate;
    if (!gate) return 'continue';

    if (failed) {
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

    // A gate over work that never ran fails, whether or not a threshold was declared.
    //
    // `gate.threshold` is optional, and without it `gateFailed` consults only the DECISION.
    // But a workflow whose every phase was skipped reports SHIP (no phase failed — which is
    // true), and an agents stage that dispatched nothing reports PASS (nothing came back
    // negative — also true). Both are honest about what happened and both mean nothing was
    // verified, so a threshold-less `on_failure: abort` gate passed them. The score channel
    // was fixed to report 0 for exactly this case; the decision channel said PASS beside it.
    //
    // Sibling of the G5 check above ("hard gates must not silently pass unexecuted"), which
    // covers a steps stage authored with no steps. Same rule, reached at runtime instead of
    // at authoring time.
    //
    // Determined POSITIVELY, never inferred from a score: an empty `agentResults` means
    // nothing was dispatched, and `phasesExecuted === 0` is counted by WorkflowExecutor
    // itself. A stage that ran and legitimately scored 0 is untouched.
    if (this.verifiedNothing(stageResult)) {
      this.logger.warn(
        `Stage "${stage.id}" has a gate but executed nothing — no agent was dispatched and ` +
        `no phase ran. Failing the gate rather than passing unverified work.`,
      );
      return true;
    }

    if (gate.threshold !== undefined) {
      // Authored YAML reaches here type-erased: `.nan` / `.inf` / a string are all
      // authorable. `score < NaN` is false, so an unusable threshold used to make
      // an on_failure: abort hard gate pass every stage silently — while the
      // WorkflowExecutor twin (`score >= threshold`) failed CLOSED on the same
      // input. Same seam as every other authored bound (externalValue), same
      // polarity as the workflow gate now: unusable → fail closed, and say so.
      const threshold = finiteNonNegative(gate.threshold);
      if (threshold === undefined) {
        this.logger.warn(
          `Gate threshold on stage "${stage.id}" is not a usable number (${String(gate.threshold)}) — ` +
          `failing the gate rather than comparing against it (fail-closed; ship run #94)`,
        );
        return true;
      }
      const score = this.gateScore(gate, stageResult);
      if (score === null) {
        this.logger.warn(`Gate threshold on stage "${stage.id}" is not evaluable (no scores) — passing (fail-open)`);
        return false;
      }
      return score < threshold;
    }

    return false;
  }

  /**
   * Whether a gated stage demonstrably executed NOTHING.
   *
   * Returns true only on positive evidence, so an unrecognized stage shape, or any stage
   * that genuinely ran, falls through to the ordinary gate checks. Absence of evidence is
   * not evidence here — this decides whether to fail a gate.
   */
  private verifiedNothing(stageResult: StageResult): boolean {
    // Inline-agents stage: the array is present and empty, meaning every agent's condition
    // was false (or none were authored) so nothing was dispatched.
    if (stageResult.agentResults && stageResult.agentResults.length === 0) return true;

    // Workflow-ref stage: WorkflowExecutor counts this itself — a phase is "executed" only
    // when it is neither skipped nor aborted. Shared with SubmissionClient, which applies the
    // same check at the submission boundary (the fabricated-0 reach a gate does not cover).
    return verifiedNothingExecuted(stageResult.result);
  }

  /**
   * The score a gate threshold evaluates: `gate.aggregate` (PDL default 'min')
   * over inline-agent scores when present — crashed/scoreless agents excluded,
   * matching the stage-average exclusion — else the stage result's own score.
   */
  // NOTE — this is NOT the score reported on the stage result. That one is a plain average
  // (see executeAgentsStage); this applies the AUTHORED aggregate, default 'min'. The two
  // legitimately differ, and a stage can report 78 while failing a threshold of 70 on its
  // weakest agent. Documented at both ends because the divergence is invisible from either.
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

/**
 * For a stage with no gate, whether it failed: a steps stage whose step without `continue_on_error`
 * failed (its decision is FAIL), or a stage that failed outright. Such a stage is not PASSED, so
 * `stages.<id>.passed` reads false (PDL 1.6.0, Stage status: PASSED is "no gate and every step
 * succeeded").
 */
function stepsFailed(stageResult: StageResult): boolean {
  return stageResult.status !== 'completed' || (stageResult.steps !== undefined && stageResult.result?.decision === 'FAIL');
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
 * since aborted-agent-recording, a caller deadline — is the ONLY writer of `failed`. The gate-abort branch writes `failed` and `break`s in the same block; the catch
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


/** PDL schema default: a gate without on_failure is an abort gate. Corpus
 *  audit (2026-07-10, udl/pdl/v1): every stage gate declares on_failure
 *  explicitly, so the default activates nothing silently. */
function resolveOnFailure(gate: GateDefinition): 'abort' | 'warn' | 'skip' {
  return gate.on_failure ?? 'abort';
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
        ...this.computeStageMetrics(),
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

  /** A run stop reached a stage: a stage it kept from starting, or a stage holding a stopped/deadline record. */
  private stopReachedAnyStage(): boolean {
    const label = stopLabel(this.state);
    return this.state.stageResults.some(s =>
      (s.status === 'skipped' && s.skipReason === label)
      || (s.result !== undefined && stopReached(s.result))
      || (s.agentResults?.some(stopReached) ?? false));
  }

  private computeDecision(): string {
    // Thrown-error stages have status='failed' but no result.decision.
    // resolveDecisionCategory prefers the stage result's propagated decisionCategory
    // (vocabulary-resolved at the producing executor) over raw-string classification,
    // so custom-vocabulary negatives from command/workflow refs gate correctly.
    const hasFailures = this.state.stageResults.some(s =>
      s.status === 'failed' || resolveDecisionCategory(s.result) === 'negative',
    );
    // A real failure wins over a user cancel (Alex 2026-10-05, OD-13), as at every level below:
    // a run that FAILED a stage and was then cancelled reads FAIL. Status stays `cancelled` and
    // wait() still resolves — only the decision word changes.
    if (this.state.status === 'cancelled') {
      if (hasFailures) return 'FAIL';
      if (this.stopReachedAnyStage()) return 'CANCELLED';
      // A cancel that reached no stage — it landed after the last stage's work returned — leaves
      // the stages' own verdict (fall through). Status stays `cancelled`; only the word follows the
      // work (F2, Alex 2026-10-06: "stopped" means a stop REACHED something, at every level).
    } else if (this.state.status === 'failed') {
      // `failed` written by a STOP (deadline; a credit trip always leaves its originator's crash, so
      // hasFailures) that reached no stage keeps the stages' verdict; wait() still throws. Any other
      // `failed` — a gate abort, a thrown execution — is FAIL.
      if (hasFailures || !stopLabels.has(this.state) || this.stopReachedAnyStage()) return 'FAIL';
    } else if (hasFailures) return 'FAIL';

    // A stage holding an aborted record means the run was stopped, whatever the status says.
    // Defence in depth beside the caller-signal listener in start() (OD-7): without it, a run whose
    // stop did not reach `state.status` and whose completed agents passed would report PASS.
    if (this.state.stageResults.some(s => s.result !== undefined && isStoppedResult(s.result))) return 'CANCELLED';

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
