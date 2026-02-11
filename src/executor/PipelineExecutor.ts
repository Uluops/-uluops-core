import type { CommandExecutor } from './CommandExecutor.js';
import type { WorkflowExecutor } from './WorkflowExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { PipelineDefinition, StageDefinition, PipelineResult, StageResult, PipelineState, PipelineHandle as IPipelineHandle } from '../types/pipeline.js';
import type { ExecutionInput } from '../types/execution.js';
import { PipelineError } from '../errors/index.js';
import { parseRef } from '../utils/parseRef.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';

/**
 * Executes pipelines with multi-stage orchestration and async support.
 *
 * Handles stage dependency resolution, conditional execution,
 * mix of workflow and command stages, and state tracking.
 */
export class PipelineExecutor {
  constructor(
    private workflowExecutor: WorkflowExecutor,
    private commandExecutor: CommandExecutor,
    private registry: RegistryClient,
  ) {}

  /**
   * Start pipeline execution asynchronously.
   * Returns a PipelineHandle for monitoring progress and retrieving results.
   */
  async start(resolved: ResolvedDefinition, input: ExecutionInput): Promise<PipelineHandle> {
    const def = resolved.definition as PipelineDefinition;
    const pipelineId = `pipeline_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const state: PipelineState = {
      pipelineId,
      definitionVersion: def.pipeline.interface.version,
      definitionHash: resolved.hash,
      status: 'running',
      currentStageIndex: 0,
      stageResults: [],
      startTime: Date.now(),
    };

    // Start execution in background, capturing errors into state
    const execution = this.executeAsync(resolved, input, state);
    execution.catch((error) => {
      if (state.status === 'running') {
        state.status = 'failed';
        state.error = formatErrorMessage(error);
      }
    });

    return new PipelineHandle(pipelineId, state, execution);
  }

  /**
   * Execute pipeline synchronously (blocking).
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<PipelineResult> {
    const handle = await this.start(resolved, input);
    return handle.wait(10); // Very short poll for sync mode
  }

  private async executeAsync(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    state: PipelineState,
  ): Promise<void> {
    const def = resolved.definition as PipelineDefinition;

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

        // Evaluate skip condition
        if (stage.skip_if && this.evaluateCondition(stage.skip_if, state.stageResults)) {
          state.stageResults.push(this.createSkippedStage(stage, 'skip_if_true'));
          continue;
        }

        // Execute stage
        const stageResult = await this.executeStage(stage, input);
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

  private async executeStage(stage: StageDefinition, input: ExecutionInput): Promise<StageResult> {
    const [refName, refVersion] = parseRef(stage.ref);
    const resolved = await this.registry.resolve(refName, refVersion, stage.type);
    const startTime = Date.now();

    try {
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
        type: stage.type,
        status: 'failed',
        skipReason: formatErrorMessage(error),
        durationMs: Date.now() - startTime,
      };
    }
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

    if (!match) return false;

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

  private createSkippedStage(stage: StageDefinition, reason: string): StageResult {
    return {
      id: stage.id,
      name: stage.name,
      type: stage.type,
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
      );
    }

    return result;
  }

  async cancel(): Promise<void> {
    if (this.isComplete()) {
      throw new PipelineError(
        `Pipeline ${this.executionId} is already complete (status: ${this.state.status})`,
      );
    }
    this.state.status = 'cancelled';
    this.state.error = 'Pipeline cancelled by user';
  }

  private buildResult(): PipelineResult {
    const durationMs = Date.now() - this.state.startTime;

    const stageScores = this.state.stageResults
      .map(s => s.result?.score)
      .filter((score): score is number => score !== undefined);

    const score = stageScores.length > 0
      ? stageScores.reduce((a, b) => a + b, 0) / stageScores.length
      : 0;

    const recommendations = this.state.stageResults
      .flatMap(s => s.result?.recommendations ?? []);

    const decision = this.computeDecision();

    return {
      type: 'pipeline',
      name: this.state.pipelineId,
      version: this.state.definitionVersion,
      definitionHash: this.state.definitionHash,
      decision,
      score,
      durationMs,
      status: this.state.status === 'completed' ? 'complete' : this.state.status as PipelineResult['status'],
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
        stagesExecuted: this.state.stageResults.filter(s => s.status === 'completed').length,
        stagesPassed: this.state.stageResults.filter(s => {
          const d = s.result?.decision;
          return d === 'PASS' || d === 'SHIP' || d === 'COMPLETE';
        }).length,
        stagesFailed: this.state.stageResults.filter(s => {
          const d = s.result?.decision;
          return d === 'FAIL' || d === 'BLOCK' || d === 'FAILED';
        }).length,
        stagesSkipped: this.state.stageResults.filter(s => s.status === 'skipped').length,
      },
    };
  }

  private computeDecision(): string {
    if (this.state.status === 'cancelled') return 'CANCELLED';
    if (this.state.status === 'failed') return 'FAIL';

    const hasFailures = this.state.stageResults.some(s => {
      const d = s.result?.decision;
      return d === 'FAIL' || d === 'FAILED' || d === 'BLOCK';
    });
    if (hasFailures) return 'FAIL';

    const hasWarnings = this.state.stageResults.some(s => {
      const d = s.result?.decision;
      return d === 'WARN' || d === 'HOLD';
    });
    if (hasWarnings) return 'WARN';

    return 'PASS';
  }
}
