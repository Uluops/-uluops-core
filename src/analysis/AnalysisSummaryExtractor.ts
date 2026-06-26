import { createHash } from 'node:crypto';
import type { AnalysisSummaryInput, AnalysisRecordInput, CategoryScore, ExplorationMap } from '@uluops/ops-sdk';
import type { AgentResult, AgentDefinition } from '../types/agent.js';
import type { ResolvedDefinition } from '../types/registry.js';

/**
 * Max length of the agent-local analysis recordId accepted by the tracker.
 * Mirrors the API column (ops-api migration 058) and the SDK/MCP request schemas.
 * Kept as a local constant to avoid coupling @uluops/core to a specific ops-sdk
 * version for a single value.
 */
const ANALYSIS_RECORD_ID_MAX_LENGTH = 100;

/** Valid recordType enum values accepted by the tracker API. */
const VALID_RECORD_TYPES = new Set([
  'category_breakdown', 'criterion_deduction', 'auto_fail_check', 'convention',
  'power_map', 'tension', 'tension_health', 'stagnation', 'four_cause',
  'essential_property', 'naming_chain', 'ritual', 'evidence_claim', 'causal_claim',
  'is_ought_violation', 'habitual_assumption', 'theory', 'corroboration',
  'untested_assumption', 'bold_conjecture', 'participation_gap', 'shadow',
  'hierarchy_inversion', 'form_extraction', 'confidence_basis', 'examination_debt',
  'intervention_chain', 'reversal', 'emptiness', 'control_paradox',
  'stress_concentration', 'lever_point', 'displacement', 'fulcrum',
  'center_of_gravity', 'commitment', 'contradiction', 'inquiry_question',
  'definitional_stability', 'decay_vector', 'tension_trajectory', 'cascade_layer',
  'capability_emergence', 'artifact', 'completion_criterion', 'improvement',
  'evidence_finding',
]);


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
  /**
   * Extract analysis summary and records from an agent result and its definition.
   *
   * Combines three data sources: the LLM's JSON analysis block (from raw output),
   * the agent definition (scoring weights, decision vocabulary), and execution
   * metrics (tokens, duration, model). Returns a structured summary for tracker
   * persistence and analysis records for per-finding storage.
   *
   * @param result - The completed agent result with parsed output and metrics
   * @param resolved - The resolved definition providing scoring weights and vocabulary
   * @returns Summary and records ready for tracker submission
   * @throws {Error} if the analysis block JSON is malformed (propagated from JSON.parse)
   */
  extract(result: AgentResult, resolved: ResolvedDefinition): AnalysisExtractionResult {
    const analysisBlock = this.resolveAnalysisBlock(result);

    return {
      summary: this.buildSummary(result, resolved, analysisBlock),
      records: this.buildAnalysisRecords(result, analysisBlock),
    };
  }

  /**
   * Resolve the analysis block, preferring the rawOutput ```json fence (the
   * unchanged primary path) and falling back to the untruncated `rawJson.analysis`
   * when the fence is absent.
   *
   * `rawOutput` is capped at MAX_RAW_OUTPUT_BYTES in AgentExecutor for storage/
   * display; a report exceeding that cap is clipped at the END, dropping the closing
   * ```json fence — so `parseAnalysisBlock` finds nothing and analysis_summary/
   * analysis_records would silently vanish on an otherwise successful run. `rawJson`
   * holds the SAME parsed fence object captured by OutputExtractor from the full,
   * untruncated output, so `rawJson.analysis` recovers the block regardless of the
   * cap. The fence stays primary so non-truncated runs are byte-for-byte unchanged.
   * (tracker d03bdb43)
   */
  private resolveAnalysisBlock(result: AgentResult): AgentAnalysisBlock | null {
    return this.parseAnalysisBlock(result.rawOutput) ?? this.analysisFromRawJson(result.rawJson);
  }

  /** Extract the `analysis` sub-object from the untruncated rawJson, if present. */
  private analysisFromRawJson(rawJson: unknown): AgentAnalysisBlock | null {
    if (!rawJson || typeof rawJson !== 'object') return null;
    const analysis = (rawJson as Record<string, unknown>)['analysis'];
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null;
    return analysis as AgentAnalysisBlock;
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

    // Prefer the disambiguated fence (introduced by report-mode invocations) so that
    // example ```json blocks in the prose body never claim the canonical match.
    // Fall back to the plain fence to preserve compatibility with non-report-mode
    // invocations that emit a single trailing ```json block.
    const jsonMatch =
      rawOutput.match(/```json analysis\n([\s\S]*?)```/) ??
      rawOutput.match(/```json\n([\s\S]*?)```/);
    if (!jsonMatch) return null;

    try {
      // jsonMatch[1] is always defined when the regex matches (capture group 1).
      // The parsed JSON is not schema-validated here — the analysis block is best-effort
      // extraction from LLM output. Downstream consumers (tracker API, SubmissionClient)
      // validate the shape before persistence. Invalid fields are silently dropped by the
      // typed extraction methods (extractCategoryScores, extractExplorationMaps, etc.).
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

    // Only score-bearing categories can become a CategoryScore (its `score` is a number).
    // Scoreless categories (score === null) are skipped — not fabricated to 0.
    // INTERIM: when the companion spec relaxes ops-sdk CategoryScore.score to number|null,
    // these can be preserved with a null score instead of dropped.
    const scored = result.categories.filter(
      (cat): cat is typeof cat & { score: number } => cat.score !== null,
    );
    if (scored.length === 0) return null;

    const equalWeight = definitionCategories ? undefined : Math.round(100 / scored.length);

    return scored.map(cat => ({
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
    const raw = this.extractJsonField(rawJson, 'epistemicAssessment', 'epistemic_assessment');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
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
    const raw = this.extractJsonField(rawJson, 'auditImplications', 'audit_implications');
    return Array.isArray(raw) ? raw as string[] : null;
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

      const VALID_SECTION_TYPES = new Set(['inventory', 'topology', 'landscape', 'classification', 'mapping', 'synthesis', 'limitation', 'agenda']);
      const sections = (e.sections as Array<Record<string, unknown>>)
        .filter(s => typeof s.type === 'string' && typeof s.label === 'string' && VALID_SECTION_TYPES.has(s.type as string))
        .map(s => this.reshapeSection(s))
        .filter(s => this.validateSectionShape(s));
      maps.push({
        metadata: e.metadata as ExplorationMap['metadata'],
        // reshapeSection produces typed fields for all 8 known section types;
        // validateSectionShape confirms required per-type fields exist.
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

  /** Validate that a reshaped section has the required fields for its declared type. */
  private validateSectionShape(section: Record<string, unknown>): boolean {
    const type = section.type as string;
    switch (type) {
      case 'inventory': return Array.isArray(section.items);
      case 'topology': return Array.isArray(section.entities);
      case 'landscape': return Array.isArray(section.findings);
      case 'classification': return Array.isArray(section.hierarchy);
      case 'mapping': return Array.isArray(section.translations);
      case 'synthesis': return Array.isArray(section.patterns);
      case 'limitation': return Array.isArray(section.blindSpots) || Array.isArray(section.blind_spots);
      case 'agenda': return Array.isArray(section.questions);
      default: return false;
    }
  }

  // ─── Analysis Records ──────────────────────────────────────────────────

  /**
   * Build analysis records via a first-non-empty-tier-wins cascade. The tiers are
   * mutually-exclusive *representations* of the same findings, not additive sources —
   * an agent emits records in exactly one form, and the highest-fidelity present form
   * wins. (First-wins, not merge, so a finding expressed in two forms isn't counted
   * twice.) Each tier is the primary source for a different agent class, so the
   * ordering is a contract, not a convenience — reordering or removing a tier changes
   * the persisted record shape for whichever class depends on it. The precedence
   * boundaries are locked by the "record tier precedence" tests; keep them in sync.
   *
   * 1. Analysis block records (JSON code fence) — analysts/validators in report mode;
   *    richest: typed records with meaningful IDs.
   * 2. Structured output analysisRecords (agentOutputSchema) — analysts/validators in
   *    structured-output mode; typed, meaningful IDs.
   * 3. Derived from exploration maps — explorers (inventory items, agenda questions).
   * 4. Auto-generated from recommendations — fallback for any agent that emitted none
   *    of the above (evidence_finding, hash IDs).
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
      recordType: rec.failureDomain && VALID_RECORD_TYPES.has(rec.failureDomain) ? rec.failureDomain : 'evidence_finding',
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
        recordType: VALID_RECORD_TYPES.has(String(r.recordType)) ? String(r.recordType) : 'evidence_finding',
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
   * Section type → record type + ID prefix.
   * Record types must match the API's AnalysisRecordType enum.
   */
  private static readonly SECTION_TYPE_CONFIG: Record<string, { recordType: string; prefix: string }> = {
    agenda:         { recordType: 'inquiry_question', prefix: 'IQ' },
    limitation:     { recordType: 'evidence_finding', prefix: 'LM' },
    inventory:      { recordType: 'evidence_finding', prefix: 'INV' },
    topology:       { recordType: 'evidence_finding', prefix: 'TOP' },
    landscape:      { recordType: 'evidence_finding', prefix: 'LSC' },
    classification: { recordType: 'evidence_finding', prefix: 'CLS' },
    mapping:        { recordType: 'evidence_finding', prefix: 'MAP' },
    synthesis:      { recordType: 'evidence_finding', prefix: 'SYN' },
  };

  private static readonly DEFAULT_SECTION_CONFIG = { recordType: 'evidence_finding', prefix: 'REC' };

  private sectionTypeToRecordType(sectionType: string): string {
    return (AnalysisSummaryExtractor.SECTION_TYPE_CONFIG[sectionType] ?? AnalysisSummaryExtractor.DEFAULT_SECTION_CONFIG).recordType;
  }

  private sectionTypeToPrefix(sectionType: string): string {
    return (AnalysisSummaryExtractor.SECTION_TYPE_CONFIG[sectionType] ?? AnalysisSummaryExtractor.DEFAULT_SECTION_CONFIG).prefix;
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
   * Produce a recordId that fits within the tracker's recordId limit.
   * Uses the candidate id (failureCode or an agent-provided recordId) verbatim when
   * it fits, otherwise falls back to a bounded deterministic hash. The cap was 20;
   * widening to 100 preserves semantic, namespaced IDs (e.g.
   * `foundations-api-aristotle-20260626`) that previously got hashed away.
   */
  private safeRecordId(failureCode: string | undefined, fallbackInput: string): string {
    if (failureCode && failureCode.length <= ANALYSIS_RECORD_ID_MAX_LENGTH) return failureCode;
    return 'r-' + createHash('sha256').update(failureCode ?? fallbackInput).digest('hex').substring(0, 16);
  }
}
