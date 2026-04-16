import type { AgentExecutor } from './AgentExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import { runPreflightChecks } from './preflight.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { CommandDefinition } from '../types/command.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import type { CommandResult, CommandMetrics } from '../types/command.js';
import type { AgentResult } from '../types/agent.js';
import { ExecutionError } from '../errors/index.js';
import { parseRef } from '../utils/parseRef.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_WARN_THRESHOLD } from '../constants.js';

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
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<CommandResult> {
    const startTime = Date.now();
    if (resolved.type !== 'command') {
      throw new ExecutionError(`CommandExecutor received a '${resolved.type}' definition (expected 'command')`);
    }
    const def = resolved.definition as CommandDefinition;

    // 1. Run preflight checks
    if (def.command.execution.preflight) {
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
        model: def.command.execution.model.default,
        timeoutMs: def.command.execution.timeout,
        thresholds: def.command.execution.thresholds,
      });

      return this.wrapAgentResult(agentResult, def, resolved.hash, startTime);
    }

    // 4. Multi-agent: execute each and aggregate
    const executeAgent = async (ref: string): Promise<AgentResult> => {
      const [name, version] = parseRef(ref);
      const agentResolved = await this.registry.resolve(name, version, 'agent');
      return this.agentExecutor.execute(agentResolved, input, {
        model: def.command.execution.model.default,
        timeoutMs: def.command.execution.timeout,
      });
    };

    const agentResults: AgentResult[] = def.command.execution.sequential === false
      ? await this.executeParallel(agentRefs, executeAgent)
      : await this.executeSequentially(agentRefs, executeAgent);

    return this.aggregateResults(
      agentResults,
      def,
      resolved.hash,
      startTime,
      def.command.aggregation ?? { method: 'average' },
    );
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
  ): Promise<AgentResult[]> {
    const settled = await Promise.allSettled(refs.map(fn));
    const results: AgentResult[] = [];
    const errors: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      }
    }

    if (results.length === 0) {
      throw new Error(`All parallel agents failed: ${errors.join('; ')}`);
    }

    return results;
  }

  /**
   * Wrap a single agent result as a CommandResult
   */
  private wrapAgentResult(
    agentResult: AgentResult,
    def: CommandDefinition,
    hash: string,
    startTime: number,
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
      agentType: agentResult.agentType,
      decision: agentResult.decision,
      score: agentResult.score,
      maxScore: agentResult.maxScore,
      threshold: def.command.execution.thresholds?.pass,
      categories: agentResult.categories?.map(c => ({
        name: c.name,
        score: c.score,
        maxScore: c.maxScore,
        findings: c.findings,
      })),
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
    aggregation: { method: string; weights?: Record<string, number> },
  ): CommandResult {
    const durationMs = Date.now() - startTime;

    // Collect all recommendations
    const recommendations: Recommendation[] = results.flatMap(r => r.recommendations);

    // Aggregate scores from all scored agents
    const scoredResults = results.filter(r => r.score !== undefined);

    let score: number | undefined;
    let maxScore: number | undefined;

    if (scoredResults.length > 0) {
      const scores = scoredResults.map(r => r.score);

      switch (aggregation.method) {
        case 'min':
          score = Math.min(...scores);
          break;
        case 'max':
          score = Math.max(...scores);
          break;
        case 'sum':
          score = scores.reduce((a, b) => a + b, 0);
          break;
        case 'weighted_average': {
          const weights = aggregation.weights ?? {};
          let totalWeight = 0;
          let weightedSum = 0;
          for (const r of scoredResults) {
            const w = weights[r.name] ?? 1;
            totalWeight += w;
            weightedSum += r.score * w;
          }
          score = totalWeight > 0 ? weightedSum / totalWeight : 0;
          break;
        }
        case 'average':
        default:
          score = scores.reduce((a, b) => a + b, 0) / scores.length;
      }

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
