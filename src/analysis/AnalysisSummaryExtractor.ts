import { createHash } from 'node:crypto';
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
 * Parsed analysis block from an agent's markdown JSON code fence.
 * Agents produce this via their rendered prompt's "Metrics Vocabulary"
 * and "JSON output" sections — richer than the structured output schema.
 */
interface AgentAnalysisBlock {
  system_metrics?: Record<string, unknown>;
  category_scores?: CategoryScore[];
  epistemic_assessment?: Record<string, unknown>;
  audit_implications?: string[];
  records?: AnalysisRecordInput[];
}

/**
 * Extracts analysis summary and records from AgentResult + ResolvedDefinition.
 *
 * Two data sources are merged with precedence:
 *
 * 1. **Agent analysis block** (from rawOutput JSON code fence) — domain-specific
 *    metrics, typed records with meaningful IDs, agent-specific epistemic
 *    assessment. This is what the MCP autosave hook has always captured.
 *
 * 2. **Structured output fields** (from rawJson via agentOutputSchema) —
 *    explorationMaps, epistemicAssessment, auditImplications added in v0.10.0.
 *    Used as fallback when the analysis block doesn't have them.
 *
 * 3. **Execution envelope** (from AgentResult.metrics) — tokens, duration,
 *    model. Always included in systemMetrics alongside domain metrics.
 */
export class AnalysisSummaryExtractor {
  extract(result: AgentResult, resolved: ResolvedDefinition): AnalysisExtractionResult {
    const analysisBlock = this.parseAnalysisBlock(result.rawOutput);

    return {
      summary: this.buildSummary(result, resolved, analysisBlock),
      records: this.buildAnalysisRecords(result, analysisBlock),
    };
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  private buildSummary(
    result: AgentResult,
    resolved: ResolvedDefinition,
    analysisBlock: AgentAnalysisBlock | null,
  ): AnalysisSummaryInput {
    const definition = this.getAgentDefinition(resolved);

    return {
      agentName: result.name,
      decision: result.decision,
      score: result.score,
      decisionVocabulary: this.buildDecisionVocabulary(definition),
      categoryScores: analysisBlock?.category_scores ?? this.buildCategoryScores(result, definition),
      systemMetrics: this.buildSystemMetrics(result, analysisBlock),
      epistemicAssessment: this.resolveEpistemicAssessment(analysisBlock, result.rawJson),
      auditImplications: this.resolveAuditImplications(analysisBlock, result.rawJson),
      explorationMaps: this.extractExplorationMaps(result.rawJson),
    };
  }

  // ─── Analysis Block Parsing ─────────────────────────────────────────────

  /**
   * Parse the JSON code fence from the agent's markdown report.
   * Agents produce a ```json block containing { agent, result, categories, analysis }.
   * The `analysis` key holds domain-specific metrics, records, and assessments.
   */
  private parseAnalysisBlock(rawOutput?: string): AgentAnalysisBlock | null {
    if (!rawOutput) return null;

    const jsonMatch = rawOutput.match(/```json\n([\s\S]*?)```/);
    if (!jsonMatch) return null;

    try {
      // jsonMatch[1] is always defined when the regex matches (capture group 1)
      const data = JSON.parse(jsonMatch[1]!);
      const analysis = data?.analysis;
      if (!analysis || typeof analysis !== 'object') return null;
      return analysis as AgentAnalysisBlock;
    } catch {
      return null;
    }
  }

  // ─── Decision Vocabulary ────────────────────────────────────────────────

  /**
   * Build decision vocabulary string from definition.
   * Format: "POSITIVE/CONDITIONAL/NEGATIVE" or "COMPLETE/PARTIAL/FAILED" for executors.
   */
  private buildDecisionVocabulary(definition?: AgentDefinition): string | null {
    const agent = definition?.agent;
    if (!agent) return null;

    const decisions = agent.decisions?.vocabulary;
    if (decisions) {
      const parts = [decisions.positive, decisions.conditional, decisions.negative].filter(Boolean);
      return parts.length > 0 ? parts.join('/') : null;
    }

    const completion = agent.completion?.vocabulary;
    if (completion) {
      const parts = [completion.complete, completion.partial, completion.failed].filter(Boolean);
      return parts.length > 0 ? parts.join('/') : null;
    }

    return null;
  }

  // ─── Category Scores ────────────────────────────────────────────────────

  /**
   * Map result categories to CategoryScore[] using definition weights.
   * Preserves raw score/maxScore ratio rather than normalizing to percentage.
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
      score: cat.score,
    }));
  }

  // ─── System Metrics ─────────────────────────────────────────────────────

  /**
   * Build system metrics by merging domain metrics with execution metrics.
   *
   * Priority: analysis block system_metrics > structured output domainMetrics > execution metrics only.
   * Domain metrics (e.g., "Promising: 3", "Candidates Identified: 5") are what the
   * dashboard displays. Execution metrics (tokens, duration, model) always included.
   */
  private buildSystemMetrics(result: AgentResult, analysisBlock: AgentAnalysisBlock | null): Record<string, unknown> {
    const executionMetrics: Record<string, unknown> = {
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

    // Prefer analysis block domain metrics (from JSON code fence)
    if (analysisBlock?.system_metrics && typeof analysisBlock.system_metrics === 'object') {
      return { ...executionMetrics, ...analysisBlock.system_metrics };
    }

    // Fall back to structured output domainMetrics (from agentOutputSchema)
    const domainMetrics = this.extractDomainMetrics(result.rawJson);
    if (domainMetrics) {
      return { ...executionMetrics, ...domainMetrics };
    }

    return executionMetrics;
  }

  /**
   * Extract domain metrics from structured output's domainMetrics array.
   * Converts [{key, value}] entries to a flat Record<string, unknown>.
   */
  private extractDomainMetrics(rawJson: unknown): Record<string, unknown> | null {
    const raw = this.extractJsonField(rawJson, 'domainMetrics', 'domain_metrics');
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const metrics: Record<string, unknown> = {};
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
        const { key, value } = entry as { key: string; value: string };
        // Parse numeric strings back to numbers
        const num = Number(value);
        metrics[key] = isNaN(num) ? value : num;
      }
    }
    return Object.keys(metrics).length > 0 ? metrics : null;
  }

  // ─── Epistemic Assessment ───────────────────────────────────────────────

  /**
   * Resolve epistemic assessment: prefer analysis block (agent-specific),
   * fall back to structured output (generic schema).
   */
  private resolveEpistemicAssessment(
    analysisBlock: AgentAnalysisBlock | null,
    rawJson: unknown,
  ): Record<string, unknown> | null {
    if (analysisBlock?.epistemic_assessment) {
      return analysisBlock.epistemic_assessment;
    }
    return this.extractJsonField(rawJson, 'epistemicAssessment', 'epistemic_assessment') as Record<string, unknown> | null;
  }

  // ─── Audit Implications ─────────────────────────────────────────────────

  /**
   * Resolve audit implications: prefer analysis block, fall back to structured output.
   */
  private resolveAuditImplications(
    analysisBlock: AgentAnalysisBlock | null,
    rawJson: unknown,
  ): string[] | null {
    if (analysisBlock?.audit_implications && Array.isArray(analysisBlock.audit_implications)) {
      return analysisBlock.audit_implications;
    }
    return this.extractJsonField(rawJson, 'auditImplications', 'audit_implications') as string[] | null;
  }

  // ─── Exploration Maps ──────────────────────────────────────────────────

  /**
   * Extract exploration maps from rawJson, reshaping LLM output to API format.
   *
   * The LLM produces sections with {type, label, summary, entries: [{key, value}]}
   * (OpenAI strict mode compatible). The API expects per-type fields like
   * {type: 'inventory', items: [...]}. This method bridges the two formats.
   */
  private extractExplorationMaps(rawJson: unknown): ExplorationMap[] | null {
    const raw = this.extractJsonField(rawJson, 'explorationMaps', 'exploration_maps');
    if (!Array.isArray(raw)) return null;

    const maps: ExplorationMap[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || !('metadata' in entry) || !('sections' in entry)) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.metadata !== 'object' || !Array.isArray(e.sections)) continue;

      const sections = (e.sections as Array<Record<string, unknown>>).map(s => this.reshapeSection(s));
      maps.push({
        metadata: e.metadata as ExplorationMap['metadata'],
        // Safe: reshapeSection guarantees required discriminant fields per section type
        sections: sections as unknown as ExplorationMap['sections'],
      });
    }

    return maps.length > 0 ? maps : null;
  }

  /**
   * Reshape a section from LLM format (entries) to API format (typed fields).
   * If the section already has typed fields (e.g., items, entities), pass through.
   */
  private reshapeSection(section: Record<string, unknown>): Record<string, unknown> {
    const type = section.type as string;
    const base = { type, label: section.label, summary: section.summary };

    if (!('entries' in section)) return section;

    const entries = section.entries as Array<{ key: string; value: string }> | undefined;
    if (!entries || !Array.isArray(entries)) return section;

    const items = entries.map(e => ({ key: e.key, value: e.value }));

    switch (type) {
      case 'inventory':
        return { ...base, items, gaps: [] };
      case 'topology':
        return { ...base, entities: items, relationships: [] };
      case 'landscape':
        return { ...base, dimensions: items.map(i => i.key), findings: items };
      case 'classification':
        return { ...base, hierarchy: items };
      case 'mapping':
        return { ...base, translations: items };
      case 'synthesis':
        return { ...base, patterns: items };
      case 'limitation':
        return { ...base, blindSpots: items };
      case 'agenda':
        return { ...base, questions: items };
      default:
        return section;
    }
  }

  // ─── Analysis Records ──────────────────────────────────────────────────

  /**
   * Build analysis records with 4-tier precedence:
   * 1. Analysis block records (from JSON code fence — richest: typed, meaningful IDs)
   * 2. Structured output analysisRecords (from agentOutputSchema — typed, meaningful IDs)
   * 3. Derived from exploration maps (inventory items, agenda questions, etc.)
   * 4. Auto-generated from recommendations (fallback — evidence_finding, hash IDs)
   */
  private buildAnalysisRecords(
    result: AgentResult,
    analysisBlock: AgentAnalysisBlock | null,
  ): AnalysisRecordInput[] {
    // Tier 1: analysis block records (JSON code fence)
    if (analysisBlock?.records && Array.isArray(analysisBlock.records) && analysisBlock.records.length > 0) {
      return analysisBlock.records.map(rec => ({
        ...rec,
        agentName: rec.agentName ?? result.name,
      }));
    }

    // Tier 2: structured output analysisRecords
    const structuredRecords = this.extractStructuredRecords(result.rawJson, result.name);
    if (structuredRecords.length > 0) {
      return structuredRecords;
    }

    // Tier 3: derived from exploration maps
    const mapRecords = this.deriveRecordsFromExplorationMaps(result.rawJson, result.name);
    if (mapRecords.length > 0) {
      return mapRecords;
    }

    // Tier 4: auto-generated from recommendations
    return result.recommendations.map(rec => ({
      agentName: result.name,
      recordType: rec.failureDomain ?? 'evidence_finding',
      recordId: this.safeRecordId(rec.failureCode, `${result.name}/${rec.title}`),
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
   * Extract analysis records from structured output's analysisRecords array.
   * Converts entries-based data [{key, value}] to the API's Record<string, unknown> format.
   */
  private extractStructuredRecords(rawJson: unknown, agentName: string): AnalysisRecordInput[] {
    const raw = this.extractJsonField(rawJson, 'analysisRecords', 'analysis_records');
    if (!Array.isArray(raw) || raw.length === 0) return [];

    return raw.filter((r): r is Record<string, unknown> =>
      r && typeof r === 'object' && 'recordType' in r && 'recordId' in r && 'title' in r,
    ).map(r => {
      // Convert entries-based data to flat record
      const dataEntries = Array.isArray(r.data)
        ? Object.fromEntries((r.data as Array<{ key: string; value: string }>).map(e => [e.key, e.value]))
        : (r.data as Record<string, unknown>) ?? {};

      return {
        agentName,
        recordType: String(r.recordType),
        recordId: this.safeRecordId(String(r.recordId), `${agentName}/${r.title}`),
        title: String(r.title),
        classification: r.classification ? String(r.classification) : null,
        severity: r.severity ? String(r.severity) : null,
        data: dataEntries,
      };
    });
  }

  /**
   * Derive analysis records from exploration map sections.
   *
   * Maps section types to record types:
   * - inventory items → record type from section label context
   * - agenda questions → inquiry_question
   * - limitation blind spots → limitation
   * - synthesis patterns → evidence_finding
   * - mapping translations → evidence_finding
   * - topology entities → evidence_finding
   *
   * Capped at 100 records to avoid overwhelming the tracker.
   */
  private deriveRecordsFromExplorationMaps(rawJson: unknown, agentName: string): AnalysisRecordInput[] {
    const raw = this.extractJsonField(rawJson, 'explorationMaps', 'exploration_maps');
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const records: AnalysisRecordInput[] = [];
    let counter = 0;

    for (const map of raw) {
      if (!map || typeof map !== 'object' || !('sections' in map)) continue;
      const sections = (map as Record<string, unknown>).sections;
      if (!Array.isArray(sections)) continue;

      for (const section of sections) {
        if (!section || typeof section !== 'object') continue;
        const s = section as Record<string, unknown>;
        const type = s.type as string;
        const items = this.getSectionItems(s);
        if (!items || items.length === 0) continue;

        const recordType = this.sectionTypeToRecordType(type);
        const prefix = this.sectionTypeToPrefix(type);

        for (const item of items) {
          counter++;
          if (counter > 100) break;

          const key = typeof item === 'object' && item !== null && 'key' in item
            ? String((item as Record<string, unknown>).key)
            : `${prefix}-${counter}`;
          const value = typeof item === 'object' && item !== null && 'value' in item
            ? String((item as Record<string, unknown>).value)
            : typeof item === 'string' ? item : JSON.stringify(item);

          records.push({
            agentName,
            recordType,
            recordId: this.safeRecordId(undefined, `${agentName}/${key}`),
            title: key.length > 200 ? key.substring(0, 200) : key,
            classification: null,
            severity: null,
            data: {
              sectionType: type,
              sectionLabel: s.label,
              content: value.length > 2000 ? value.substring(0, 2000) : value,
            },
          });
        }
        if (counter > 100) break;
      }
      if (counter > 100) break;
    }

    return records;
  }

  /**
   * Get the list of items from a section based on its type.
   * Handles both entries-based format and typed field format.
   */
  private getSectionItems(section: Record<string, unknown>): unknown[] | null {
    // Entries-based format (from structured output)
    if (Array.isArray(section.entries) && section.entries.length > 0) return section.entries;
    // Typed field formats (from reshaped or JSON fence)
    if (Array.isArray(section.items)) return section.items;
    if (Array.isArray(section.questions)) return section.questions;
    if (Array.isArray(section.blindSpots)) return section.blindSpots;
    if (Array.isArray(section.patterns)) return section.patterns;
    if (Array.isArray(section.translations)) return section.translations;
    if (Array.isArray(section.entities)) return section.entities;
    if (Array.isArray(section.hierarchy)) return section.hierarchy;
    if (Array.isArray(section.findings)) return section.findings;
    return null;
  }

  /**
   * Map exploration section type to a valid analysis record type.
   * Must match the API's record type enum — see ops-uluops-api
   * AnalysisRecordType for the full list.
   */
  private sectionTypeToRecordType(sectionType: string): string {
    switch (sectionType) {
      case 'agenda': return 'inquiry_question';
      case 'limitation': return 'evidence_finding';
      case 'inventory': return 'evidence_finding';
      case 'topology': return 'evidence_finding';
      case 'landscape': return 'evidence_finding';
      case 'classification': return 'evidence_finding';
      case 'mapping': return 'evidence_finding';
      case 'synthesis': return 'evidence_finding';
      default: return 'evidence_finding';
    }
  }

  /** Map exploration section type to record ID prefix. */
  private sectionTypeToPrefix(sectionType: string): string {
    switch (sectionType) {
      case 'agenda': return 'IQ';
      case 'limitation': return 'LM';
      case 'inventory': return 'INV';
      case 'topology': return 'TOP';
      case 'landscape': return 'LSC';
      case 'classification': return 'CLS';
      case 'mapping': return 'MAP';
      case 'synthesis': return 'SYN';
      default: return 'REC';
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

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
   * Produce a recordId that fits within the 20-char SDK limit.
   * Uses failureCode if present and <=20 chars, otherwise hashes.
   */
  private safeRecordId(failureCode: string | undefined, fallbackInput: string): string {
    if (failureCode && failureCode.length <= 20) return failureCode;
    return 'r-' + createHash('sha256').update(failureCode ?? fallbackInput).digest('hex').substring(0, 16);
  }
}
