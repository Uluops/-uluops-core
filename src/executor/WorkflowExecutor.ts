import type { AgentExecutor } from './AgentExecutor.js';
import type { CommandExecutor } from './CommandExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { WorkflowDefinition, WorkflowResult, PhaseResult, PhaseDefinition, WorkflowDecision } from '../types/workflow.js';
import type { CommandResult } from '../types/command.js';
import type { AgentResult } from '../types/agent.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import { WorkflowError, ConfigurationError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { DEFAULT_GATE_THRESHOLD } from '../constants.js';
import { aggregateScores } from '../utils/aggregateScores.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { topoGroupLevels } from '../utils/topoSort.js';
import { parseRef } from '../utils/parseRef.js';
import type { DecisionCategory } from './classifyDecision.js';

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
export class WorkflowExecutor {
  constructor(
    private commandExecutor: CommandExecutor,
    private registry: RegistryClient,
    private agentExecutor?: AgentExecutor,
  ) {}

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
   * @throws {WorkflowError} on internal workflow failures (phase crashes, gate violations)
   * @throws {ConfigurationError} if the definition is not a valid workflow
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<WorkflowResult> {
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

        const levelResults = await this.executePhasesParallel(eligible, input, maxParallel);
        const behavior = this.processLevelResults(levelResults, onFailure, phaseResults, completedPhases, allRecommendations);

        if (behavior === 'stop') stopped = true;
        if (behavior === 'abort') aborted = true;
      }
    } catch (error) {
      throw new WorkflowError(
        `Workflow failed: ${formatErrorMessage(error)}`,
        { partialResult: this.buildPartialResult(def, phaseResults, allRecommendations, startTime, resolved.hash) },
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
      phases: phaseResults,
      recommendations: this.deduplicateRecommendations(allRecommendations),
      durationMs,
      metrics: {
        ...tokenTotals,
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
  ): Promise<PhaseResult[]> {
    if (phases.length === 1) {
      // Single phase — no need for concurrency machinery
      return [await this.executePhase(phases[0]!, input)];
    }

    if (maxParallel && maxParallel > 0 && maxParallel < phases.length) {
      // Semaphore-limited concurrency
      return this.executePhasesWithLimit(phases, input, maxParallel);
    }

    // Unlimited parallel — all phases in this level run concurrently
    const settled = await Promise.allSettled(
      phases.map(phase => this.executePhase(phase, input)),
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
  ): Promise<PhaseResult[]> {
    const results: PhaseResult[] = new Array(phases.length);
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (nextIndex < phases.length) {
        const idx = nextIndex++;
        const phase = phases[idx]!;
        try {
          results[idx] = await this.executePhase(phase, input);
        } catch (error) {
          results[idx] = this.createBlockedPhase(phase, error);
        }
      }
    };

    const workers = Array.from({ length: Math.min(limit, phases.length) }, () => runNext());
    await Promise.all(workers);
    return results;
  }

  private async executePhase(phase: PhaseDefinition, input: ExecutionInput): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const commandResults: CommandResult[] = [];

    // Collect all step executables: command refs + agent refs
    type StepRef = { type: 'command' | 'agent'; ref: string };
    const stepRefs: StepRef[] = [
      ...phase.commands.map(ref => ({ type: 'command' as const, ref })),
      ...(phase.agentRefs ?? []).map(ref => ({ type: 'agent' as const, ref })),
    ];

    if (phase.parallel) {
      const settled = await Promise.allSettled(
        stepRefs.map(step => this.executeStep(step.type, step.ref, input)),
      );
      const errors: string[] = [];
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j]!;
        if (outcome.status === 'fulfilled') {
          commandResults.push(outcome.value);
        } else {
          const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          errors.push(errorMsg);
          commandResults.push({
            type: 'command',
            name: stepRefs[j]!.ref,
            version: '',
            definitionHash: '',
            agentType: 'validator',
            decision: 'FAIL',
            // Crashed step — no agent ran, so no score. Null pair, not fabricated 0/100.
            score: null,
            maxScore: null,
            recommendations: [{
              title: `Step execution failed: ${stepRefs[j]!.ref}`,
              description: errorMsg,
              severity: 'critical',
              failureCode: 'PRA-FRA/C',
            }],
            durationMs: 0,
            metrics: { inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 0, model: 'unknown', toolCallCount: 0, toolCalls: 0 },
          } as CommandResult);
        }
      }
      if (errors.length > 0 && commandResults.length === errors.length) {
        throw new WorkflowError(
          `All steps in phase "${phase.name}" failed: ${errors.join('; ')}`,
          { partialResult: commandResults },
        );
      }
    } else {
      for (const step of stepRefs) {
        const result = await this.executeStep(step.type, step.ref, input);
        commandResults.push(result);
      }
    }

    const aggregateScore = this.aggregatePhaseScore(
      commandResults,
      phase.gate?.aggregate ?? 'average',
    );

    const decision = this.evaluateGate(aggregateScore, phase.gate);

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
  private async executeStep(type: 'command' | 'agent', ref: string, input: ExecutionInput): Promise<CommandResult> {
    const [name, version] = parseRef(ref);

    if (type === 'agent') {
      return this.executeAgentRef(name, version, ref, input);
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
      return this.executeAgentDirect(resolved, input, ref);
    }
    return this.commandExecutor.execute(resolved, input);
  }

  private async executeAgentRef(name: string, version: string | undefined, ref: string, input: ExecutionInput): Promise<CommandResult> {
    if (!this.agentExecutor) {
      throw new WorkflowError(
        `Phase references agent "${ref}" but no AgentExecutor is available`,
        { partialResult: undefined },
      );
    }
    const resolved = await this.registry.resolve(name, version, 'agent');
    return this.executeAgentDirect(resolved, input, ref);
  }

  private async executeAgentDirect(resolved: ResolvedDefinition, input: ExecutionInput, ref: string): Promise<CommandResult> {
    if (!this.agentExecutor) {
      throw new WorkflowError(
        `Phase references agent "${ref}" but no AgentExecutor is available`,
        { partialResult: undefined },
      );
    }
    const agentResult = await this.agentExecutor.execute(resolved, input);
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
      recommendations: agent.recommendations,
      durationMs: agent.metrics.durationMs,
      metrics: { ...agent.metrics, toolCalls: agent.metrics.toolCallCount ?? 0 },
    } as CommandResult;
  }

  private aggregatePhaseScore(results: CommandResult[], method: 'average' | 'min' | 'max'): number | null {
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
  ): { decision: WorkflowDecision; decisionCategory: DecisionCategory; score: number } {
    const scorable = phases.filter(
      p => p.decision !== 'skipped' && p.decision !== 'aborted',
    );
    const method = config?.score?.method ?? 'weighted_average';

    const score = aggregateScores(
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

  private createBlockedPhase(phase: PhaseDefinition, error?: unknown): PhaseResult {
    return {
      id: phase.id,
      name: phase.name,
      decision: 'blocked',
      commands: [],
      gateThreshold: phase.gate?.threshold ?? DEFAULT_GATE_THRESHOLD,
      score: 0,
      durationMs: 0,
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
      score: 0,
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
    return resolved.definition as WorkflowDefinition;
  }

  private buildPartialResult(
    def: WorkflowDefinition,
    phases: PhaseResult[],
    recommendations: Recommendation[],
    startTime: number,
    hash: string,
  ): Partial<WorkflowResult> {
    return {
      type: 'workflow',
      name: def.workflow.interface.name,
      definitionHash: hash,
      phases,
      recommendations,
      durationMs: Date.now() - startTime,
    };
  }
}
