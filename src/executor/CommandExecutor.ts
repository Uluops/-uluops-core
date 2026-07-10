import type { AgentExecutor } from './AgentExecutor.js';
import type { RegistryClient } from '../registry/RegistryClient.js';
import { runPreflightChecks } from './preflight.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { CommandDefinition } from '../types/command.js';
import type { ExecutionInput, Recommendation, SubscriptionTier } from '../types/execution.js';
import type { CommandResult, CommandMetrics } from '../types/command.js';
import type { AgentResult } from '../types/agent.js';
import { ExecutionError } from '../errors/index.js';
import type { Logger } from '@uluops/sdk-core';
import { parseRef } from '../utils/parseRef.js';
import { sumTokenMetrics } from '../utils/sumTokenMetrics.js';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_WARN_THRESHOLD } from '../constants.js';
import { mapCategory } from './mapCategory.js';
import { resolveDecisionCategory, type DecisionCategory } from './classifyDecision.js';
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
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export class CommandExecutor {
  private logger: Logger;

  /**
   * Gate-boundary tripwire (issue 3e74bc69): a non-empty decision that is
   * neither stamped nor in the core register resolves 'neutral' and silently
   * non-gates — reachable only for foreign/downlevel (0.29.x, hand-built)
   * results, since in-process producers always stamp decisionCategory.
   */
  private warnUnclassified = (decision: string): void => {
    this.logger.warn(
      `Decision "${decision.slice(0, 80)}" has no stamped decisionCategory and is not in the core register — ` +
      `resolving 'neutral' (non-gating). A custom-vocabulary negative from a pre-0.30 producer would not gate here.`,
    );
  };

  constructor(
    private agentExecutor: AgentExecutor,
    private registry: RegistryClient,
    logger?: Logger,
  ) {
    this.logger = logger ?? noopLogger;
  }

  /**
   * Execute a command definition against a target.
   *
   * Runs preflight checks (if any), resolves the referenced agent(s), and
   * either delegates to {@link AgentExecutor} (single-agent) or aggregates
   * across agents (multi-agent) per the command's aggregation method.
   *
   * @param resolved - Registry-resolved command definition (must have `type: 'command'`).
   * @param input - Execution input; `target` is the absolute project path.
   * @param overrides - Optional runtime overrides; `model` wins over the definition's default model.
   * @returns The aggregated {@link CommandResult} with per-agent scores, decision, and recommendations.
   * @throws {ExecutionError} If the resolved definition is not a command.
   * @throws {PreflightError} If a preflight check fails before agents run.
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
      if (!ref) throw new ExecutionError('Agent refs array is empty despite length check');
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

    if (def.command.execution.sequential === false) {
      agentResults = await this.executeParallel(agentRefs, executeAgent);
    } else {
      agentResults = await this.executeSequentially(agentRefs, executeAgent);
    }

    return this.aggregateResults(
      agentResults,
      def,
      resolved.hash,
      startTime,
      def.command.aggregation ?? { method: 'average' },
      resolved.minSubscription,
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

  /**
   * Execute agent refs in parallel. A crashed agent is synthesized as a
   * negative-category, null-score placeholder result (issue 77febff2, decision
   * 2026-07-10): the scoreless-negative guard in aggregateResults then fails
   * the command, restoring crash-parity with sequential mode's fail-fast while
   * keeping the survivors' work. Same pattern as PipelineExecutor's inline
   * agents and WorkflowExecutor's parallel steps — a gate that could not run
   * its full panel must not emit an unqualified positive.
   */
  private async executeParallel(
    refs: string[],
    fn: (ref: string) => Promise<AgentResult>,
  ): Promise<AgentResult[]> {
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
        results.push({
          name: ref,
          agentType: 'validator',
          decision: 'FAIL',
          decisionCategory: 'negative',
          // Crashed agent — no agent ran, so no score. Null pair, not fabricated 0/100.
          score: null,
          maxScore: null,
          recommendations: [{
            title: `Agent ${ref} failed: ${msg}`,
            priority: 'critical',
            severity: 'critical',
            failureCode: 'PRA-FRA/C',
          }],
          metrics: { inputTokens: 0, outputTokens: 0, totalEffectiveTokens: 0, durationMs: 0, model: 'unknown' },
        } as AgentResult);
      }
    }

    if (agentErrors.length === refs.length) {
      throw new ExecutionError(`All parallel agents failed: ${agentErrors.join('; ')}`);
    }

    return results;
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
      decisionCategory: agentResult.decisionCategory,
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
    // Only score-bearing results aggregate. Scoreless (generator/executor) results have
    // score === null and are excluded — so the command score is the average over real
    // scores (not dragged toward 0), and an all-scoreless command stays unscored.
    const scoredResults = results.filter(r => r.score != null);

    let score: number | undefined;
    let maxScore: number | undefined;

    if (scoredResults.length > 0) {
      score = aggregateScores(
        scoredResults.map(r => ({ key: r.name, score: r.score })),
        aggregation.method,
        aggregation.weights,
      );

      // Filter null scales (invariant: scored results have a scale, but be defensive);
      // undefined when none present — never fabricate 100.
      const presentMax = scoredResults.map(r => r.maxScore).filter((m): m is number => m != null);
      maxScore = presentMax.length === 0 ? undefined : Math.max(...presentMax);
    }

    // Determine overall decision
    const threshold = def.command.execution.thresholds?.pass ?? DEFAULT_PASS_THRESHOLD;
    const warnThreshold = def.command.execution.thresholds?.warn ?? DEFAULT_WARN_THRESHOLD;
    let decision: string;
    let decisionCategory: DecisionCategory;

    if (score !== undefined) {
      if (score >= threshold) { decision = 'PASS'; decisionCategory = 'positive'; }
      else if (score >= warnThreshold) { decision = 'WARN'; decisionCategory = 'conditional'; }
      else { decision = 'FAIL'; decisionCategory = 'negative'; }
      // Scoreless children have no channel into the aggregate score, so their
      // negative completions must gate here or they are silently swallowed —
      // a passing scored validator must not mask a scoreless executor's failure.
      if (decisionCategory !== 'negative' &&
          results.some(r => r.score == null && resolveDecisionCategory(r, this.warnUnclassified) === 'negative')) {
        decision = 'FAIL';
        decisionCategory = 'negative';
      }
      // Scored-lens-negative cap (issue d60c2ea2, decision 2026-07-10): a scored
      // child whose vocabulary-declared decision resolves negative (DISORDERED@82)
      // caps the command at WARN — it can never launder into an unqualified PASS
      // through the score average, but it does not hard-fail either: lens verdicts
      // are characterizations, and hard-failing every passing-score negative would
      // institutionalize alarm fatigue (same rationale as fdaa0b24). Validators
      // are unaffected in practice — their negatives come with failing scores,
      // which the average already fails. This closes the scored/scoreless
      // asymmetry where a lens gated only if it happened to omit a score.
      if (decisionCategory === 'positive' &&
          results.some(r => r.score != null && resolveDecisionCategory(r, this.warnUnclassified) === 'negative')) {
        decision = 'WARN';
        decisionCategory = 'conditional';
      }
    } else {
      // Scoreless aggregation gates on vocabulary-resolved categories, not literal
      // FAILED/PARTIAL — a scoreless agent with a custom negative vocabulary
      // (completion.vocabulary.failed = 'MUTILATED') must still fail the command.
      const failed = results.some(r => resolveDecisionCategory(r, this.warnUnclassified) === 'negative');
      const partial = results.some(r => resolveDecisionCategory(r, this.warnUnclassified) === 'conditional');
      decision = failed ? 'FAILED' : partial ? 'PARTIAL' : 'COMPLETE';
      decisionCategory = failed ? 'negative' : partial ? 'conditional' : 'positive';
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
      decisionCategory,
      score,
      maxScore,
      threshold,
      recommendations,
      durationMs,
      metrics,
    };
  }
}
