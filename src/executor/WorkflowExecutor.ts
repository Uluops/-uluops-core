import type { CommandExecutor } from './CommandExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { WorkflowDefinition, WorkflowResult, PhaseResult, PhaseDefinition } from '../types/workflow.js';
import type { CommandResult } from '../types/command.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import { WorkflowError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';

/**
 * Executes workflows with multi-phase orchestration.
 *
 * Handles phase dependency resolution, gate threshold evaluation,
 * score aggregation across phases, recommendation deduplication,
 * and failure handling (stop vs continue).
 */
export class WorkflowExecutor {
  constructor(
    private commandExecutor: CommandExecutor,
    private registry: RegistryClient,
  ) {}

  /**
   * Execute a workflow with phase orchestration
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<WorkflowResult> {
    const startTime = Date.now();
    const def = resolved.definition as WorkflowDefinition;
    const phaseResults: PhaseResult[] = [];
    const allRecommendations: Recommendation[] = [];

    try {
      for (const phase of def.workflow.orchestration.phases) {
        // Check skip condition
        if (phase.skip_if && this.evaluateCondition(phase.skip_if, input, phaseResults)) {
          phaseResults.push(this.createSkippedPhase(phase));
          continue;
        }

        // Check dependencies
        if (!this.checkDependencies(phase.depends_on, phaseResults)) {
          phaseResults.push(this.createSkippedPhase(phase));
          continue;
        }

        // Execute phase
        const phaseResult = await this.executePhase(phase, input);
        phaseResults.push(phaseResult);

        // Accumulate recommendations
        for (const cmd of phaseResult.commands) {
          allRecommendations.push(...cmd.recommendations);
        }

        // Check gate
        if (
          phaseResult.decision === 'blocked' &&
          def.workflow.orchestration.on_failure === 'stop'
        ) {
          break;
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
        phasesExecuted: phaseResults.filter(p => p.decision !== 'skipped').length,
        phasesPassed: phaseResults.filter(p => p.decision === 'passed').length,
        phasesWarned: phaseResults.filter(p => p.decision === 'warned').length,
        phasesBlocked: phaseResults.filter(p => p.decision === 'blocked').length,
        phasesSkipped: phaseResults.filter(p => p.decision === 'skipped').length,
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

  private async executePhase(phase: PhaseDefinition, input: ExecutionInput): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const commandResults: CommandResult[] = [];

    if (phase.parallel) {
      const results = await Promise.all(
        phase.commands.map(cmdName => this.executeCommand(cmdName, input)),
      );
      commandResults.push(...results);
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
      if (phase.decision === 'skipped') continue;
      const weight = weights[phase.id] ?? 1;
      totalWeight += weight;
      weightedScore += phase.score * weight;
    }

    const score = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;

    const hasBlocked = phases.some(p => p.decision === 'blocked');
    const hasWarned = phases.some(p => p.decision === 'warned');

    let decision: string;
    if (hasBlocked) {
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

  private checkDependencies(dependsOn: string[] | undefined, completedPhases: PhaseResult[]): boolean {
    if (!dependsOn || dependsOn.length === 0) return true;
    return dependsOn.every(depId => {
      const dep = completedPhases.find(p => p.id === depId);
      return dep && dep.decision !== 'blocked';
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
