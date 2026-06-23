import type { AgentType } from '../types/execution.js';
import type { Issue, ArtifactResult } from '../types/command.js';
import type {
  ParsedOutput,
  ParsedCategory,
  ParsedFinding,
} from '../types/parser.js';

/** Resolved source objects from common nesting patterns in LLM output JSON. */
interface ParseSources {
  obj: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
  summary: Record<string, unknown> | undefined;
  report: Record<string, unknown> | undefined;
  reportResults: Record<string, unknown> | undefined;
  reportSummary: Record<string, unknown> | undefined;
  validationSummary: Record<string, unknown> | undefined;
}

/**
 * Normalizes parsed JSON from diverse LLM output shapes into the unified ParsedOutput type.
 *
 * Handles score resolution, decision resolution, category resolution, issue resolution,
 * and artifact parsing across all supported models (Claude, GPT-5, Gemini, etc.).
 *
 * Each new LLM model that produces a novel output shape requires changes here —
 * the extraction strategies in OutputExtractor remain stable.
 */
export class OutputNormalizer {
  normalizeOutput(raw: unknown, agentType: AgentType): ParsedOutput {
    if (!raw || typeof raw !== 'object') {
      return { decision: 'ERROR' };
    }

    const obj = raw as Record<string, unknown>;
    const sources = this.buildParseSources(obj);

    const output: ParsedOutput = {
      decision: this.normalizeDecision(this.resolveDecisionField(sources), agentType),
      rawJson: raw,
    };

    // Resolve score
    const rawScore = this.resolveScoreField(sources);
    if (typeof rawScore === 'number') {
      output.score = rawScore;
    } else if (typeof rawScore === 'string') {
      const parsed = parseFloat(rawScore);
      if (!isNaN(parsed)) output.score = parsed;
    }

    this.resolveAgentFields(output, sources);

    if (Array.isArray(obj['artifacts'])) {
      output.artifacts = this.parseArtifacts(obj['artifacts']);
    }

    return output;
  }

  normalizeDecision(decision: string, agentType: AgentType): string {
    // Strip emojis and non-ASCII symbols before processing
    const cleaned = decision.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]/gu, '').trim();
    const upper = cleaned.toUpperCase().trim();
    // Extract first word for labels like "PASS - Ready for next phase"
    const firstWord = upper.split(/[\s\-–—]+/)[0] ?? upper;

    if (agentType === 'validator') {
      if (['PASS', 'PASSED', 'OK', 'SUCCESS'].includes(firstWord)) return 'PASS';
      if (['WARN', 'WARNING', 'CAUTION'].includes(firstWord)) return 'WARN';
      if (['FAIL', 'FAILED', 'ERROR', 'REJECT'].includes(firstWord)) return 'FAIL';
    }

    if (agentType === 'executor') {
      if (['SUCCESS', 'COMPLETE', 'DONE', 'PASS'].includes(firstWord)) return 'COMPLETE';
      if (['PARTIAL', 'INCOMPLETE'].includes(firstWord)) return 'PARTIAL';
      if (['FAIL', 'FAILED', 'ERROR'].includes(firstWord)) return 'FAILED';
    }

    return upper;
  }

  /** Build resolved source objects from common nesting patterns. Reduces parameter passing across resolve methods. */
  private buildParseSources(obj: Record<string, unknown>): ParseSources {
    const result = this.asRecord(obj['result']);
    const summary = this.asRecord(obj['summary']) ?? this.asRecord(result?.['summary']);
    const report = this.asRecord(obj['report']);
    const reportResults = this.asRecord(report?.['results']) ?? this.asRecord(obj['results']);
    const reportSummary = this.asRecord(report?.['summary']) ?? this.asRecord(reportResults?.['summary']);
    const validationSummary = this.findWrapperWithScoreOrDecision(obj);
    return { obj, result, summary, report, reportResults, reportSummary, validationSummary };
  }

  private resolveAgentFields(
    output: ParsedOutput,
    sources: ParseSources,
  ): void {
    const { obj, result, summary, report } = sources;

    // Resolve maxScore
    const rawMaxScore = obj['maxScore'] ?? obj['max_score']
      ?? result?.['max_score'] ?? result?.['maxScore']
      ?? summary?.['max_score'] ?? summary?.['maxScore']
      ?? obj['pass_threshold'];
    if (typeof rawMaxScore === 'number') {
      output.maxScore = rawMaxScore;
    } else if (typeof rawMaxScore === 'string') {
      const parsed = parseInt(rawMaxScore, 10);
      if (!isNaN(parsed)) output.maxScore = parsed;
    }

    // Resolve categories
    output.categories = this.resolveCategories(obj, result, report, sources.validationSummary);

    // If no score found but categories exist, sum present (non-null) category scores.
    // Scoreless categories (null) are skipped — not summed as 0 (no fabrication).
    if (output.score === undefined && output.categories && output.categories.length > 0) {
      const present = output.categories
        .map(c => c.score)
        .filter((s): s is number => s !== null);
      if (present.length > 0) {
        output.score = present.reduce((sum, s) => sum + s, 0);
      }
    }

    // Resolve flat issues and attach to categories
    this.attachFlatIssues(output, sources);
  }

  private attachFlatIssues(
    output: ParsedOutput,
    sources: ParseSources,
  ): void {
    const flatIssues = this.resolveIssuesFlat(sources.obj, sources.result, sources.report, sources.validationSummary);
    if (flatIssues.length === 0) return;

    const issuesFinding = {
      criterion: 'Extracted findings',
      pointsEarned: null,
      pointsPossible: null,
      issues: flatIssues,
    };
    // Pair-resolution for the synthetic "Extracted Issues" category: a null pair for
    // scoreless agents (generators), else the top-level score with its scale.
    const catScore = output.score ?? null;
    const catMaxScore = catScore === null ? null : (output.maxScore ?? 100);
    if (!output.categories || output.categories.length === 0) {
      output.categories = [{
        name: 'Extracted Issues',
        score: catScore,
        maxScore: catMaxScore,
        findings: [issuesFinding],
      }];
    } else {
      const emptyCategory = output.categories.find(c => c.findings.length === 0);
      if (emptyCategory) {
        emptyCategory.findings.push(issuesFinding);
      } else {
        output.categories.push({
          name: 'Extracted Issues',
          score: catScore,
          maxScore: catMaxScore,
          findings: [issuesFinding],
        });
      }
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return (value && typeof value === 'object' && !Array.isArray(value))
      ? value as Record<string, unknown>
      : undefined;
  }

  /**
   * Scan all top-level object values for one that contains 'score' or 'decision'.
   * Handles arbitrary wrapper names (validation, validations, validationResults, etc.)
   * without whitelisting specific field names.
   */
  private findWrapperWithScoreOrDecision(obj: Record<string, unknown>): Record<string, unknown> | undefined {
    // Skip known non-wrapper fields
    const skip = new Set(['issues', 'categories', 'recommendations', 'evidence',
      'reasoning', 'reasoning_trace', 'notes', 'auto_fail_conditions', 'filesReviewed',
      'files_reviewed', 'artifacts', 'result', 'summary', 'report']);
    for (const [key, value] of Object.entries(obj)) {
      if (skip.has(key)) continue;
      const rec = this.asRecord(value);
      if (!rec) continue;
      if ('score' in rec || 'score_total' in rec || 'total_score' in rec || 'decision' in rec || 'status' in rec || 'breakdown' in rec || 'score_breakdown' in rec) {
        return rec;
      }
    }
    return undefined;
  }

  private resolveDecisionField(
    ctx: ParseSources,
  ): string {
    const { obj } = ctx;
    const sources = [ctx.obj, ctx.summary, ctx.result, ctx.report, ctx.reportResults, ctx.reportSummary, ctx.validationSummary];
    // Check each source for decision/final_decision fields
    for (const source of sources) {
      if (!source) continue;
      for (const key of ['decision', 'final_decision']) {
        const d = source[key];
        if (typeof d === 'string') return d;
        // Handle decision as object: { pass: true, label: "PASS" } or { result: "PASS" }
        if (d && typeof d === 'object') {
          const dObj = d as Record<string, unknown>;
          if (typeof dObj['result'] === 'string') return dObj['result'];
          if (typeof dObj['label'] === 'string') return dObj['label'];
          if (typeof dObj['value'] === 'string') return dObj['value'];
          if (typeof dObj['status'] === 'string') return dObj['status'];
          if (typeof dObj['pass'] === 'boolean') return dObj['pass'] ? 'PASS' : 'FAIL';
        }
      }
    }
    // Fallback to status field
    for (const source of sources) {
      if (!source) continue;
      if (typeof source['status'] === 'string') return source['status'];
    }
    // Fallback: check if summary is a string starting with a decision word
    if (typeof obj['summary'] === 'string') {
      const summaryFirst = obj['summary'].split(/[\s\-–—]+/)[0]?.toUpperCase();
      if (summaryFirst && ['PASS', 'FAIL', 'WARN', 'ERROR', 'COMPLETE'].includes(summaryFirst)) {
        return summaryFirst;
      }
    }
    return 'UNKNOWN';
  }

  private resolveScoreField(
    ctx: ParseSources,
  ): number | string | undefined {
    const { obj } = ctx;
    const sources = [ctx.obj, ctx.summary, ctx.result, ctx.report, ctx.reportResults, ctx.reportSummary, ctx.validationSummary];
    // Check each source for a score value
    for (const source of sources) {
      if (!source) continue;
      for (const scoreKey of ['score', 'total_score', 'score_total']) {
        const s = source[scoreKey];
        if (typeof s === 'number') return s;
        if (typeof s === 'string' && s.trim() !== '' && !isNaN(Number(s))) return s;
        // Handle score as object: { total: 85, ... }
        if (s && typeof s === 'object') {
          const sObj = s as Record<string, unknown>;
          for (const key of ['total', 'value', 'overall', 'final']) {
            if (typeof sObj[key] === 'number') return sObj[key] as number;
            if (typeof sObj[key] === 'string') return sObj[key] as string;
          }
        }
      }
    }
    // Note: validationSummary (from findWrapperWithScoreOrDecision) is already in the sources loop above.
    // Check scores object with named sub-scores (gpt-4.1-nano shape: { scores: { "Code Quality": 23, ... } })
    const scores = this.asRecord(obj['scores']);
    if (scores) {
      if (typeof scores['Total'] === 'number') return scores['Total'];
      if (typeof scores['total'] === 'number') return scores['total'];
    }
    // Check breakdown with sub-scores sum (use cached wrapper from buildParseSources)
    const wrapper = ctx.validationSummary;
    const breakdown = this.asRecord(obj['breakdown'])
      ?? this.asRecord(obj['score_breakdown'])
      ?? this.asRecord(wrapper?.['breakdown'])
      ?? this.asRecord(wrapper?.['score_breakdown']);
    if (breakdown) {
      const values: number[] = [];
      for (const v of Object.values(breakdown)) {
        if (typeof v === 'number') { values.push(v); continue; }
        // Handle { points: N, deductions: N } shape
        const rec = this.asRecord(v);
        if (rec && typeof rec['points'] === 'number') {
          const deductions = typeof rec['deductions'] === 'number' ? rec['deductions'] as number : 0;
          values.push((rec['points'] as number) - deductions);
        }
      }
      if (values.length > 0) return values.reduce((a, b) => a + b, 0);
    }
    // Check criteria with sub-scores sum (gpt-4.1-nano shape)
    const criteria = this.asRecord(obj['criteria']);
    if (criteria) {
      const values: number[] = [];
      for (const v of Object.values(criteria)) {
        if (typeof v === 'number') { values.push(v); continue; }
        const rec = this.asRecord(v);
        if (rec && typeof rec['score'] === 'number') values.push(rec['score'] as number);
      }
      if (values.length > 0) return values.reduce((a, b) => a + b, 0);
    }
    return undefined;
  }

  private resolveCategories(
    obj: Record<string, unknown>,
    result?: Record<string, unknown>,
    report?: Record<string, unknown>,
    cachedWrapper?: Record<string, unknown>,
  ): ParsedCategory[] | undefined {
    // Direct categories array
    for (const source of [obj, result, report]) {
      if (!source) continue;
      if (Array.isArray(source['categories'])) {
        return this.parseCategories(source['categories']);
      }
    }

    // Named scores object → synthetic categories (e.g., { scores: { "Code Quality": 23, ... } })
    // KEEP: every `cats.push` below carries a REAL extracted numeric `score` (guarded by
    // typeof === 'number'); `maxScore: 100` is that score's legitimate scale, not a
    // fabrication, so both are kept (mirrors PipelineExecutor success aggregate).
    const scores = this.asRecord(obj['scores']) ?? this.asRecord(report?.['scores']);
    if (scores) {
      const cats: ParsedCategory[] = [];
      for (const [name, value] of Object.entries(scores)) {
        if (typeof value === 'number' && name !== 'Total' && name !== 'total' && name !== 'pass_threshold') {
          cats.push({ name, score: value, maxScore: 100, findings: [] });
        }
      }
      if (cats.length > 0) return cats;
    }

    // Breakdown object → synthetic categories
    // Search top-level breakdown, score_breakdown, and inside any wrapper object
    const wrapper = cachedWrapper ?? this.findWrapperWithScoreOrDecision(obj);
    const breakdown = this.asRecord(obj['breakdown'])
      ?? this.asRecord(obj['score_breakdown'])
      ?? this.asRecord(wrapper?.['breakdown'])
      ?? this.asRecord(wrapper?.['score_breakdown']);
    if (breakdown) {
      const cats: ParsedCategory[] = [];
      for (const [name, value] of Object.entries(breakdown)) {
        if (typeof value === 'number') {
          cats.push({ name, score: value, maxScore: 100, findings: [] });
        } else {
          // Handle { points: N, deductions: N } shape
          const rec = this.asRecord(value);
          if (rec && typeof rec['points'] === 'number') {
            const points = rec['points'] as number;
            const deductions = typeof rec['deductions'] === 'number' ? rec['deductions'] as number : 0;
            cats.push({ name, score: points - deductions, maxScore: 100, findings: [] });
          }
        }
      }
      if (cats.length > 0) return cats;
    }

    // Criteria object with nested scores → synthetic categories
    const criteria = this.asRecord(obj['criteria']);
    if (criteria) {
      const cats: ParsedCategory[] = [];
      for (const [name, value] of Object.entries(criteria)) {
        const rec = this.asRecord(value);
        if (rec && typeof rec['score'] === 'number') {
          cats.push({
            name,
            score: rec['score'],
            maxScore: 100,
            findings: this.parseIssues(
              Array.isArray(rec['issues']) ? rec['issues'] : [],
            ).map(issue => ({
              criterion: issue.title,
              pointsEarned: 0,
              pointsPossible: 0,
              issues: [issue],
            })),
          });
        }
      }
      if (cats.length > 0) return cats;
    }

    return undefined;
  }

  private resolveIssuesFlat(
    obj: Record<string, unknown>,
    result?: Record<string, unknown>,
    report?: Record<string, unknown>,
    wrapper?: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];

    // Check multiple issue-like keys across all source objects
    const issueKeys = ['issues', 'recommendations', 'warnings', 'findings'];
    for (const source of [obj, result, report, wrapper]) {
      if (!source) continue;
      for (const key of issueKeys) {
        if (Array.isArray(source[key])) {
          issues.push(...this.parseIssues(source[key] as unknown[]));
          if (issues.length > 0) return issues;
        }
        // Nested: { issues: { items: [...] } } or { issues: { details: [...] } }
        const nested = this.asRecord(source[key]);
        if (nested) {
          const nestedArray = nested['items'] ?? nested['details'] ?? nested['list'];
          if (Array.isArray(nestedArray)) {
            issues.push(...this.parseIssues(nestedArray));
            if (issues.length > 0) return issues;
          }
        }
      }
    }

    // issues_found with warnings/suggestions (gpt-5-mini shape)
    for (const source of [obj, wrapper]) {
      if (!source) continue;
      const issuesFound = this.asRecord(source['issues_found']);
      if (issuesFound) {
        if (Array.isArray(issuesFound['critical'])) {
          issues.push(...this.parseIssues(issuesFound['critical']));
        }
        if (Array.isArray(issuesFound['warnings'])) {
          issues.push(...this.parseIssues(issuesFound['warnings']));
        }
        if (Array.isArray(issuesFound['suggestions'])) {
          issues.push(...this.parseIssues(issuesFound['suggestions']));
        }
      }
    }

    if (issues.length > 0) return issues;

    // Growth trajectory impediments (Gemini analyst shape:
    // { growth_trajectory_assessment: [{ dimension, current_state, latent_capability, impediment }] })
    // Also handles growth_trajectory (variant key).
    const trajectory = (Array.isArray(obj['growth_trajectory_assessment']) ? obj['growth_trajectory_assessment']
      : Array.isArray(obj['growth_trajectory']) ? obj['growth_trajectory']
      : undefined) as Record<string, unknown>[] | undefined;
    if (trajectory) {
      for (const item of trajectory) {
        if (typeof item !== 'object' || item === null) continue;
        const impediment = item['impediment'] as string | undefined;
        if (!impediment) continue;
        issues.push({
          title: `Growth impediment: ${String(item['dimension'] ?? 'Unknown')}`,
          description: `Current: ${String(item['current_state'] ?? '')}. Impediment: ${impediment}`,
          priority: 'backlog',
          severity: 'info',
        });
      }
    }

    // Purpose conflicts (Gemini analyst shape: { purpose_coherence_assessment: { purpose_conflicts: "..." } })
    // Also handles purpose_coherence (variant key).
    const coherence = this.asRecord(obj['purpose_coherence_assessment'])
      ?? this.asRecord(obj['purpose_coherence']);
    if (coherence && typeof coherence['purpose_conflicts'] === 'string') {
      const conflicts = coherence['purpose_conflicts'] as string;
      const isSubstantive = !/no\s+(?:significant\s+|direct\s+|major\s+)?(?:purpose\s+)?conflicts\s+(?:were\s+)?(?:identified|found|detected|noted|observed)/i.test(conflicts);
      if (isSubstantive) {
        issues.push({
          title: 'Purpose conflict identified',
          description: conflicts,
          priority: 'suggested',
          severity: 'medium',
        });
      }
    }

    return issues;
  }

  private parseCategories(raw: unknown[]): ParsedCategory[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map(item => {
        // Pair-resolution with non-null Number() gating: null pair when no score key
        // is present; else the score with its scale (default 100). Avoids null → NaN.
        const sRaw = item['score'] ?? item['points'];
        const score = sRaw == null ? null : Number(sRaw);
        const mRaw = item['maxScore'] ?? item['maxPoints'] ?? item['max_points'] ?? item['total'];
        const maxScore = score === null ? null : (mRaw == null ? 100 : Number(mRaw));
        return {
          name: String(item['name'] ?? item['category'] ?? 'Unknown'),
          score,
          maxScore,
          findings: this.parseFindings(
            Array.isArray(item['findings']) ? item['findings'] : [],
          ),
        };
      });
  }

  private parseFindings(raw: unknown[]): ParsedFinding[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map(item => {
        // Finding points are an independent pair (not bound to score↔maxScore);
        // null-gate each so an absent key stays null instead of fabricating 0.
        const peRaw = item['pointsEarned'] ?? item['points_earned'] ?? item['score'];
        const ppRaw = item['pointsPossible'] ?? item['points_possible'] ?? item['maxScore'] ?? item['maxPoints'];
        return {
          criterion: String(item['criterion'] ?? item['name'] ?? 'Unknown'),
          pointsEarned: peRaw == null ? null : Number(peRaw),
          pointsPossible: ppRaw == null ? null : Number(ppRaw),
          issues: this.parseIssues(
            Array.isArray(item['issues']) ? item['issues'] : [],
          ),
        };
      });
  }

  private parseIssues(raw: unknown[]): Issue[] {
    return this.flattenGroupedIssues(raw)
      .map(item => {
        const { filePath, lineNumber } = this.resolveFileLocation(item);
        const { title, description } = this.resolveIssueText(item);

        return {
          title,
          priority: this.normalizePriority(item['priority'] ?? item['type']),
          severity: this.normalizeSeverity(item['severity']),
          failureCode: (item['failureCode'] as string | undefined)
            ?? (item['failure_code'] as string | undefined)
            ?? (item['code'] as string | undefined),
          filePath,
          lineNumber,
          description,
        };
      });
  }

  /** Flatten grouped issues: [{severity: "CRITICAL", issues: [...]}, ...] → flat array */
  private flattenGroupedIssues(raw: unknown[]): Record<string, unknown>[] {
    const flatItems: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (Array.isArray(rec['issues'])) {
        const groupSeverity = rec['severity'] as string | undefined;
        for (const sub of rec['issues'] as unknown[]) {
          if (typeof sub === 'object' && sub !== null) {
            const subRec = sub as Record<string, unknown>;
            if (groupSeverity && !subRec['severity']) {
              flatItems.push({ ...subRec, severity: groupSeverity });
            } else {
              flatItems.push(subRec);
            }
          }
        }
      } else {
        flatItems.push(rec);
      }
    }
    return flatItems;
  }

  /** Resolve file path and line number from various LLM output shapes */
  private resolveFileLocation(item: Record<string, unknown>): { filePath?: string; lineNumber?: number } {
    let filePath = (item['filePath'] as string | undefined)
      ?? (item['file_path'] as string | undefined)
      ?? (item['file'] as string | undefined);
    let lineNumber = this.resolveLineNumber(item);

    // Handle combined fields: "file_line" or "location" like "src/foo.ts:42-50"
    for (const combinedKey of ['file_line', 'location']) {
      if (!filePath && typeof item[combinedKey] === 'string') {
        const flMatch = (item[combinedKey] as string).match(/^([\w/.@-]+\.\w+):(\d+)/);
        if (flMatch) {
          filePath = flMatch[1];
          lineNumber = lineNumber ?? parseInt(flMatch[2]!, 10);
        } else if (combinedKey === 'file_line') {
          filePath = item[combinedKey] as string;
        }
      }
    }

    // Handle locations array: [{ file: "...", line_start: N }]
    if (!filePath && Array.isArray(item['locations']) && item['locations'].length > 0) {
      const loc = this.asRecord(item['locations'][0]);
      if (loc) {
        filePath = (loc['file'] as string | undefined) ?? (loc['filePath'] as string | undefined);
        lineNumber = lineNumber ?? (typeof loc['line_start'] === 'number' ? loc['line_start'] : undefined);
      }
    }

    return { filePath, lineNumber };
  }

  /** Resolve line number from numeric, string ("24-50"), or named fields */
  private resolveLineNumber(item: Record<string, unknown>): number | undefined {
    for (const key of ['lineNumber', 'line_number', 'line', 'line_start'] as const) {
      const val = item[key];
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const match = val.match(/^(\d+)/);
        if (match) return parseInt(match[1]!, 10);
      }
    }
    return undefined;
  }

  /** Resolve title and description from various naming conventions */
  private resolveIssueText(item: Record<string, unknown>): { title: string; description: string } {
    const hasExplicitTitle = item['title'] !== undefined || item['message'] !== undefined
      || item['issue'] !== undefined || item['summary'] !== undefined;
    const title = String(
      item['title'] ?? item['message'] ?? item['issue'] ?? item['summary']
      ?? item['name'] ?? item['description'] ?? 'Untitled Issue',
    );
    const detailsStr = typeof item['details'] === 'string' ? item['details'] : undefined;
    const description = hasExplicitTitle
      ? String(item['description'] ?? detailsStr ?? item['explanation'] ?? item['suggestion'] ?? item['recommendation'] ?? '')
      : String(item['explanation'] ?? detailsStr ?? item['suggestion'] ?? item['recommendation'] ?? item['description'] ?? '');
    return { title, description };
  }

  private parseArtifacts(raw: unknown[]): ArtifactResult[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map(item => ({
        name: String(item['name'] ?? 'Untitled'),
        path: String(item['path'] ?? ''),
        size: typeof item['size'] === 'number' ? item['size'] : undefined,
        contentType: (item['contentType'] as string | undefined) ?? (item['content_type'] as string | undefined),
      }));
  }

  private normalizePriority(value: unknown): 'critical' | 'suggested' | 'backlog' {
    const str = String(value ?? 'suggested').toLowerCase();
    if (['critical', 'high', 'p0'].includes(str)) return 'critical';
    if (['backlog', 'low', 'p2'].includes(str)) return 'backlog';
    return 'suggested';
  }

  private normalizeSeverity(value: unknown): 'critical' | 'high' | 'medium' | 'low' | 'info' {
    const str = String(value ?? 'medium').toLowerCase();
    if (str === 'critical') return 'critical';
    if (str === 'high') return 'high';
    if (str === 'low') return 'low';
    if (['info', 'informational', 'note'].includes(str)) return 'info';
    return 'medium';
  }
}
