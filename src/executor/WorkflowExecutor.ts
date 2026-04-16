import type { CommandExecutor } from './CommandExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { WorkflowDefinition, WorkflowResult, PhaseResult, PhaseDefinition, WorkflowDecision } from '../types/workflow.js';
import type { CommandResult } from '../types/command.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import { WorkflowError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { DEFAULT_GATE_THRESHOLD } from '../constants.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { topoGroupLevels } from '../utils/topoSort.js';

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
  ) {}

  /**
   * Execute a workflow with DAG-based phase orchestration.
   *
   * Phases are grouped into topological levels. All phases in a level
   * whose dependencies are satisfied execute in parallel. Gate evaluation
   * occurs after each phase completes, and failure behavior determines
   * whether subsequent levels proceed.
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
      decision: aggregated.decision,
      score: aggregated.score,
      phases: phaseResults,
      recommendations: this.deduplicateRecommendations(allRecommendations),
      durationMs,
      metrics: {
        ...tokenTotals,
        durationMs,
        model: 'mixed',
        phasesExecuted: phaseResults.filter(p => p.decision !== 'skipped' && p.decision !== 'aborted').length,
        phasesPassed: phaseResults.filter(p => p.decision === 'passed').length,
        phasesWarned: phaseResults.filter(p => p.decision === 'warned').length,
        phasesBlocked: phaseResults.filter(p => p.decision === 'blocked').length,
        phasesSkipped: phaseResults.filter(p => p.decision === 'skipped').length,
        phasesAborted: phaseResults.filter(p => p.decision === 'aborted').length,
        commands: phaseResults.flatMap(p =>
          p.commands.map(c => ({
            name: c.name,
            score: c.score ?? 0,
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

    async function runNext(executor: WorkflowExecutor): Promise<void> {
      while (nextIndex < phases.length) {
        const idx = nextIndex++;
        const phase = phases[idx]!;
        try {
          results[idx] = await executor.executePhase(phase, input);
        } catch (error) {
          results[idx] = executor.createBlockedPhase(phase, error);
        }
      }
    }

    const workers = Array.from({ length: Math.min(limit, phases.length) }, () => runNext(this));
    await Promise.all(workers);
    return results;
  }

  private async executePhase(phase: PhaseDefinition, input: ExecutionInput): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const commandResults: CommandResult[] = [];

    if (phase.parallel) {
      const settled = await Promise.allSettled(
        phase.commands.map(cmdName => this.executeCommand(cmdName, input)),
      );
      const errors: string[] = [];
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j]!;
        if (outcome.status === 'fulfilled') {
          commandResults.push(outcome.value);
        } else {
          const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          errors.push(errorMsg);
          // Failed commands contribute a zero-score result so they penalize the aggregate.
          // Error context is preserved in recommendations so it surfaces in the phase result.
          commandResults.push({
            type: 'command',
            name: phase.commands[j]!,
            version: '',
            definitionHash: '',
            agentType: 'validator',
            decision: 'FAIL',
            score: 0,
            maxScore: 100,
            recommendations: [{
              title: `Command execution failed: ${phase.commands[j]!}`,
              description: errorMsg,
              severity: 'critical',
              failureCode: 'PRA-FRA/C',
            }],
            durationMs: 0,
            metrics: { inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 0, model: 'unknown', toolCalls: 0 },
          } as CommandResult);
        }
      }
      if (errors.length > 0 && commandResults.length === errors.length) {
        throw new WorkflowError(
          `All parallel commands in phase "${phase.name}" failed: ${errors.join('; ')}`,
          { partialResult: commandResults },
        );
      }
    } else {
      for (const cmdName of phase.commands) {
        const result = await this.executeCommand(cmdName, input);
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

  private async executeCommand(cmdName: string, input: ExecutionInput): Promise<CommandResult> {
    const resolved = await this.registry.resolve(cmdName);
    return this.commandExecutor.execute(resolved, input);
  }

  private aggregatePhaseScore(results: CommandResult[], method: 'average' | 'min' | 'max'): number {
    if (results.length === 0) return 0;
    const scores = results.map(r => r.score ?? 0);

    switch (method) {
      case 'min': return Math.min(...scores);
      case 'max': return Math.max(...scores);
      case 'average':
      default:
        return scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  private evaluateGate(
    score: number,
    gate?: PhaseDefinition['gate'],
  ): 'passed' | 'warned' | 'blocked' {
    if (!gate) return 'passed';
    if (score >= gate.threshold) return 'passed';
    if (gate.on_fail === 'warn') return 'warned';
    return 'blocked';
  }

  private aggregate(
    config: WorkflowDefinition['workflow']['aggregation'],
    phases: PhaseResult[],
  ): { decision: WorkflowDecision; score: number } {
    const scorable = phases.filter(
      p => p.decision !== 'skipped' && p.decision !== 'aborted',
    );
    const scores = scorable.map(p => p.score);
    const method = config?.score?.method ?? 'weighted_average';

    let score: number;
    switch (method) {
      case 'min':
        score = scores.length > 0 ? Math.min(...scores) : 0;
        break;
      case 'max':
        score = scores.length > 0 ? Math.max(...scores) : 0;
        break;
      case 'sum':
        score = scores.reduce((a, b) => a + b, 0);
        break;
      case 'weighted_average': {
        const weights = config?.score?.weights ?? {};
        let totalWeight = 0;
        let weightedSum = 0;
        for (const phase of scorable) {
          const w = weights[phase.id] ?? 1;
          totalWeight += w;
          weightedSum += phase.score * w;
        }
        score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
        break;
      }
      case 'average':
      default:
        score = scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0;
    }

    const hasBlocked = phases.some(p => p.decision === 'blocked');
    const hasWarned = phases.some(p => p.decision === 'warned');
    const hasAborted = phases.some(p => p.decision === 'aborted');

    let decision: WorkflowDecision;
    if (hasBlocked || hasAborted) {
      decision = config?.decision?.BLOCK ?? 'BLOCK';
    } else if (hasWarned) {
      decision = config?.decision?.HOLD ?? 'HOLD';
    } else {
      decision = config?.decision?.SHIP ?? 'SHIP';
    }

    return { decision, score };
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
    const match = condition.match(/\{\{\s*input\.(\w+)\s*\}\}/);
    if (match?.[1]) return Boolean(input.options?.[match[1]]);
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
