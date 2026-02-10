import type { AgentExecutor } from './AgentExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import { runPreflightChecks } from './preflight.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { CommandDefinition } from '../types/command.js';
import type { ExecutionInput, Recommendation } from '../types/execution.js';
import type { CommandResult, CommandMetrics } from '../types/command.js';
import type { AgentResult, ValidatorAgentResult } from '../types/agent.js';
import { parseRef } from '../utils/parseRef.js';

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
    const agentResults: AgentResult[] = [];

    for (const ref of agentRefs) {
      const [name, version] = parseRef(ref);
      const agentResolved = await this.registry.resolve(name, version, 'agent');

      const result = await this.agentExecutor.execute(agentResolved, input, {
        model: def.command.execution.model.default,
        timeoutMs: def.command.execution.timeout,
      });

      agentResults.push(result);
    }

    return this.aggregateResults(
      agentResults,
      def,
      resolved.hash,
      startTime,
      def.command.aggregation ?? { method: 'average' },
    );
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
      toolCalls: 0, // Not tracked at command level for single-agent
    };

    const base = {
      type: 'command' as const,
      name: def.command.interface.name,
      version: def.command.interface.version,
      definitionHash: hash,
      agentType: agentResult.agentType,
      decision: agentResult.decision,
      threshold: def.command.execution.thresholds?.pass,
      recommendations: agentResult.recommendations,
      durationMs,
      metrics,
    };

    if (agentResult.agentType === 'validator') {
      return {
        ...base,
        score: agentResult.score,
        maxScore: agentResult.maxScore,
        categories: agentResult.categories?.map(c => ({
          name: c.name,
          score: c.score,
          maxPoints: c.maxScore,
          findings: c.findings,
        })),
      };
    }

    return { ...base, artifacts: agentResult.artifacts };
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

    // Aggregate scores (for validators)
    const validatorResults = results.filter(
      (r): r is ValidatorAgentResult => r.agentType === 'validator',
    );

    let score: number | undefined;
    let maxScore: number | undefined;

    if (validatorResults.length > 0) {
      const scores = validatorResults.map(r => r.score);

      switch (aggregation.method) {
        case 'min':
          score = Math.min(...scores);
          break;
        case 'max':
          score = Math.max(...scores);
          break;
        case 'weighted_average': {
          const weights = aggregation.weights ?? {};
          let totalWeight = 0;
          let weightedSum = 0;
          for (const r of validatorResults) {
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

      maxScore = Math.max(...validatorResults.map(r => r.maxScore ?? 100));
    }

    // Determine overall decision
    const threshold = def.command.execution.thresholds?.pass ?? 70;
    const warnThreshold = def.command.execution.thresholds?.warn ?? 50;
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
    const metrics: CommandMetrics = {
      inputTokens: results.reduce((sum, r) => sum + r.metrics.inputTokens, 0),
      outputTokens: results.reduce((sum, r) => sum + r.metrics.outputTokens, 0),
      cacheCreationTokens: results.reduce((sum, r) => sum + (r.metrics.cacheCreationTokens ?? 0), 0),
      cacheReadTokens: results.reduce((sum, r) => sum + (r.metrics.cacheReadTokens ?? 0), 0),
      totalEffectiveTokens: results.reduce((sum, r) => sum + r.metrics.totalEffectiveTokens, 0),
      durationMs,
      model: 'mixed',
      toolCalls: 0,
    };

    return {
      type: 'command',
      name: def.command.interface.name,
      version: def.command.interface.version,
      definitionHash: hash,
      agentType: validatorResults.length > 0 ? 'validator' : 'executor',
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
