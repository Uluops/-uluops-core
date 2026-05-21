import type { AgentExecutor } from './AgentExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import { runPreflightChecks } from './preflight.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { CommandDefinition } from '../types/command.js';
import type { ExecutionInput, Recommendation, SubscriptionTier } from '../types/execution.js';
import type { CommandResult, CommandMetrics } from '../types/command.js';
import type { AgentResult } from '../types/agent.js';
import { ExecutionError } from '../errors/index.js';
import { parseRef } from '../utils/parseRef.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_WARN_THRESHOLD } from '../constants.js';
import { mapCategory } from './mapCategory.js';
import { aggregateScores, type AggregationMethod } from '../utils/aggregateScores.js';

/**
 * Executes command definitions.
 *
 * - Single-agent commands: delegates to AgentExecutor
 * - Multi-agent commands: runs agents in sequence, aggregates results
 *
 * Handles preflight checks, model/threshold overrides from command definition,
 * and multi-agent score aggregation.
 */
export class CommandExecutor {
  constructor(
    private agentExecutor: AgentExecutor,
    private registry: RegistryClient,
  ) {}

  /**
   * Execute a command definition
   */
  async execute(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    overrides?: { model?: string },
  ): Promise<CommandResult> {
    const startTime = Date.now();
    if (resolved.type !== 'command') {
      throw new ExecutionError(`CommandExecutor received a '${resolved.type}' definition (expected 'command')`);
    }
    const def = resolved.definition as CommandDefinition;

    // Model resolution: operator override > CDL default
    const model = overrides?.model ?? def.command.execution.model.default;

    // 1. Run preflight checks
    if (def.command.execution?.preflight) {
      await runPreflightChecks(def.command.execution.preflight, input);
    }

    // 2. Resolve referenced agents
    const agentRefs = def.command.agents;

    // 3. Single-agent: delegate to AgentExecutor
    if (agentRefs.length === 1) {
      const ref = agentRefs[0];
      if (!ref) throw new Error('Agent refs array is empty despite length check');
      const [name, version] = parseRef(ref);
      const agentResolved = await this.registry.resolve(name, version, 'agent');

      const agentResult = await this.agentExecutor.execute(agentResolved, input, {
        model,
        timeoutMs: def.command.execution.timeout,
        thresholds: def.command.execution.thresholds,
      });

      return this.wrapAgentResult(agentResult, def, resolved.hash, startTime, resolved.minSubscription);
    }

    // 4. Multi-agent: execute each and aggregate
    const executeAgent = async (ref: string): Promise<AgentResult> => {
      const [name, version] = parseRef(ref);
      const agentResolved = await this.registry.resolve(name, version, 'agent');
      return this.agentExecutor.execute(agentResolved, input, {
        model,
        timeoutMs: def.command.execution.timeout,
      });
    };

    let agentResults: AgentResult[];
    let agentErrors: string[] = [];

    if (def.command.execution.sequential === false) {
      const parallel = await this.executeParallel(agentRefs, executeAgent);
      agentResults = parallel.results;
      agentErrors = parallel.agentErrors;
    } else {
      agentResults = await this.executeSequentially(agentRefs, executeAgent);
    }

    const result = this.aggregateResults(
      agentResults,
      def,
      resolved.hash,
      startTime,
      def.command.aggregation ?? { method: 'average' },
      resolved.minSubscription,
    );

    // Surface partial failures as critical recommendations so consumers see them
    if (agentErrors.length > 0) {
      const errorRecs: Recommendation[] = agentErrors.map(msg => ({
        title: msg,
        priority: 'critical' as const,
        severity: 'critical' as const,
        file_paths: [],
      }));
      result.recommendations = [...errorRecs, ...result.recommendations];
    }

    return result;
  }

  private async executeSequentially(
    refs: string[],
    fn: (ref: string) => Promise<AgentResult>,
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    for (const ref of refs) {
      results.push(await fn(ref));
    }
    return results;
  }

  private async executeParallel(
    refs: string[],
    fn: (ref: string) => Promise<AgentResult>,
  ): Promise<{ results: AgentResult[]; agentErrors: string[] }> {
    const settled = await Promise.allSettled(refs.map(fn));
    const results: AgentResult[] = [];
    const agentErrors: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        const ref = refs[i]!;
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        agentErrors.push(`Agent ${ref} failed: ${msg}`);
      }
    }

    if (results.length === 0) {
      throw new ExecutionError(`All parallel agents failed: ${agentErrors.join('; ')}`);
    }

    return { results, agentErrors };
  }

  /**
   * Wrap a single agent result as a CommandResult.
   *
   * DIVERGENCE NOTE: Three sites convert AgentResult → CommandResult with intentionally
   * different field sets. A shared helper was considered but rejected because the field
   * differences are not parameterizable without making the helper harder to understand
   * than the three inline implementations:
   *
   * - CommandExecutor.wrapAgentResult (HERE): Full conversion — includes threshold,
   *   categories (mapped), artifacts, minSubscription. Used when a command wraps a
   *   single agent and the full result metadata is available from the definition.
   *
   * - WorkflowExecutor.wrapAgentResult: Thin conversion — omits threshold, categories,
   *   artifacts. Used for phase-level aggregation where only score/decision/recommendations
   *   matter. The workflow doesn't have per-agent command definitions to pull thresholds from.
   *
   * - PipelineExecutor (inline): Aggregating conversion — combines multiple AgentResults
   *   into one CommandResult per stage (averaged score, flattened recommendations, summed
   *   metrics). Structurally different from single-agent wrapping.
   *
   * If a new field is added to AgentResult that must propagate to CommandResult, update
   * all three sites. Search for "wrapAgentResult" to find them.
   */
  private wrapAgentResult(
    agentResult: AgentResult,
    def: CommandDefinition,
    hash: string,
    startTime: number,
    minSubscription?: SubscriptionTier,
  ): CommandResult {
    const durationMs = Date.now() - startTime;

    const metrics: CommandMetrics = {
      ...agentResult.metrics,
      durationMs,
      toolCalls: agentResult.metrics.toolCallCount ?? 0,
    };

    return {
      type: 'command' as const,
      name: def.command.interface.name,
      version: def.command.interface.version,
      definitionHash: hash,
      minSubscription,
      agentType: agentResult.agentType,
      decision: agentResult.decision,
      score: agentResult.score,
      maxScore: agentResult.maxScore,
      threshold: def.command.execution.thresholds?.pass,
      categories: agentResult.categories?.map(mapCategory),
      artifacts: agentResult.artifacts,
      recommendations: agentResult.recommendations,
      durationMs,
      metrics,
    };
  }

  /**
   * Aggregate multiple agent results into a single CommandResult
   */
  private aggregateResults(
    results: AgentResult[],
    def: CommandDefinition,
    hash: string,
    startTime: number,
    aggregation: { method: AggregationMethod; weights?: Record<string, number> },
    minSubscription?: SubscriptionTier,
  ): CommandResult {
    const durationMs = Date.now() - startTime;

    // Collect all recommendations
    const recommendations: Recommendation[] = results.flatMap(r => r.recommendations);

    // Aggregate scores from all scored agents
    const scoredResults = results.filter(r => r.score !== undefined);

    let score: number | undefined;
    let maxScore: number | undefined;

    if (scoredResults.length > 0) {
      score = aggregateScores(
        scoredResults.map(r => ({ key: r.name, score: r.score })),
        aggregation.method,
        aggregation.weights,
      );

      maxScore = Math.max(...scoredResults.map(r => r.maxScore ?? 100));
    }

    // Determine overall decision
    const threshold = def.command.execution.thresholds?.pass ?? DEFAULT_PASS_THRESHOLD;
    const warnThreshold = def.command.execution.thresholds?.warn ?? DEFAULT_WARN_THRESHOLD;
    let decision: string;

    if (score !== undefined) {
      if (score >= threshold) decision = 'PASS';
      else if (score >= warnThreshold) decision = 'WARN';
      else decision = 'FAIL';
    } else {
      const failed = results.some(r => r.decision === 'FAILED');
      const partial = results.some(r => r.decision === 'PARTIAL');
      decision = failed ? 'FAILED' : partial ? 'PARTIAL' : 'COMPLETE';
    }

    // Aggregate metrics
    const totalToolCalls = results.reduce((sum, r) => sum + (r.metrics.toolCallCount ?? 0), 0);
    const metrics: CommandMetrics = {
      ...sumTokenMetrics(results.map(r => r.metrics)),
      durationMs,
      model: 'mixed',
      toolCalls: totalToolCalls,
    };

    return {
      type: 'command',
      name: def.command.interface.name,
      version: def.command.interface.version,
      definitionHash: hash,
      minSubscription,
      agentType: results[0]?.agentType ?? 'validator',
      decision,
      score,
      maxScore,
      threshold,
      recommendations,
      durationMs,
      metrics,
    };
  }
}
