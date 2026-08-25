import type { AgentExecutor } from './AgentExecutor.js';
import type { CommandExecutor } from './CommandExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { WorkflowDefinition, WorkflowResult, PhaseResult, PhaseDefinition, WorkflowDecision } from '../types/workflow.js';
import type { CommandResult, CommandMetrics } from '../types/command.js';
import type { AgentResult } from '../types/agent.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import { WorkflowError, ConfigurationError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { DEFAULT_GATE_THRESHOLD } from '../constants.js';
import { aggregateScores } from '../utils/aggregateScores.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { sumCostUsd } from '../utils/sumCostUsd.js';
import { crashMetrics } from '../utils/crashMetrics.js';
import { topoGroupLevels } from '../utils/topoSort.js';
import { parseRef } from '../utils/parseRef.js';
import { resolveDecisionCategory, type DecisionCategory } from './classifyDecision.js';
import { worstExtractionConfidence } from '../utils/worstExtractionConfidence.js';
import type { Logger } from '@uluops/sdk-core';

/**
 * Executes workflows as quality-gated directed acyclic graphs.
 *
 * Phases are topologically sorted into execution levels based on declared
 * dependencies. Independent phases (those in the same topological level)
 * execute in parallel. Quality gates evaluate continuous AI judgment scores
 * against declared thresholds, with four distinct failure behaviors:
 *
 * - stop:  do not start subsequent levels; let running phases finish
 * - abort: cancel running phases immediately; skip all remaining
 * - continue: proceed past failure; dependent phases still check deps
 * - warn:  proceed with warning annotation; no blocking
 */
/**
 * Recover the completed-and-billed command results a thrown WorkflowError is carrying.
 *
 * Identity-free (`code` discriminant, not `instanceof`) for the reason errors/index.ts
 * documents: two copies of this package in one dependency tree are two class identities,
 * and the failure would be a silent false negative at a seam that carries real money.
 */
function extractPartialCommands(error: unknown): CommandResult[] {
  if (typeof error !== 'object' || error === null) return [];
  const ctx = (error as { context?: { partialResult?: unknown } }).context;
  const partial = ctx?.partialResult;
  return Array.isArray(partial) ? (partial as CommandResult[]) : [];
}

export class WorkflowExecutor {
  private logger: Logger;

  /** Gate-boundary tripwire for unclassifiable decisions — see CommandExecutor.warnUnclassified (issue 3e74bc69). */
  private warnUnclassified = (decision: string): void => {
    this.logger.warn(
      `Decision "${decision.slice(0, 80)}" has no stamped decisionCategory and is not in the core register — ` +
      `resolving 'neutral' (non-gating). A custom-vocabulary negative from a pre-0.30 producer would not gate here.`,
    );
  };

  constructor(
    private commandExecutor: CommandExecutor,
    private registry: RegistryClient,
    private agentExecutor?: AgentExecutor,
    logger?: Logger,
  ) {
    this.logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  /**
   * Execute a workflow with DAG-based phase orchestration.
   *
   * Phases are grouped into topological levels. All phases in a level
   * whose dependencies are satisfied execute in parallel. Gate evaluation
   * occurs after each phase completes, and failure behavior determines
   * whether subsequent levels proceed.
   *
   * @param resolved - Registry-resolved workflow definition (must have `type: 'workflow'`).
   * @param input - Execution input; `target` is the absolute project path.
   * @returns The {@link WorkflowResult} with per-phase results, aggregate score, decision, and metrics.
   * @param control - Optional run controls. `abortSignal` is threaded to every provider call
   *                   this workflow makes, so aborting it ends the in-flight request rather
   *                   than only stopping the next phase from starting. Optional and
   *                   trailing — existing two-argument callers are unaffected.
   * @throws {WorkflowError} on internal workflow failures (phase crashes, gate violations)
   * @throws {CancelledError} if `control.abortSignal` fires while a phase is in flight
   * @throws {ConfigurationError} if the definition is not a valid workflow
   */
  async execute(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    /**
     * Caller-supplied cancellation, threaded to every provider call this workflow makes.
     *
     * Passed as a parameter rather than held on the instance: one WorkflowExecutor serves
     * concurrent runs, so a per-run field would let one caller's cancel abort another
     * caller's workflow. Optional and trailing — existing two-argument callers are
     * unaffected and simply remain uncancellable, which is what they are today.
     */
    control?: { abortSignal?: AbortSignal },
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    const def = this.assertWorkflowDefinition(resolved);
    const phaseResults: PhaseResult[] = [];
    const allRecommendations: Recommendation[] = [];
    const completedPhases = new Map<string, PhaseResult>();

    try {
      const levels = topoGroupLevels(def.workflow.orchestration.phases);
      const { on_failure: onFailure, max_parallel: maxParallel } = def.workflow.orchestration;
      let stopped = false;
      let aborted = false;

      for (const level of levels) {
        if (stopped || aborted) {
          this.skipLevel(level, phaseResults, completedPhases);
          continue;
        }

        const eligible = this.filterEligible(level, input, phaseResults, completedPhases);
        if (eligible.length === 0) continue;

        const levelResults = await this.executePhasesParallel(eligible, input, maxParallel, control);
        const behavior = this.processLevelResults(levelResults, onFailure, phaseResults, completedPhases, allRecommendations);

        if (behavior === 'stop') stopped = true;
        if (behavior === 'abort') aborted = true;
      }
    } catch (error) {
      // A phase that threw was never appended to phaseResults — the single-phase level
      // deliberately does not contain its error (an all-failed workflow must throw). But
      // the error IS carrying that phase's crash placeholders with their billedMetrics, so
      // recover them here rather than losing them. Without this, the more work a run had
      // completed before failing, the more it lost: prior phases reported no tokens and no
      // cost at all.
      const carried = extractPartialCommands(error);
      const recovered = carried.length > 0
        ? [...phaseResults, {
            id: 'failed', name: 'Failed phase', decision: 'blocked' as const,
            commands: carried, gateThreshold: DEFAULT_GATE_THRESHOLD,
            score: null,
            // The carried commands DID run and DID bill, so this phase consumed real
            // wall-clock; sum what they measured rather than reporting 0.
            // FABRICATION-OK: summing MEASURED per-command durations; the `|| 0` guards a child that reported
            // none, and durationMs is a required number so absence cannot propagate.
            durationMs: carried.reduce((sum, c) => sum + (c.metrics.durationMs || 0), 0),
            error: formatErrorMessage(error),
          } as PhaseResult]
        : phaseResults;
      throw new WorkflowError(
        `Workflow failed: ${formatErrorMessage(error)}`,
        { partialResult: this.buildPartialResult(def, recovered, allRecommendations, startTime, resolved.hash) },
      );
    }

    const aggregated = this.aggregate(def.workflow.aggregation, phaseResults);
    const durationMs = Date.now() - startTime;
    const tokenTotals = sumTokenMetrics(phaseResults.flatMap(p => p.commands.map(c => c.metrics)));

    return {
      type: 'workflow',
      name: def.workflow.interface.name,
      version: def.workflow.interface.version,
      definitionHash: resolved.hash,
      minSubscription: resolved.minSubscription,
      decision: aggregated.decision,
      decisionCategory: aggregated.decisionCategory,
      score: aggregated.score,
      extractionConfidence: worstExtractionConfidence(phaseResults.flatMap(p => p.commands)),
      phases: phaseResults,
      recommendations: this.deduplicateRecommendations(allRecommendations),
      durationMs,
      metrics: {
        ...tokenTotals,
        // A BLOCKED phase carries `commands: []` (createBlockedPhase), so flat-mapping
        // over commands dropped it from the roll-up entirely — indistinguishable from a
        // SKIPPED phase, which contributes nothing because nothing ran. But a phase is
        // blocked by a thrown error, which can land AFTER its commands have already
        // billed, so the survivors' partial sum was being presented as the total. Give a
        // command-less blocked phase an explicitly unpriced child and the roll-up degrades
        // to undefined — the worst-child polarity sumCostUsd's contract mandates. Skipped
        // phases still contribute nothing.
        costUsd: sumCostUsd(phaseResults.flatMap((p): Array<Pick<CommandMetrics, 'costUsd'>> =>
          p.commands.length > 0
            ? p.commands.map(c => c.metrics)
            : p.decision === 'blocked' ? [{ costUsd: undefined }] : [],
        )),
        durationMs,
        model: 'mixed',
        ...phaseResults.reduce((acc, p) => {
          if (p.decision !== 'skipped' && p.decision !== 'aborted') acc.phasesExecuted++;
          if (p.decision === 'passed') acc.phasesPassed++;
          if (p.decision === 'warned') acc.phasesWarned++;
          if (p.decision === 'blocked') acc.phasesBlocked++;
          if (p.decision === 'skipped') acc.phasesSkipped++;
          if (p.decision === 'aborted') acc.phasesAborted++;
          return acc;
        }, { phasesExecuted: 0, phasesPassed: 0, phasesWarned: 0, phasesBlocked: 0, phasesSkipped: 0, phasesAborted: 0 }),
        commands: phaseResults.flatMap(p =>
          p.commands.map(c => ({
            name: c.name,
            score: c.score ?? null, // preserve null for scoreless commands (no fabricated 0)
            decision: c.decision,
            inputTokens: c.metrics.inputTokens,
            outputTokens: c.metrics.outputTokens,
            cacheCreationTokens: c.metrics.cacheCreationTokens,
            cacheReadTokens: c.metrics.cacheReadTokens,
            totalEffectiveTokens: c.metrics.totalEffectiveTokens,
            durationMs: c.metrics.durationMs,
            costUsd: c.metrics.costUsd,
          })),
        ),
      },
    };
  }

  /**
   * Mark all phases in a level as skipped (used when stopped or aborted).
   */
  private skipLevel(
    level: PhaseDefinition[],
    phaseResults: PhaseResult[],
    completedPhases: Map<string, PhaseResult>,
  ): void {
    for (const phase of level) {
      const skipped = this.createSkippedPhase(phase);
      phaseResults.push(skipped);
      completedPhases.set(phase.id, skipped);
    }
  }

  /**
   * Filter a level to phases whose dependencies are satisfied and skip_if is not met.
   */
  private filterEligible(
    level: PhaseDefinition[],
    input: ExecutionInput,
    phaseResults: PhaseResult[],
    completedPhases: Map<string, PhaseResult>,
  ): PhaseDefinition[] {
    const eligible: PhaseDefinition[] = [];
    for (const phase of level) {
      if (phase.skip_if && this.evaluateCondition(phase.skip_if, input, phaseResults)) {
        const skipped = this.createSkippedPhase(phase);
        phaseResults.push(skipped);
        completedPhases.set(phase.id, skipped);
        continue;
      }
      if (!this.checkDependencies(phase.depends_on, completedPhases)) {
        const skipped = this.createSkippedPhase(phase);
        phaseResults.push(skipped);
        completedPhases.set(phase.id, skipped);
        continue;
      }
      eligible.push(phase);
    }
    return eligible;
  }

  /**
   * Record level results and apply failure behavior. Returns the triggered
   * behavior ('stop' | 'abort') or undefined if execution should continue.
   */
  private processLevelResults(
    levelResults: PhaseResult[],
    onFailure: WorkflowDefinition['workflow']['orchestration']['on_failure'],
    phaseResults: PhaseResult[],
    completedPhases: Map<string, PhaseResult>,
    allRecommendations: Recommendation[],
  ): 'stop' | 'abort' | undefined {
    let behavior: 'stop' | 'abort' | undefined;

    for (const phaseResult of levelResults) {
      phaseResults.push(phaseResult);
      completedPhases.set(phaseResult.id, phaseResult);

      for (const cmd of phaseResult.commands) {
        allRecommendations.push(...cmd.recommendations);
      }

      if (phaseResult.decision === 'blocked') {
        switch (onFailure) {
          case 'stop':
            behavior = 'stop';
            break;
          case 'abort':
            behavior = 'abort';
            break;
          case 'warn':
            phaseResult.decision = 'warned';
            break;
          case 'continue':
          default:
            break;
        }
      }
    }

    return behavior;
  }

  /**
   * Execute a set of independent phases in parallel.
   *
   * Respects max_parallel concurrency limit if set. Uses Promise.allSettled
   * to ensure partial failures don't reject the entire level.
   */
  private async executePhasesParallel(
    phases: PhaseDefinition[],
    input: ExecutionInput,
    maxParallel?: number,
    control?: { abortSignal?: AbortSignal },
  ): Promise<PhaseResult[]> {
    if (phases.length === 1) {
      // Single phase — no need for concurrency machinery, and DELIBERATELY no containment.
      //
      // Reviewed 2026-08-24 and left throwing. A one-phase level that fails has no
      // survivor, so the workflow genuinely failed and must not report a decision as
      // though it ran; three tests pin that contract. The asymmetry a review flagged here
      // — one-phase level throws, two-phase level returns — is real but is NOT this line:
      // it was that the resulting throw discarded every PRIOR level's completed work,
      // because buildPartialResult carried no metrics and no score. That is fixed there,
      // which keeps the contract and stops the loss.
      return [await this.executePhase(phases[0]!, input, control)];
    }

    if (maxParallel && maxParallel > 0 && maxParallel < phases.length) {
      // Semaphore-limited concurrency
      return this.executePhasesWithLimit(phases, input, maxParallel, control);
    }

    // Unlimited parallel — all phases in this level run concurrently
    const settled = await Promise.allSettled(
      phases.map(phase => this.executePhase(phase, input, control)),
    );

    const results: PhaseResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        // Phase threw — create a blocked result preserving error context
        results.push(this.createBlockedPhase(phases[i]!, outcome.reason));
      }
    }
    return results;
  }

  /**
   * Execute phases with a concurrency semaphore.
   */
  private async executePhasesWithLimit(
    phases: PhaseDefinition[],
    input: ExecutionInput,
    limit: number,
    control?: { abortSignal?: AbortSignal },
  ): Promise<PhaseResult[]> {
    const results: PhaseResult[] = new Array(phases.length);
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (nextIndex < phases.length) {
        const idx = nextIndex++;
        const phase = phases[idx]!;
        try {
          results[idx] = await this.executePhase(phase, input, control);
        } catch (error) {
          results[idx] = this.createBlockedPhase(phase, error);
        }
      }
    };

    const workers = Array.from({ length: Math.min(limit, phases.length) }, () => runNext());
    await Promise.all(workers);
    return results;
  }

  private async executePhase(phase: PhaseDefinition, input: ExecutionInput, control?: { abortSignal?: AbortSignal }): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const commandResults: CommandResult[] = [];
    // Phase-scoped, not branch-scoped: "every step failed" is a property of the PHASE,
    // not of how it dispatched. Declaring it inside the parallel arm is part of how the
    // two branches drifted apart.
    const errors: string[] = [];

    // Collect all step executables: command refs + agent refs
    type StepRef = { type: 'command' | 'agent'; ref: string };
    const stepRefs: StepRef[] = [
      ...phase.commands.map(ref => ({ type: 'command' as const, ref })),
      ...(phase.agentRefs ?? []).map(ref => ({ type: 'agent' as const, ref })),
    ];

    if (phase.parallel) {
      const settled = await Promise.allSettled(
        stepRefs.map(step => this.executeStep(step.type, step.ref, input, control)),
      );
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j]!;
        if (outcome.status === 'fulfilled') {
          commandResults.push(outcome.value);
        } else {
          const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          errors.push(errorMsg);
          commandResults.push(this.stepCrashPlaceholder(stepRefs[j]!.ref, outcome.reason));
        }
      }

    } else {
      // FAIL-FAST but not lossy — the same correction made to CommandExecutor's
      // sequential branch. This loop had no containment while its parallel sibling above
      // used allSettled + a crash placeholder, so a throw here escaped executePhase,
      // discarded every step that had already run and billed, and left the phase as
      // createBlockedPhase's `commands: []` — which then compounded the fabricated-score
      // defect in that same object. Two branches of one method, one hardened.
      for (const step of stepRefs) {
        try {
          commandResults.push(await this.executeStep(step.type, step.ref, input, control));
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          commandResults.push(this.stepCrashPlaceholder(step.ref, error));
          break;
        }
      }
    }

    // Governs BOTH branches. It previously sat inside the parallel arm, which is part of
    // why the two diverged: "every step failed" is a property of the phase, not of how the
    // phase happened to dispatch. A phase where SOME steps succeeded keeps their billed
    // work and fails through the gate; a phase where none did still throws, so
    // single-step phases behave exactly as before.
    if (errors.length > 0 && commandResults.length === errors.length) {
      throw new WorkflowError(
        `All steps in phase "${phase.name}" failed: ${errors.join('; ')}`,
        { partialResult: commandResults },
      );
    }

    const aggregateScore = this.aggregatePhaseScore(
      commandResults,
      phase.gate?.aggregate ?? 'average',
    );

    let decision = this.evaluateGate(aggregateScore, phase.gate);
    // Scoreless children have no channel into the score gate: aggregatePhaseScore
    // drops them, and an all-scoreless phase yields score null → evaluateGate
    // passes unconditionally. Mirror CommandExecutor.aggregateResults — a
    // scoreless child whose decision resolves negative gates the phase
    // categorically, honoring the phase's declared failure posture (on_fail).
    if (decision === 'passed' &&
        commandResults.some(r => r.score == null && resolveDecisionCategory(r, this.warnUnclassified) === 'negative')) {
      decision = phase.gate?.on_fail === 'warn' ? 'warned' : 'blocked';
    }
    // Scored-lens-negative cap (issue d60c2ea2, decision 2026-07-10) — the
    // CommandExecutor twin: a scored child whose decision resolves negative
    // (DISORDERED@82) caps a passed phase at 'warned'. Never an unqualified
    // pass, never a hard block — see CommandExecutor.aggregateResults for the
    // full rationale.
    if (decision === 'passed' &&
        commandResults.some(r => r.score != null && resolveDecisionCategory(r, this.warnUnclassified) === 'negative')) {
      decision = 'warned';
    }

    return {
      id: phase.id,
      name: phase.name,
      decision,
      commands: commandResults,
      gateThreshold: phase.gate?.threshold ?? DEFAULT_GATE_THRESHOLD,
      score: aggregateScore,
      durationMs: Date.now() - phaseStart,
    };
  }

  /**
   * Execute a step by type. Agent refs are run directly via AgentExecutor
   * (wrapped as CommandResult). Command refs go through CommandExecutor,
   * with automatic fallback to AgentExecutor when a command ref resolves
   * to an agent definition (common in WDLs that use command: for agents).
   */
  private async executeStep(type: 'command' | 'agent', ref: string, input: ExecutionInput, control?: { abortSignal?: AbortSignal }): Promise<CommandResult> {
    const [name, version] = parseRef(ref);

    if (type === 'agent') {
      return this.executeAgentRef(name, version, ref, input, control);
    }

    // Command ref — a WDL `command:` step may name a command OR an agent, and a
    // single name can exist as BOTH (an agent and its per-agent invocation
    // command, e.g. `aristotle-analyst`). An untyped resolve THROWS on that
    // collision ("Multiple definitions named X found"), which previously blocked
    // every cognitive-lens workflow. Resolve the command first; fall back to the
    // agent definition only when no command by that name exists. This preserves
    // the documented `command:`→agent support without the ambiguity throw.
    let resolved: ResolvedDefinition;
    try {
      resolved = await this.registry.resolve(name, version, 'command');
    } catch (error) {
      if (error instanceof ConfigurationError) {
        resolved = await this.registry.resolve(name, version, 'agent');
      } else {
        throw error;
      }
    }
    if (resolved.type === 'agent') {
      // WDL used command: but definition is actually an agent — route directly
      return this.executeAgentDirect(resolved, input, ref, control);
    }
    return this.commandExecutor.execute(resolved, input, { abortSignal: control?.abortSignal });
  }

  private async executeAgentRef(name: string, version: string | undefined, ref: string, input: ExecutionInput, control?: { abortSignal?: AbortSignal }): Promise<CommandResult> {
    if (!this.agentExecutor) {
      throw new WorkflowError(
        `Phase references agent "${ref}" but no AgentExecutor is available`,
        { partialResult: undefined },
      );
    }
    const resolved = await this.registry.resolve(name, version, 'agent');
    return this.executeAgentDirect(resolved, input, ref, control);
  }

  private async executeAgentDirect(resolved: ResolvedDefinition, input: ExecutionInput, ref: string, control?: { abortSignal?: AbortSignal }): Promise<CommandResult> {
    if (!this.agentExecutor) {
      throw new WorkflowError(
        `Phase references agent "${ref}" but no AgentExecutor is available`,
        { partialResult: undefined },
      );
    }
    const agentResult = await this.agentExecutor.execute(resolved, input, { abortSignal: control?.abortSignal });
    return this.wrapAgentResult(agentResult, resolved);
  }

  /**
   * Wrap an AgentResult as a CommandResult for uniform phase aggregation.
   * Intentionally thinner than CommandExecutor.wrapAgentResult — omits threshold,
   * categories, and artifacts which are not needed for phase-level aggregation.
   */
  private wrapAgentResult(agent: AgentResult, resolved: ResolvedDefinition): CommandResult {
    return {
      type: 'command',
      name: agent.name,
      version: resolved.version,
      definitionHash: resolved.hash,
      agentType: (resolved.agentType ?? 'analyst') as CommandResult['agentType'],
      decision: agent.decision,
      decisionCategory: agent.decisionCategory,
      score: agent.score,
      maxScore: agent.maxScore,
      extractionConfidence: agent.extractionConfidence,
      recommendations: agent.recommendations,
      durationMs: agent.metrics.durationMs,
      // FABRICATION-OK: summing a count of events; see CommandExecutor.
      metrics: { ...agent.metrics, toolCalls: agent.metrics.toolCallCount ?? 0 },
    } as CommandResult;
  }

  /**
   * Diverges from the shared `aggregateScores` util in exactly ONE case, deliberately.
   *
   * They now AGREE on "commands ran, none scored" — both return `null`, which fail-opens at
   * the gate (resolved 2026-08-24; the util used to return a fabricated 0 that blocked).
   *
   * They still differ on the EMPTY case, and that is the point: this method sees the phase
   * definition, so it can tell an AUTHORED-empty phase (`commands: []` — nothing was asked
   * for, which is suspicious and must block at 0) from a phase whose commands all came back
   * scoreless. The util sees neither, because callers hand it a shaped array; it therefore
   * declines to guess and returns null for both. See the note in `utils/aggregateScores.ts`.
   */
  private aggregatePhaseScore(results: CommandResult[], method: 'average' | 'min' | 'max'): number | null {
    // 0 here is DELIBERATE and is not a fabricated zero — reviewed and kept 2026-08-24.
    // An AUTHORED-empty phase (`commands: []` in the definition) must BLOCK at its gate
    // rather than pass unexamined, and returning 0 is how that is enforced; two tests pin
    // it ('phase with empty commands array returns score 0', 'empty commands phase with
    // gate blocks at threshold').
    //
    // Distinguish it from the case C1 fixed: a phase that CRASHED also arrives with no
    // commands, but its score is set to null at createBlockedPhase, above, so it is
    // excluded from the workflow average instead of dragging it down. Authored-empty means
    // "nothing was asked for and that is suspicious"; crashed means "something was asked
    // for and we do not know the answer". Same shape, opposite correct answers.
    if (results.length === 0) return 0;
    const scoredResults = results.filter(r => r.score != null);
    if (scoredResults.length === 0) return null;
    const scores = scoredResults.map(r => r.score!);

    switch (method) {
      case 'min': return Math.min(...scores);
      case 'max': return Math.max(...scores);
      case 'average':
      default:
        return scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  private evaluateGate(
    score: number | null,
    gate?: PhaseDefinition['gate'],
  ): 'passed' | 'warned' | 'blocked' {
    if (!gate) return 'passed';
    if (score === null) return 'passed';
    if (score >= gate.threshold) return 'passed';
    if (gate.on_fail === 'warn') return 'warned';
    return 'blocked';
  }

  private aggregate(
    config: WorkflowDefinition['workflow']['aggregation'],
    phases: PhaseResult[],
  ): { decision: WorkflowDecision; decisionCategory: DecisionCategory; score: number | null } {
    const scorable = phases.filter(
      p => p.decision !== 'skipped' && p.decision !== 'aborted',
    );
    const method = config?.score?.method ?? 'weighted_average';

    // Same split as aggregatePhaseScore, one level up, and for the same reason: this layer
    // holds the definition, so it can tell the two empty cases apart where the util cannot.
    //
    //   phases: []      AUTHORED-empty workflow — nothing was asked for. Scores 0, so a
    //                   nested workflow-ref stage with a threshold FAILS its parent gate
    //                   instead of passing unexamined. Sibling of PipelineExecutor's G5
    //                   check ("hard gates must not silently pass unexecuted"). Pinned by
    //                   'empty phases array produces SHIP with score 0'.
    //   nothing scorable  Phases ran or were skipped and none produced a score. That is a
    //                   scoring gap, not a failure, and aggregateScores reports it as null.
    //
    // The skipped/aborted filter above already encodes the second half of that: those
    // phases are excluded so they cannot drag the average toward 0. Flooring the result to
    // 0 anyway, which is what the util used to do, undid the exclusion it had just made.
    const score = phases.length === 0
      ? 0
      : aggregateScores(
        scorable.map(p => ({ key: p.id, score: p.score })),
        method,
        config?.score?.weights,
      );

    const hasBlocked = phases.some(p => p.decision === 'blocked');
    const hasWarned = phases.some(p => p.decision === 'warned');
    const hasAborted = phases.some(p => p.decision === 'aborted');

    // The category is derived from the phase outcomes, not the decision string —
    // WDL aggregation.decision config can remap SHIP/HOLD/BLOCK to arbitrary
    // strings, which downstream classifyDecision cannot recognize. Carrying the
    // category alongside keeps remapped vocabularies gateable (e.g. by
    // PipelineExecutor.computeDecision for workflow-ref stages).
    let decision: WorkflowDecision;
    let decisionCategory: DecisionCategory;
    if (hasBlocked || hasAborted) {
      decision = config?.decision?.BLOCK ?? 'BLOCK';
      decisionCategory = 'negative';
    } else if (hasWarned) {
      decision = config?.decision?.HOLD ?? 'HOLD';
      decisionCategory = 'conditional';
    } else {
      decision = config?.decision?.SHIP ?? 'SHIP';
      decisionCategory = 'positive';
    }

    return { decision, decisionCategory, score };
  }

  /**
   * The placeholder a crashed step becomes. ONE construction, shared by the parallel and
   * sequential branches of executePhase — see the sequential branch for why they diverged.
   */
  private stepCrashPlaceholder(ref: string, reason: unknown): CommandResult {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    return {
      type: 'command',
      name: ref,
      // No definition backs this result — the step crashed before its
      // definition could even be resolved. '1.0.0-synthesized' is deliberately
      // non-parseable as a real release, so downstream consumers
      // (SubmissionClient's realVersion) can tell it apart from an actual
      // 1.0.0 release instead of putting an empty string on the wire.
      version: '1.0.0-synthesized',
      definitionHash: '',
      agentType: 'validator',
      decision: 'FAIL',
      // Crashed step — no agent ran, so no score. Null pair, not fabricated 0/100.
      score: null,
      maxScore: null,
      recommendations: [{
        title: `Step execution failed: ${ref}`,
        description: errorMsg,
        severity: 'critical',
        failureCode: 'PRA-FRA/C',
      }],
      // Read from the metrics below rather than asserted as 0. The previous waiver here
      // said "nothing ran, so no time elapsed" — false of this object from the moment
      // `crashMetrics` was wired in two lines down, since a MaxStepsExhaustedError carries
      // a REAL measured durationMs. The literal contradicted its own sibling.
      //
      // Note the shape: an identical waiver on createBlockedPhase was corrected earlier in
      // this same release as "a waiver whose reason the code had already outgrown", and
      // this sibling was left. Same text, same file, fifty lines apart.
      durationMs: crashMetrics(reason).durationMs,
      // See crashMetrics: billed usage survives the throw; absent cost stays absent.
      // The zeros are DEFAULTS, applied under the spread rather than over it, so a
      // MaxStepsExhaustedError's measured toolCallCount survives — writing them after the
      // spread overwrote the real count on the run class that by construction made the
      // most tool calls.
      // FABRICATION-OK: these are DEFAULTS UNDER the spread, so a MaxStepsExhaustedError's measured
      // toolCallCount overrides them. Writing them after the spread was the bug.
      metrics: { toolCallCount: 0, toolCalls: 0, ...crashMetrics(reason) },
    } as CommandResult;
  }

  private createBlockedPhase(phase: PhaseDefinition, error?: unknown): PhaseResult {
    // Recover the step results the thrown error is carrying. executePhase throws
    // `WorkflowError(…, { partialResult: commandResults })` where those placeholders hold
    // real `billedMetrics` from crashMetrics — and this catch was replacing them with
    // `commands: []`, so the billedMetrics channel this release added was severed one
    // layer above every site that populates it. Measured: an all-crashed workflow reported
    // totalEffectiveTokens 0 while the caught error held 49,000 effective tokens.
    //
    // costUsd already degraded honestly to undefined; it was the TOKEN total that was a
    // fabricated zero, because the two roll-ups have deliberately opposite polarities.
    const carried = extractPartialCommands(error);
    return {
      id: phase.id,
      name: phase.name,
      decision: 'blocked',
      commands: carried,
      gateThreshold: phase.gate?.threshold ?? DEFAULT_GATE_THRESHOLD,
      // NULL, not 0. A phase that THREW produced no score; a fabricated 0 enters the
      // weighted average and drags the workflow's reported quality down by an amount
      // proportional to how many phases crashed. Measured: one real phase scoring 90
      // beside one thrown phase reported 45.
      //
      // `aggregate()` filters 'skipped' and 'aborted' but NOT 'blocked' — the crash case
      // — so this literal was the whole defect. The PipelineExecutor sibling guards the
      // identical situation and explains why in an eight-line comment
      // (PipelineExecutor.ts, `successResults`): discriminate on score NULLITY, never on
      // the decision string, because a legitimately-evaluated {decision:'FAIL', score:0}
      // is a real worst-case score that must stay in the average.
      //
      // Recorded because of where it was found: the release before this one fixed
      // `commands: []` in this same object literal for the cost roll-up, wrote a
      // positive-control test for it, and left `score: 0` two lines below untouched. The
      // citation was fixed; the class was not.
      score: null,
      // NOT zero-by-default: `commands: carried` above are exactly the commands that DID
      // run and DID bill, so this phase consumed real time. The previous waiver here
      // asserted "nothing ran, so no time elapsed", which was false of this object from
      // the moment the recovery was added two lines above it — a waiver whose reason the
      // code had already outgrown.
      // FABRICATION-OK: summing MEASURED per-command durations; the `|| 0` guards a child that reported
            // none, and durationMs is a required number so absence cannot propagate.
      durationMs: carried.reduce((sum, c) => sum + (c.metrics.durationMs || 0), 0),
      ...(error ? { error: formatErrorMessage(error) } : {}),
    };
  }

  private createSkippedPhase(phase: PhaseDefinition): PhaseResult {
    return {
      id: phase.id,
      name: phase.name,
      decision: 'skipped',
      commands: [],
      gateThreshold: phase.gate?.threshold ?? DEFAULT_GATE_THRESHOLD,
      // NULL — a phase that never ran produced no score. It is filtered from the
      // aggregate either way, but it is externally visible on `result.phases[]`, where a
      // 0 reads as a measured failure. The sibling literal 11 lines up was corrected in
      // the previous commit and this one was left; same object shape, same file.
      score: null,
      // FABRICATION-OK: nothing ran, so no time elapsed — 0 is the MEASURED duration of a
      // non-event, not an unknown standing in for one.
      durationMs: 0,
    };
  }

  private checkDependencies(
    dependsOn: string[] | undefined,
    completedPhases: Map<string, PhaseResult>,
  ): boolean {
    if (!dependsOn || dependsOn.length === 0) return true;
    return dependsOn.every(depId => {
      const dep = completedPhases.get(depId);
      return dep && dep.decision !== 'blocked' && dep.decision !== 'aborted';
    });
  }

  private evaluateCondition(
    condition: string,
    input: ExecutionInput,
    _phases: PhaseResult[],
  ): boolean {
    // Handle NOT(...) wrapper (produced by WDL condition → skip_if normalization)
    const notMatch = condition.match(/^NOT\s*\((.+)\)$/);
    if (notMatch?.[1]) {
      return !this.evaluateCondition(notMatch[1].trim(), input, _phases);
    }

    // {{ input.X }} — template-style references
    const templateMatch = condition.match(/\{\{\s*input\.(\w+)\s*\}\}/);
    if (templateMatch?.[1]) return Boolean(input.options?.[templateMatch[1]]);

    // arguments.X — WDL-style references (underscore-normalized: with_hume → with-hume)
    const argMatch = condition.match(/^arguments\.(\w+)$/);
    if (argMatch?.[1]) {
      const key = argMatch[1];
      // Try exact key first, then hyphenated variant (with_hume → with-hume)
      return Boolean(input.options?.[key] ?? input.options?.[key.replace(/_/g, '-')]);
    }

    return false;
  }

  private deduplicateRecommendations(recommendations: Recommendation[]): Recommendation[] {
    const seen = new Set<string>();
    return recommendations.filter(r => {
      // Include agent name in key so cross-agent convergence is preserved.
      // Two agents finding the same issue at the same location is evidence
      // of convergence — collapsing it would destroy multi-lens signal.
      const key = `${r.agent}|${r.title}|${r.filePath ?? ''}|${r.lineNumber ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private assertWorkflowDefinition(resolved: ResolvedDefinition): WorkflowDefinition {
    if (resolved.type !== 'workflow') {
      throw new WorkflowError(
        `WorkflowExecutor received a '${resolved.type}' definition (expected 'workflow')`,
        { partialResult: undefined },
      );
    }
    // The runtime check above narrows the discriminated union — no cast (a9d65912).
    return resolved.definition;
  }

  private buildPartialResult(
    def: WorkflowDefinition,
    phases: PhaseResult[],
    recommendations: Recommendation[],
    startTime: number,
    hash: string,
  ): Partial<WorkflowResult> {
    const durationMs = Date.now() - startTime;
    // Carry what the completed phases actually billed. This previously returned phases
    // and recommendations only, so a workflow that threw reported NO metrics and NO score
    // — every prior level's tokens and cost vanished with the throw, and the more work a
    // run had completed before failing, the more it lost. The billedMetrics channel this
    // release added terminated here.
    //
    // Same roll-up shape as the success path, including its deliberate polarity split:
    // tokens coalesce, cost degrades to undefined if any child is unpriced.
    const commandMetrics = phases.flatMap(p => p.commands.map(c => c.metrics));
    return {
      type: 'workflow',
      name: def.workflow.interface.name,
      definitionHash: hash,
      phases,
      recommendations,
      durationMs,
      score: aggregateScores(phases.map(p => ({ key: p.id, score: p.score }))),
      metrics: {
        ...sumTokenMetrics(commandMetrics),
        costUsd: sumCostUsd(commandMetrics),
        durationMs,
        model: 'mixed',
      } as WorkflowResult['metrics'],
    };
  }
}
