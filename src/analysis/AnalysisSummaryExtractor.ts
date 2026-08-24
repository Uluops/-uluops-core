import { parseExternalNumber } from '../utils/externalValue.js';
import { createHash } from 'node:crypto';
import type { AnalysisSummaryInput, AnalysisRecordInput, CategoryScore, ExplorationMap } from '@uluops/ops-sdk';

/** One typed section of an exploration map (the ops-sdk union member). */
type ExplorationSection = ExplorationMap['sections'][number];
import type { AgentResult, AgentDefinition } from '../types/agent.js';
import type { ResolvedDefinition } from '../types/registry.js';

/**
 * Max length of the agent-local analysis recordId accepted by the tracker.
 * Mirrors the API column (ops-api migration 058) and the SDK/MCP request schemas.
 * Kept as a local constant to avoid coupling @uluops/core to a specific ops-sdk
 * version for a single value.
 */
const ANALYSIS_RECORD_ID_MAX_LENGTH = 100;

/**
 * Max length of the analysis recordType accepted by the tracker.
 * Mirrors `VARCHAR(50)` (ops-api migration 024) and the `z.string().min(1).max(50)`
 * request schemas in ops-api and the MCP. Local constant for the same reason as
 * ANALYSIS_RECORD_ID_MAX_LENGTH above.
 *
 * There is deliberately NO record-type vocabulary here. This module used to hold a
 * 47-value `VALID_RECORD_TYPES` set and coerce anything outside it to
 * 'evidence_finding' — silently, and only on the Tier 2 path, so an identical record
 * survived or was flattened depending purely on which channel the agent emitted it
 * through. That set was a vestige of an enum the platform deliberately removed:
 * ops-api widened `recordType` from `z.enum(...)` to a bounded string precisely so
 * "registry-defined agents can introduce new record types without requiring an API
 * release" (ops-uluops-api/CHANGELOG.md:1743; the same rationale is documented at
 * ops-uluops-mcp/src/types/schemas.ts:71-78). Re-narrowing it client-side contradicted
 * that decision and destroyed the type distinction on the way to a database column
 * that was always willing to store it. As of 2026-08-07 the stored corpus carried 307
 * distinct record types, 271 of them outside that set, on 58.5% of all rows.
 */
const ANALYSIS_RECORD_TYPE_MAX_LENGTH = 50;

/**
 * Max sections per exploration map accepted by the tracker. Mirrors
 * `sections: z.array(...).max(100)` inside `explorationMaps` on
 * `AnalysisSummaryEntrySchema` (ops-sdk `SaveRunInputSchema`). Local constant
 * for the same reason as ANALYSIS_RECORD_ID_MAX_LENGTH above — that cap is
 * enforced client-side in ops-sdk before any HTTP call, so an unbounded
 * section count throws a ZodError that costs the whole analysis summary.
 */
const MAX_EXPLORATION_MAP_SECTIONS = 100;

/** Fallback when a record carries no usable type at all. */
const FALLBACK_RECORD_TYPE = 'evidence_finding';

/**
 * Storage bounds on the remaining agent-authored record fields, mirroring the ops-sdk
 * request schema (`title: z.string().min(1).max(500)`,
 * `classification: z.string().max(50).nullish()`) and the ops-api columns.
 *
 * These are enforced here for the same reason recordType and severity are: the SDK
 * validates the WHOLE analysisRecords array client-side, before the network, so a single
 * over-length value throws a ZodError and loses the entire run's analysis rather than one
 * record. recordId already had this defence (safeRecordId); severity and recordType have it
 * now; title and classification were the two left un-bounded, which made the guarantee only
 * as strong as its weakest field.
 */
const ANALYSIS_RECORD_TITLE_MAX_LENGTH = 500;
const ANALYSIS_RECORD_CLASSIFICATION_MAX_LENGTH = 50;

/** Title is required and non-empty at the API; a record with none still has to be storable. */
const FALLBACK_RECORD_TITLE = '(untitled record)';

/** Cap on a preserved non-string value, so one malformed payload cannot bloat the row. */
const PRESERVED_RECORD_TYPE_MAX_LENGTH = 200;

/**
 * Render a non-string value for preservation in `data.rawRecordType`, without throwing.
 * `JSON.stringify` throws on circular structures and returns undefined for symbols and
 * functions, and this runs on the save path of every agent run — a throw here would fail
 * the whole save, which is the exact failure class this module exists to prevent.
 */
function safeStringify(value: unknown): string {
  let out: string;
  try {
    out = JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    out = Object.prototype.toString.call(value);
  }
  return out.length > PRESERVED_RECORD_TYPE_MAX_LENGTH
    ? `${out.slice(0, PRESERVED_RECORD_TYPE_MAX_LENGTH)}…`
    : out;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);


/**
 * Result of analysis extraction from an agent execution.
 */
export interface AnalysisExtractionResult {
  summary: AnalysisSummaryInput;
  records: AnalysisRecordInput[];
  /**
   * Non-fatal repair/truncation notices produced during extraction (e.g. an
   * exploration map's sections truncated to the wire's cap). This class
   * deliberately has no logger of its own (see the comment on
   * `parseAnalysisBlock`'s catch block) — callers with a logger (currently
   * only SubmissionClient) should surface these via `logger.warn`. Absent
   * when extraction produced no repairs.
   */
  warnings?: string[];
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
 * 2. **Structured output fields** (read from `rawJson`, declared in
 *    `agentOutputSchema` but not promoted onto the typed result by
 *    `mapStructuredOutput`) — explorationMaps, epistemicAssessment,
 *    auditImplications (v0.10.0), analysisRecords, domainMetrics. Used as
 *    fallback when the analysis block doesn't have them.
 *
 * Execution telemetry (tokens, duration, model) is deliberately NOT part of
 * analysis data — it travels first-class on `agents[]` via
 * SubmissionClient.resultToAgent. systemMetrics carries the agent's cognitive
 * measurements only, and is null when the agent produced none
 * (system-metrics-contract spec v0.1.2 D4; previously an execution envelope
 * was always merged in — tracker issue 762f58be). The two extraction facts
 * (confidence, method) live in epistemicAssessment.
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
   *
   * Does NOT throw. This previously documented `@throws {Error} if the analysis block
   * JSON is malformed (propagated from JSON.parse)`, which was never true of the
   * implementation — parseAnalysisBlock catches and returns null, and every consumer of
   * the block then degrades to its `result.rawJson` fallback (systemMetrics →
   * extractDomainMetrics, records → the Tier 2/3 cascade, epistemicAssessment and
   * auditImplications take rawJson as a second source, explorationMaps reads rawJson
   * only). A malformed fence therefore costs no data on the structured-output path, and
   * on the text path it is already surfaced upstream as an extraction.failed degradation
   * marker. Callers must not write a try/catch expecting the documented failure — there
   * is no throwing path through extract().
   */
  extract(result: AgentResult, resolved: ResolvedDefinition): AnalysisExtractionResult {
    const analysisBlock = this.resolveAnalysisBlock(result);
    const warnings: string[] = [];

    const extraction: AnalysisExtractionResult = {
      summary: this.buildSummary(result, resolved, analysisBlock, warnings),
      records: this.buildAnalysisRecords(result, analysisBlock, warnings),
    };
    if (warnings.length > 0) extraction.warnings = warnings;
    return extraction;
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
    warnings: string[],
  ): AnalysisSummaryInput {
    const definition = this.getAgentDefinition(resolved);

    return {
      agentName: result.name,
      decision: result.decision,
      score: result.score,
      decisionVocabulary: this.buildDecisionVocabulary(definition),
      categoryScores: analysisBlock?.category_scores ?? this.buildCategoryScores(result, definition),
      systemMetrics: this.buildSystemMetrics(result, analysisBlock, warnings),
      epistemicAssessment: this.withExtractionFacts(
        this.resolveEpistemicAssessment(analysisBlock, result.rawJson),
        result,
      ),
      auditImplications: this.resolveAuditImplications(analysisBlock, result.rawJson),
      explorationMaps: this.extractExplorationMaps(result.rawJson, warnings),
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
      // Conflates "fence present but malformed" with "no fence at all" (the `return null`
      // at the !jsonMatch guard above). Returning null is CORRECT for data: resolveAnalysisBlock
      // falls through to rawJson, and every consumer of the block has its own rawJson
      // fallback, so nothing is lost on the structured-output path; on the text path the
      // same malformed content already failed in OutputExtractor and surfaces as an
      // extraction.failed marker. What is lost is the knowledge that THIS agent emitted
      // broken JSON — an output-quality signal about the agent, not a data-integrity
      // problem. Distinguishing the two needs a channel this class does not have (it has
      // no logger, and DegradationPhase is 'resolution' | 'execution' so the analysis
      // phase cannot emit a marker). Deliberately left conflated until that channel exists.
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
   * Build system metrics — the agent's COGNITIVE measurements only.
   *
   * Priority: analysis block system_metrics > structured output domainMetrics
   * > null. A run whose agent produced no cognitive metrics has no system
   * metrics — that is the honest state, not an execution envelope.
   *
   * Execution telemetry deliberately does NOT live here
   * (system-metrics-contract spec v0.1.2 D4, tracker issue 762f58be): tokens,
   * model, and duration are already first-class on the wire via
   * SubmissionClient.resultToAgent; extraction confidence/method are epistemic
   * facts and live in epistemicAssessment (see buildSummary); costUsd is
   * derivable from tokens + pricing; toolCallCount is an execution fact with
   * no analysis meaning.
   */
  private buildSystemMetrics(result: AgentResult, analysisBlock: AgentAnalysisBlock | null, warnings: string[]): Record<string, unknown> | null {
    // Prefer analysis block domain metrics (from JSON code fence)
    if (analysisBlock?.system_metrics && typeof analysisBlock.system_metrics === 'object') {
      return analysisBlock.system_metrics;
    }

    // Fall back to structured output domainMetrics (from agentOutputSchema)
    return this.extractDomainMetrics(result.rawJson, warnings);
  }

  /**
   * Extract domain metrics from structured output's domainMetrics array.
   * Converts [{key, value}] entries to a flat Record<string, unknown>.
   */
  private extractDomainMetrics(rawJson: unknown, warnings: string[]): Record<string, unknown> | null {
    const raw = this.extractJsonField(rawJson, 'domainMetrics', 'domain_metrics');
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const metrics: Record<string, unknown> = {};
    let dropped = 0;
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
        const { key, value } = entry as { key: string; value: string };
        // Parse numeric strings back to numbers.
        //
        // `Number('Infinity')` IS `Infinity`, and the old `isNaN(num)` guard passed it — so
        // an analysis metric could arrive as Infinity and serialize to `null` on the wire.
        // parseExternalNumber returns undefined for any non-finite result, and an
        // unparseable value correctly stays a string.
        const num = parseExternalNumber(value);
        metrics[key] = num ?? value;
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      warnings.push(`domainMetrics: dropped ${dropped} of ${raw.length} entries lacking key or value.`);
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

  /**
   * Merge extraction facts into the RESOLVED epistemic assessment — applied
   * after resolveEpistemicAssessment returns, wrapping BOTH its branches
   * (agent-block early return and structured-output fallback), never inside
   * one branch (system-metrics-contract spec v0.1.2 D4).
   *
   * Precedence: the agent's own keys WIN — extraction_confidence /
   * extraction_method are filled only when the resolved assessment lacks
   * them; agent-authored values are never clobbered.
   *
   * Consequence (spec, refined here): epistemicAssessment is non-null for
   * any core-produced summary whose result carries extraction facts — the
   * mirror of systemMetrics becoming nullable. Results with UNDEFINED
   * extraction fields contribute nothing (no junk `{key: undefined}` maps);
   * an empty merge stays null.
   */
  private withExtractionFacts(
    resolved: Record<string, unknown> | null,
    result: AgentResult,
  ): Record<string, unknown> | null {
    const merged: Record<string, unknown> = { ...(resolved ?? {}) };
    if (!('extraction_confidence' in merged) && result.extractionConfidence !== undefined) {
      merged['extraction_confidence'] = result.extractionConfidence;
    }
    if (!('extraction_method' in merged) && result.extractionMethod !== undefined) {
      merged['extraction_method'] = result.extractionMethod;
    }
    return Object.keys(merged).length > 0 ? merged : null;
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
  private extractExplorationMaps(rawJson: unknown, warnings: string[]): ExplorationMap[] | null {
    const raw = this.extractJsonField(rawJson, 'explorationMaps', 'exploration_maps');
    if (!Array.isArray(raw)) return null;

    const maps: ExplorationMap[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || !('metadata' in entry) || !('sections' in entry)) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.metadata !== 'object' || !Array.isArray(e.sections)) continue;

      const VALID_SECTION_TYPES = new Set(['inventory', 'topology', 'landscape', 'classification', 'mapping', 'synthesis', 'limitation', 'agenda']);
      const rawSections = e.sections as Array<Record<string, unknown>>;
      const typeFiltered = rawSections
        .filter(s => typeof s.type === 'string' && typeof s.label === 'string' && VALID_SECTION_TYPES.has(s.type as string));
      const metadata = e.metadata as { explorerName?: unknown } | undefined;
      const explorerName = typeof metadata?.explorerName === 'string' ? metadata.explorerName : 'unknown';
      if (typeFiltered.length < rawSections.length) {
        warnings.push(
          `Exploration map (explorer "${explorerName}"): dropped ${rawSections.length - typeFiltered.length} sections ` +
          `with off-vocabulary type; valid types: ${Array.from(VALID_SECTION_TYPES).join(', ')}.`,
        );
      }
      let sections = typeFiltered
        .map(s => this.reshapeSection(s))
        .filter((s): s is Record<string, unknown> & ExplorationSection => this.validateSectionShape(s));

      if (sections.length > MAX_EXPLORATION_MAP_SECTIONS) {
        warnings.push(
          `Exploration map (explorer "${explorerName}") produced ${sections.length} sections, exceeding ` +
          `the wire limit of ${MAX_EXPLORATION_MAP_SECTIONS}; dropping the last ` +
          `${sections.length - MAX_EXPLORATION_MAP_SECTIONS} (mirrors the @uluops/ops-sdk client-side schema cap).`,
        );
        sections = sections.slice(0, MAX_EXPLORATION_MAP_SECTIONS);
      }

      maps.push({
        metadata: e.metadata as ExplorationMap['metadata'],
        sections,
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
  /**
   * Type predicate welding the runtime check to the type claim (issue
   * 62c9f1dd) — the caller's filter narrows to ExplorationSection without a
   * double assertion. LIMITATION: the check verifies the per-type required
   * array exists, not the shape of its members; member shape is guaranteed by
   * reshapeSection for entries-form input and by the LLM schema for typed-form
   * input.
   */
  private validateSectionShape(
    section: Record<string, unknown>,
  ): section is Record<string, unknown> & ExplorationSection {
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
    warnings: string[],
  ): AnalysisRecordInput[] {
    // sanitizeRecordData runs FIRST and the order is load-bearing: every sanitizer below
    // preserves its rejected value by spreading `record.data`, and spreading an array
    // yields {0:…, 1:…}. Normalizing data to a plain object up front is what makes those
    // spreads safe. Moving it later reintroduces the corruption it exists to prevent.
    return this.collectAnalysisRecords(result, analysisBlock, warnings)
      .map(r => this.sanitizeRecordData(r))
      .map(r => this.sanitizeRecordSeverity(r))
      .map(r => this.sanitizeRecordType(r))
      .map(r => this.sanitizeRecordTitle(r))
      .map(r => this.sanitizeRecordClassification(r));
  }

  /**
   * Coerce record severity onto the tracker enum (critical/high/medium/low/info).
   * Lens agents emit register-style severities ("structural", "epistemic", …) that the
   * SDK's input validation rejects wholesale — one off-vocabulary record killed the
   * entire tracking save. Case-normalize onto the enum; anything else becomes null with
   * the original preserved in data.rawSeverity, so the save always goes through.
   */
  private sanitizeRecordSeverity(record: AnalysisRecordInput): AnalysisRecordInput {
    const raw = record.severity;
    if (raw == null) return record;
    const normalized = String(raw).toLowerCase();
    if (VALID_SEVERITIES.has(normalized)) {
      return normalized === raw ? record : { ...record, severity: normalized };
    }
    return {
      ...record,
      severity: null,
      data: { ...(record.data ?? {}), rawSeverity: String(raw) },
    };
  }

  /**
   * Normalize record type onto the tracker's storage contract WITHOUT narrowing the
   * vocabulary. Applied uniformly to every tier — that uniformity is the point.
   *
   * Two defects this replaces:
   *  - Tier 2 coerced any type outside a hardcoded 47-value set to 'evidence_finding'
   *    and preserved the original nowhere, while Tier 1 passed the same value through
   *    untouched. Same field, two policies, chosen by which channel the agent used.
   *  - Tier 1 applied no bound at all, so an empty or over-50-char type reached an API
   *    that requires min(1).max(50) — rejecting the entire save, not just one record.
   *
   * Case-normalizes because the convention is snake_case throughout; without it 'Fear'
   * and 'fear' become distinct types, distinct dashboard badges, and distinct filter
   * results. Safe to apply to a live corpus: censused 2026-08-09 over all 3515 rows in
   * the 2026-07-31 dump (both INSERT statements, extraction control-matched 3515/3515),
   * 307 distinct record types, **zero** carrying any uppercase — so no historical row
   * changes meaning under this rule. Two independent reasons it stays safe if one ever
   * appears: the column collates `utf8mb4_0900_ai_ci`, which is case-insensitive, so
   * SQL filters and GROUP BY do not split on case either way. The residual exposure is
   * application-layer exact-match — e.g. the dashboard tallies types into a JS Map
   * (AnalysisSummaryCards.tsx:41), which IS case-sensitive — and that is precisely what
   * normalizing here prevents. Anything unusable becomes
   * the fallback with the original preserved in data.rawRecordType — the same courtesy
   * sanitizeRecordSeverity extends to severity, so the save always goes through and
   * nothing is lost.
   */
  private sanitizeRecordType(record: AnalysisRecordInput): AnalysisRecordInput {
    const raw: unknown = record.recordType;

    // Only a genuine string can be a record type. Tier 1 spreads the agent's record
    // verbatim, so a fence emitting `"recordType": {}` arrives here as an object — and a
    // bare String() would turn it into "[object object]", 15 characters, comfortably
    // inside the bound, stored as though the agent had declared it. That is worse than
    // the behaviour this method replaces: the old code sent the non-string to the API and
    // got a loud ZodError, whereas a fabricated type is silent and lands in the very
    // corpus this normalization exists to make measurable. Arrays ("a,b") and numbers
    // ("123") fail the same way. Non-strings take the fallback and keep their original
    // shape in data.rawRecordType.
    const isUsable = typeof raw === 'string';
    const normalized = isUsable ? raw.trim().toLowerCase() : '';

    if (normalized.length > 0 && normalized.length <= ANALYSIS_RECORD_TYPE_MAX_LENGTH) {
      return normalized === raw ? record : { ...record, recordType: normalized };
    }

    // Preserve only when there was something to preserve. A missing, null or blank type
    // carries no information, and writing rawRecordType:"" onto every such record would
    // be noise in the one field consumers read for the record's actual content. A
    // non-string always carries information — it is a bug in the emitting agent, and the
    // shape is the evidence — so it is serialized rather than dropped.
    const hasContent = isUsable ? normalized.length > 0 : raw != null;
    // hasContent === false means the fallback was taken with nothing to preserve — a
    // genuinely blank or missing recordType, indistinguishable at this point from a
    // Tier 3/4-derived record that never declared one at all. Mark that specific case so
    // a later reader can tell "agent declared evidence_finding" apart from "agent declared
    // nothing and this is the fallback" — without adding rawRecordType:"" noise to the
    // field consumers read for content (see the comment above this branch).
    const preserved = hasContent
      ? { rawRecordType: isUsable ? raw : safeStringify(raw) }
      : { recordTypeSource: 'fallback-blank' };
    return {
      ...record,
      recordType: FALLBACK_RECORD_TYPE,
      data: { ...(record.data ?? {}), ...preserved },
    };
  }

  /**
   * Bound the record title to the API's `min(1).max(500)` without discarding it.
   *
   * Title is prose, so an over-length one is truncated rather than replaced — a clipped
   * title still identifies the finding, where a generic fallback would not. The full text
   * is kept in data.rawTitle so nothing is lost. A missing, blank or non-string title has
   * no prose to salvage and takes the fallback instead; non-strings keep their shape in
   * data.rawTitle for the same reason recordType does — `String({})` would otherwise store
   * "[object Object]" as the human-readable title of the record.
   */
  private sanitizeRecordTitle(record: AnalysisRecordInput): AnalysisRecordInput {
    const raw: unknown = record.title;
    const isUsable = typeof raw === 'string';
    const trimmed = isUsable ? raw.trim() : '';

    if (trimmed.length > 0 && trimmed.length <= ANALYSIS_RECORD_TITLE_MAX_LENGTH) {
      return trimmed === raw ? record : { ...record, title: trimmed };
    }

    if (trimmed.length > ANALYSIS_RECORD_TITLE_MAX_LENGTH) {
      return {
        ...record,
        title: `${trimmed.slice(0, ANALYSIS_RECORD_TITLE_MAX_LENGTH - 1)}…`,
        data: { ...(record.data ?? {}), rawTitle: trimmed },
      };
    }

    const preserved = !isUsable && raw != null ? { rawTitle: safeStringify(raw) } : {};
    return {
      ...record,
      title: FALLBACK_RECORD_TITLE,
      data: { ...(record.data ?? {}), ...preserved },
    };
  }

  /**
   * Bound the record classification to the API's `max(50)`, which is nullish-optional.
   *
   * Unlike title, classification is a categorical label — a truncated category is a
   * *different* category, and silently inventing one is worse than declaring none. So an
   * over-length or non-string classification becomes null with the original preserved in
   * data.rawClassification, mirroring how sanitizeRecordSeverity handles an off-vocabulary
   * severity. A blank classification is simply null: the field is optional and there is
   * nothing to preserve.
   */
  private sanitizeRecordClassification(record: AnalysisRecordInput): AnalysisRecordInput {
    const raw: unknown = record.classification;
    if (raw == null) return record;

    const isUsable = typeof raw === 'string';
    const trimmed = isUsable ? raw.trim() : '';

    if (trimmed.length > 0 && trimmed.length <= ANALYSIS_RECORD_CLASSIFICATION_MAX_LENGTH) {
      return trimmed === raw ? record : { ...record, classification: trimmed };
    }

    const preserved = trimmed.length > 0
      ? { rawClassification: trimmed }
      : (isUsable ? {} : { rawClassification: safeStringify(raw) });
    return {
      ...record,
      classification: null,
      data: { ...(record.data ?? {}), ...preserved },
    };
  }

  /**
   * Coerce record data onto the API's `z.record(z.string(), z.unknown())`.
   *
   * This is the last field in the per-record contract with no guard, and it fails harder
   * than it looks. Measured against the SDK's own schema: a plain object is accepted, and
   * **every other shape is rejected** — arrays (including `[]`), null, undefined, and
   * primitives alike. Because the SDK validates the whole `analysisRecords` array before
   * the network, any one of those loses the entire run's analysis, exactly like an
   * over-length title.
   *
   * The array case is not hypothetical: the structured-output contract expresses data as
   * `[{key, value}]` entries, and agents cross the wires between that and the object form.
   * Tier 2 converted entries inline; Tier 1 did not, so a fenced record carrying the
   * entries shape was a save-killer. The conversion moved here so all four tiers get it.
   *
   * Anything genuinely unrepresentable is preserved under a single `rawData` key rather
   * than dropped — including a non-entries array, which the old inline conversion turned
   * into `{undefined: undefined}` by mapping absent `.key` fields.
   */
  private sanitizeRecordData(record: AnalysisRecordInput): AnalysisRecordInput {
    const raw: unknown = record.data;

    if (raw == null) {
      return { ...record, data: {} };
    }

    if (Array.isArray(raw)) {
      if (raw.length === 0) return { ...record, data: {} };
      const isEntries = raw.every(
        (e): e is { key: unknown; value: unknown } =>
          !!e && typeof e === 'object' && !Array.isArray(e) && 'key' in e,
      );
      return isEntries
        ? { ...record, data: Object.fromEntries(raw.map(e => [String(e.key), e.value])) }
        : { ...record, data: { rawData: raw } };
    }

    if (typeof raw !== 'object') {
      return { ...record, data: { rawData: raw } };
    }

    return record;
  }

  private collectAnalysisRecords(
    result: AgentResult,
    analysisBlock: AgentAnalysisBlock | null,
    warnings: string[],
  ): AnalysisRecordInput[] {
    // Tier 1: analysis block records (JSON code fence)
    if (analysisBlock?.records && Array.isArray(analysisBlock.records) && analysisBlock.records.length > 0) {
      return analysisBlock.records.map(rec => ({
        ...rec,
        agentName: rec.agentName ?? result.name,
      }));
    }

    // Tier 2: structured output analysisRecords
    const structuredRecords = this.extractStructuredRecords(result.rawJson, result.name, warnings);
    if (structuredRecords.length > 0) {
      return structuredRecords;
    }

    // Tier 3: derived from exploration maps
    const mapRecords = this.deriveRecordsFromExplorationMaps(result.rawJson, result.name, warnings);
    if (mapRecords.length > 0) {
      return mapRecords;
    }

    // Tier 4: auto-generated from recommendations
    return result.recommendations.map(rec => ({
      agentName: result.name,
      // Always the fallback. This previously read
      //   rec.failureDomain && VALID_RECORD_TYPES.has(rec.failureDomain) ? rec.failureDomain : ...
      // which could never take the first branch: failureDomain is STR|SEM|PRA|EPI and no
      // failure domain was ever a member of that set. The intent was presumably to carry the
      // domain through as a type; it never did, and domain is not a record type anyway —
      // it stays available on the record via data.failureMode and the classification code.
      recordType: FALLBACK_RECORD_TYPE,
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
   *
   * Entries-based data (`[{key, value}]`) used to be converted here, which meant Tier 1
   * never got the conversion and a fenced record carrying that shape was a save-killer.
   * It now happens in sanitizeRecordData, for every tier — and handles the non-entries
   * array this inline version silently turned into `{undefined: undefined}`.
   */
  private extractStructuredRecords(rawJson: unknown, agentName: string, warnings: string[]): AnalysisRecordInput[] {
    const raw = this.extractJsonField(rawJson, 'analysisRecords', 'analysis_records');
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const filtered = raw.filter((r): r is Record<string, unknown> =>
      r && typeof r === 'object' && 'recordType' in r && 'recordId' in r && 'title' in r,
    );
    if (filtered.length < raw.length) {
      warnings.push(
        `Tier-2 analysisRecords: dropped ${raw.length - filtered.length} of ${raw.length} records missing ` +
        `recordType/recordId/title (pre-sanitizer filter).`,
      );
    }

    return filtered.map(r => {
      // recordType, title, classification and data are forwarded UNCONVERTED — deliberately.
      // The tier filter admits any record carrying these keys, whatever their JSON type,
      // and a String() here would erase that type before the sanitizers can see it:
      // String({}) is "[object Object]", which every downstream bound then happily accepts
      // and stores as though the agent had declared it. The sanitizers applied in
      // buildAnalysisRecords are the single place these fields are typed and bounded, for
      // all four tiers at once. The casts below are the price of that ordering; they are
      // safe precisely because nothing consumes these values before sanitization.
      return {
        agentName,
        recordType: r.recordType as string,
        recordId: this.safeRecordId(String(r.recordId), `${agentName}/${String(r.title)}`),
        title: r.title as string,
        classification: (r.classification ?? null) as string | null,
        severity: r.severity ? String(r.severity) : null,
        data: r.data as Record<string, unknown>,
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
  private deriveRecordsFromExplorationMaps(rawJson: unknown, agentName: string, warnings: string[]): AnalysisRecordInput[] {
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
          // Count every candidate item (even past the cap) so the warning below can
          // report an exact drop count, rather than breaking immediately like the
          // pre-fix three-level `if (counter > 100) break;` did.
          if (counter > 100) continue;

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
      }
    }

    if (counter > 100) {
      warnings.push(`Exploration-map-derived records capped at 100; ${counter - 100} items not converted.`);
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
