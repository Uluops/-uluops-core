import type { AnalysisSummaryInput, AnalysisRecordInput, CategoryScore, ExplorationMap } from '@uluops/ops-sdk';
import type { AgentResult } from '../types/agent.js';
import type { ResolvedDefinition } from '../types/registry.js';
import type { AgentDefinition } from '../types/agent.js';

/**
 * Result of analysis extraction from an agent execution.
 */
export interface AnalysisExtractionResult {
  summary: AnalysisSummaryInput;
  records: AnalysisRecordInput[];
}

/**
 * Extracts analysis summary and records from AgentResult + ResolvedDefinition.
 *
 * Runs at submission time (ValidationClient.transformToOpsInput) to populate
 * the analysisSummary and analysisRecords fields on SaveRunInput without
 * modifying the public AgentResult type.
 *
 * Extraction sources:
 * - decision, score, name: directly from AgentResult
 * - decisionVocabulary: from agent definition's decisions.vocabulary
 * - categoryScores: from AgentResult.categories + definition scoring weights
 * - systemMetrics: from AgentResult.metrics + extraction metadata
 * - epistemicAssessment, auditImplications, explorationMaps: from rawJson
 * - analysisRecords: from recommendations
 */
export class AnalysisSummaryExtractor {
  extract(result: AgentResult, resolved: ResolvedDefinition): AnalysisExtractionResult {
    return {
      summary: this.buildSummary(result, resolved),
      records: this.buildAnalysisRecords(result),
    };
  }

  private buildSummary(result: AgentResult, resolved: ResolvedDefinition): AnalysisSummaryInput {
    const definition = this.getAgentDefinition(resolved);

    return {
      agentName: result.name,
      decision: result.decision,
      score: result.score,
      decisionVocabulary: this.buildDecisionVocabulary(definition),
      categoryScores: this.buildCategoryScores(result, definition),
      systemMetrics: this.buildSystemMetrics(result),
      epistemicAssessment: this.extractJsonField(result.rawJson, 'epistemicAssessment', 'epistemic_assessment') as Record<string, unknown> | null,
      auditImplications: this.extractJsonField(result.rawJson, 'auditImplications', 'audit_implications') as string[] | null,
      explorationMaps: this.extractExplorationMaps(result.rawJson),
    };
  }

  /**
   * Build decision vocabulary string from definition.
   * Format: "POSITIVE/CONDITIONAL/NEGATIVE" or "COMPLETE/PARTIAL/FAILED" for executors.
   */
  private buildDecisionVocabulary(definition?: AgentDefinition): string | null {
    const agent = definition?.agent;
    if (!agent) return null;

    // Validator/analyst/explorer/forecaster vocabulary
    const decisions = agent.decisions?.vocabulary;
    if (decisions) {
      const parts = [decisions.positive, decisions.conditional, decisions.negative].filter(Boolean);
      return parts.length > 0 ? parts.join('/') : null;
    }

    // Executor/generator vocabulary
    const completion = agent.completion?.vocabulary;
    if (completion) {
      const parts = [completion.complete, completion.partial, completion.failed].filter(Boolean);
      return parts.length > 0 ? parts.join('/') : null;
    }

    return null;
  }

  /**
   * Map result categories to CategoryScore[] using definition weights.
   * Falls back to equal weights when definition scoring is unavailable.
   */
  private buildCategoryScores(result: AgentResult, definition?: AgentDefinition): CategoryScore[] | null {
    if (!result.categories || result.categories.length === 0) return null;

    const definitionCategories = definition?.agent?.scoring?.categories;
    const weightMap = new Map<string, number>();

    if (definitionCategories) {
      for (const cat of definitionCategories) {
        weightMap.set(cat.name, cat.weight);
      }
    }

    const equalWeight = definitionCategories ? undefined : Math.round(100 / result.categories.length);

    return result.categories.map(cat => ({
      name: cat.name,
      weight: weightMap.get(cat.name) ?? equalWeight ?? 1,
      score: Math.round((cat.score / cat.maxScore) * 100),
    }));
  }

  /**
   * Build system metrics from execution metrics + extraction metadata.
   */
  private buildSystemMetrics(result: AgentResult): Record<string, unknown> {
    return {
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cacheCreationTokens: result.metrics.cacheCreationTokens,
      cacheReadTokens: result.metrics.cacheReadTokens,
      thinkingTokens: result.metrics.thinkingTokens,
      totalEffectiveTokens: result.metrics.totalEffectiveTokens,
      durationMs: result.metrics.durationMs,
      model: result.metrics.model,
      toolCallCount: result.metrics.toolCallCount,
      costUsd: result.metrics.costUsd,
      extractionConfidence: result.extractionConfidence,
      extractionMethod: result.extractionMethod,
    };
  }

  /**
   * Extract exploration maps from rawJson with structural validation.
   */
  private extractExplorationMaps(rawJson: unknown): ExplorationMap[] | null {
    const raw = this.extractJsonField(rawJson, 'explorationMaps', 'exploration_maps');
    if (!Array.isArray(raw)) return null;

    // Light validation: each entry must have metadata and sections
    const valid = raw.filter(
      (entry: unknown): entry is ExplorationMap =>
        typeof entry === 'object' &&
        entry !== null &&
        'metadata' in entry &&
        'sections' in entry &&
        typeof (entry as Record<string, unknown>).metadata === 'object' &&
        Array.isArray((entry as Record<string, unknown>).sections),
    );

    return valid.length > 0 ? valid : null;
  }

  /**
   * Build analysis records from recommendations.
   */
  private buildAnalysisRecords(result: AgentResult): AnalysisRecordInput[] {
    return result.recommendations.map(rec => ({
      agentName: result.name,
      recordType: rec.failureDomain ?? 'finding',
      recordId: rec.failureCode ?? this.truncateId(`${result.name}/${rec.title}`),
      title: rec.title,
      classification: rec.failureCode ?? null,
      severity: rec.severity ?? null,
      data: {
        priority: rec.priority,
        description: rec.description,
        filePath: rec.filePath,
        lineNumber: rec.lineNumber,
        category: rec.category,
        failureMode: rec.failureMode,
        classificationConfidence: rec.classificationConfidence,
        classifiedBy: rec.classifiedBy,
        secondaryFailureCodes: rec.secondaryFailureCodes,
        taxonomyVersion: rec.taxonomyVersion,
      },
    }));
  }

  /**
   * Extract a field from rawJson, trying camelCase then snake_case.
   */
  private extractJsonField(rawJson: unknown, camelKey: string, snakeKey: string): unknown {
    if (!rawJson || typeof rawJson !== 'object') return null;
    const obj = rawJson as Record<string, unknown>;
    return obj[camelKey] ?? obj[snakeKey] ?? null;
  }

  /**
   * Get AgentDefinition from ResolvedDefinition, if available.
   */
  private getAgentDefinition(resolved: ResolvedDefinition): AgentDefinition | undefined {
    if (resolved.type !== 'agent') return undefined;
    const def = resolved.definition;
    if (def && typeof def === 'object' && 'agent' in def) {
      return def as AgentDefinition;
    }
    return undefined;
  }

  /**
   * Truncate a string to max 20 chars for recordId.
   */
  private truncateId(input: string): string {
    return input.length <= 20 ? input : input.substring(0, 20);
  }
}
