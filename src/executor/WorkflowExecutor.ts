import type { CommandExecutor } from './CommandExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { WorkflowDefinition, WorkflowResult, PhaseResult, PhaseDefinition } from '../types/workflow.js';
import type { CommandResult } from '../types/command.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import { WorkflowError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
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
    const def = resolved.definition as WorkflowDefinition;
    const phaseResults: PhaseResult[] = [];
    const allRecommendations: Recommendation[] = [];
    const completedPhases = new Map<string, PhaseResult>();

    try {
      const levels = topoGroupLevels(def.workflow.orchestration.phases);
      const onFailure = def.workflow.orchestration.on_failure;
      const maxParallel = def.workflow.orchestration.max_parallel;
      let stopped = false;
      let aborted = false;

      for (const level of levels) {
        if (stopped || aborted) {
          // Mark remaining phases as skipped
          for (const phase of level) {
            const skipped = this.createSkippedPhase(phase);
            phaseResults.push(skipped);
            completedPhases.set(phase.id, skipped);
          }
          continue;
        }

        // Filter level to phases whose dependencies are satisfied and skip_if is not met
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

        if (eligible.length === 0) continue;

        // Execute eligible phases in parallel (with optional concurrency limit)
        const levelResults = await this.executePhasesParallel(eligible, input, maxParallel);

        // Process results and evaluate gates
        for (const phaseResult of levelResults) {
          phaseResults.push(phaseResult);
          completedPhases.set(phaseResult.id, phaseResult);

          // Accumulate recommendations
          for (const cmd of phaseResult.commands) {
            allRecommendations.push(...cmd.recommendations);
          }

          // Apply failure behavior based on gate result
          if (phaseResult.decision === 'blocked') {
            switch (onFailure) {
              case 'stop':
                stopped = true;
                break;
              case 'abort':
                aborted = true;
                break;
              case 'warn':
                // Downgrade to warned — proceed without blocking
                phaseResult.decision = 'warned';
                break;
              case 'continue':
              default:
                // Continue — dependent phases will check deps naturally
                break;
            }
          }
        }

        // For abort: mark any phases from this level that haven't completed
        // (in practice all completed since we awaited, but semantically distinct
        // from stop in that we don't start the next level either)
        if (aborted) {
          // Remaining levels will be skipped in the next iteration
          continue;
        }
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
            durationMs: c.metrics.durationMs,
            costUsd: c.metrics.costUsd,
          })),
        ),
      },
    };
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
        // Phase threw — create a blocked result with error info
        results.push({
          id: phases[i]!.id,
          name: phases[i]!.name,
          decision: 'blocked',
          commands: [],
          gateThreshold: phases[i]!.gate?.threshold ?? 70,
          score: 0,
          durationMs: 0,
        });
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
        } catch {
          results[idx] = {
            id: phase.id,
            name: phase.name,
            decision: 'blocked',
            commands: [],
            gateThreshold: phase.gate?.threshold ?? 70,
            score: 0,
            durationMs: 0,
          };
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
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          commandResults.push(outcome.value);
        } else {
          errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
        }
      }
      if (errors.length > 0 && commandResults.length === 0) {
        throw new Error(`All parallel commands in phase "${phase.name}" failed: ${errors.join('; ')}`);
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
      gateThreshold: phase.gate?.threshold ?? 70,
      score: aggregateScore,
      durationMs: Date.now() - phaseStart,
    };
  }

  private async executeCommand(cmdName: string, input: ExecutionInput): Promise<CommandResult> {
    const resolved = await this.registry.resolve(cmdName);
    return this.commandExecutor.execute(resolved, input);
  }

  private aggregatePhaseScore(results: CommandResult[], method: string): number {
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
  ): { decision: string; score: number } {
    const weights = config?.score?.weights ?? {};
    let totalWeight = 0;
    let weightedScore = 0;

    for (const phase of phases) {
      if (phase.decision === 'skipped' || phase.decision === 'aborted') continue;
      const weight = weights[phase.id] ?? 1;
      totalWeight += weight;
      weightedScore += phase.score * weight;
    }

    const score = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;

    const hasBlocked = phases.some(p => p.decision === 'blocked');
    const hasWarned = phases.some(p => p.decision === 'warned');
    const hasAborted = phases.some(p => p.decision === 'aborted');

    let decision: string;
    if (hasBlocked || hasAborted) {
      decision = config?.decision?.BLOCK ?? 'BLOCK';
    } else if (hasWarned) {
      decision = config?.decision?.HOLD ?? 'HOLD';
    } else {
      decision = config?.decision?.SHIP ?? 'SHIP';
    }

    return { decision, score };
  }

  private createSkippedPhase(phase: PhaseDefinition): PhaseResult {
    return {
      id: phase.id,
      name: phase.name,
      decision: 'skipped',
      commands: [],
      gateThreshold: phase.gate?.threshold ?? 70,
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
      const key = `${r.title}|${r.filePath ?? ''}|${r.lineNumber ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
