import type { AgentType } from '../types/execution.js';
import type { Issue, ArtifactResult } from '../types/command.js';
import type {
  ParsedOutput,
  ParsedCategory,
  ParsedFinding,
  ExtractionOptions,
  ExtractionResult,
} from '../types/parser.js';
import { ParseError } from '../errors/index.js';

/**
 * Extracts structured output from LLM responses using a 3-strategy fallback:
 * 1. JSON code fence (highest confidence)
 * 2. Inline JSON detection
 * 3. Structured text pattern matching (lowest confidence)
 */
export class OutputExtractor {
  private static readonly INLINE_JSON_PATTERN = /\{[\s\S]*?(?:"decision"|"status"|"score")[\s\S]*?\}/;
  private static readonly STRUCTURED_PATTERNS = {
    decision: /(?:decision|status|result)\s*[:=]\s*["']?(\w+)["']?/i,
    // Section-header style: "DECISION" on its own line followed by separator, then decision value
    sectionDecision: /^DECISION\s*\n[━═─\-]+\n+[✅❌⚠️🔴🟡]*\s*(PASS|FAIL|WARN|WARNING|ERROR|SHIP|REJECT|SKIP)\b/im,
    // Emoji-prefixed: "✅ PASS" anywhere in text
    emojiDecision: /[✅❌⚠️🔴🟡🟢]\s*(PASS|FAIL|WARN|WARNING|ERROR|SHIP|REJECT)\b/i,
    score: /(?:score|points)\s*[:=]\s*(\d+(?:\.\d+)?)/i,
    // Score with denominator: "95/100"
    scoreFraction: /(?:score|points)\s*[:=]?\s*(\d+)\s*\/\s*(\d+)/i,
    maxScore: /(?:max(?:imum)?[\s_]?score|out[\s_]?of|total)\s*[:=]\s*(\d+)/i,
    // Issue line: "- description: file/path.ts:123 [CODE]"
    issueLine: /^[\s]*[-•🟡🔴🟠🔵]\s+(.+?):\s+([\w/.-]+\.(?:ts|js|tsx|jsx|py|go|rs|java|rb|css|html|json|yaml|yml|toml|md)):(\d+)\s*(?:\[([^\]]+)\])?/gm,
  };

  /**
   * Extract structured output from LLM response text
   */
  extract(
    content: string,
    agentType: AgentType,
    options: ExtractionOptions = {},
  ): ParsedOutput {
    const result = this.extractWithMetadata(content, agentType, options);
    return result.output;
  }

  /**
   * Extract with full metadata about extraction method and confidence
   */
  extractWithMetadata(
    content: string,
    agentType: AgentType,
    options: ExtractionOptions = {},
  ): ExtractionResult {
    const warnings: string[] = [];

    // Strategy 1: Try JSON code fence (highest confidence)
    const fenceResult = this.extractFromCodeFence(content, options);
    if (fenceResult) {
      return {
        output: this.normalizeOutput(fenceResult, agentType),
        method: 'json_code_fence',
        confidence: 0.95,
        warnings,
      };
    }

    // Strategy 1b: Try parsing trimmed content as whole JSON object
    const wholeJsonResult = this.extractWholeJson(content);
    if (wholeJsonResult) {
      return {
        output: this.normalizeOutput(wholeJsonResult, agentType),
        method: 'inline_json',
        confidence: 0.9,
        warnings,
      };
    }

    // Strategy 2: Try inline JSON detection
    const inlineResult = this.extractInlineJson(content);
    if (inlineResult) {
      warnings.push('Extracted from inline JSON - consider using code fence for reliability');
      return {
        output: this.normalizeOutput(inlineResult, agentType),
        method: 'inline_json',
        confidence: 0.75,
        warnings,
      };
    }

    // Strategy 3: Fall back to structured text parsing
    const textResult = this.extractFromStructuredText(content, agentType);
    if (textResult) {
      warnings.push('Extracted from structured text patterns - JSON output recommended');
      return {
        output: textResult,
        method: 'structured_text',
        confidence: 0.5,
        warnings,
      };
    }

    // Extraction failed
    if (options.strict) {
      throw new ParseError(
        'Failed to extract structured output from response',
        content.substring(0, 500),
      );
    }

    return {
      output: {
        decision: 'ERROR',
        score: 0,
      },
      method: 'structured_text',
      confidence: 0,
      warnings: ['Could not extract structured output from response'],
    };
  }

  private extractFromCodeFence(
    content: string,
    options: ExtractionOptions,
  ): unknown | null {
    const lang = options.codeFenceLanguage ?? 'json';
    const pattern = new RegExp(`\`\`\`(?:${lang})?\\s*\\n([\\s\\S]*?)\\n\`\`\``, 'g');

    const matches = [...content.matchAll(pattern)];
    if (matches.length === 0) return null;

    const lastMatch = matches[matches.length - 1];
    if (!lastMatch?.[1]) return null;
    try {
      return JSON.parse(lastMatch[1].trim()) as unknown;
    } catch {
      return null;
    }
  }

  private extractWholeJson(content: string): unknown | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // Not valid JSON
    }
    return null;
  }

  private extractInlineJson(content: string): unknown | null {
    const match = content.match(OutputExtractor.INLINE_JSON_PATTERN);
    if (!match) return null;

    // For multi-step LLM output, the final JSON report is often at the end.
    // Find all valid JSON objects and pick the best one (largest with agent output fields).
    const candidates: { index: number; parsed: Record<string, unknown>; length: number }[] = [];
    let searchFrom = content.length - 1;
    for (let found = 0; found < 50 && searchFrom >= 0; searchFrom--) {
      if (content[searchFrom] === '{') {
        const jsonStr = this.extractBalancedJson(content, searchFrom);
        if (jsonStr && jsonStr.length >= 20) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (typeof parsed === 'object' && parsed !== null) {
              candidates.push({ index: searchFrom, parsed, length: jsonStr.length });
            }
          } catch { /* skip */ }
        }
        found++;
      }
    }
    // Also try from the first regex match
    const firstMatchIndex = content.indexOf(match[0]);
    if (!candidates.some(c => c.index === firstMatchIndex)) {
      const jsonStr = this.extractBalancedJson(content, firstMatchIndex);
      if (jsonStr && jsonStr.length >= 20) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (typeof parsed === 'object' && parsed !== null) {
            candidates.push({ index: firstMatchIndex, parsed, length: jsonStr.length });
          }
        } catch { /* skip */ }
      }
    }

    if (candidates.length === 0) return null;

    // Prefer the largest JSON object — the final report is typically the biggest.
    // Among ties, prefer objects with more agent-relevant fields.
    const agentFields = ['decision', 'final_decision', 'score', 'status', 'categories',
      'validation_results', 'validation_summary', 'validations', 'validationResults',
      'breakdown', 'issues', 'issues_found', 'summary', 'recommendations'];
    const scored = candidates.map(c => {
      const fieldCount = agentFields.filter(f => f in c.parsed).length;
      return { ...c, fieldCount };
    });
    // Sort by length desc (largest JSON object), then by field count desc
    scored.sort((a, b) => b.length - a.length || b.fieldCount - a.fieldCount);
    return scored[0]!.parsed;
  }

  private extractBalancedJson(content: string, startIndex: number): string | null {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < content.length; i++) {
      const char = content[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          return content.substring(startIndex, i + 1);
        }
      }
    }

    return null;
  }

  private extractFromStructuredText(
    content: string,
    agentType: AgentType,
  ): ParsedOutput | null {
    const patterns = OutputExtractor.STRUCTURED_PATTERNS;

    // Try multiple decision patterns in priority order
    const decisionMatch = content.match(patterns.decision)
      ?? content.match(patterns.sectionDecision)
      ?? content.match(patterns.emojiDecision);
    const scoreMatch = content.match(patterns.scoreFraction)
      ?? content.match(patterns.score);

    if (!decisionMatch && !scoreMatch) {
      return null;
    }

    const output: ParsedOutput = {
      decision: decisionMatch
        ? this.normalizeDecision(decisionMatch[1] ?? '', agentType)
        : 'UNKNOWN',
    };

    if (scoreMatch?.[1]) {
      output.score = parseFloat(scoreMatch[1]);
    }

    if (agentType === 'validator') {
      // Extract maxScore from fraction pattern (95/100) or explicit pattern
      if (scoreMatch?.[2]) {
        output.maxScore = parseInt(scoreMatch[2], 10);
      } else {
        const maxScoreMatch = content.match(patterns.maxScore);
        if (maxScoreMatch?.[1]) {
          output.maxScore = parseInt(maxScoreMatch[1], 10);
        }
      }

      // Extract issues from structured text (warning/suggestion lines with file:line references)
      const issues = this.extractIssuesFromText(content);
      if (issues.length > 0) {
        output.categories = [{
          name: 'Extracted Issues',
          score: output.score ?? 0,
          maxScore: output.maxScore ?? 100,
          findings: [{
            criterion: 'Text-extracted findings',
            pointsEarned: 0,
            pointsPossible: 0,
            issues,
          }],
        }];
      }
    }

    return output;
  }

  private extractIssuesFromText(content: string): Issue[] {
    const issues: Issue[] = [];
    const pattern = OutputExtractor.STRUCTURED_PATTERNS.issueLine;
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const [, title, filePath, lineStr, failureCode] = match;
      if (title && filePath) {
        issues.push({
          title: title.trim(),
          priority: this.inferPriorityFromContext(content, match.index),
          severity: this.inferSeverityFromContext(content, match.index),
          failureCode: failureCode?.trim(),
          filePath,
          lineNumber: lineStr ? parseInt(lineStr, 10) : undefined,
          description: title.trim(),
        });
      }
    }
    return issues;
  }

  private inferPriorityFromContext(content: string, matchIndex: number): 'critical' | 'suggested' | 'backlog' {
    // Look backwards from match for section headers
    const preceding = content.slice(Math.max(0, matchIndex - 200), matchIndex).toLowerCase();
    if (preceding.includes('critical') || preceding.includes('blocker') || preceding.includes('🔴')) return 'critical';
    if (preceding.includes('suggestion') || preceding.includes('consider') || preceding.includes('🔵')) return 'backlog';
    return 'suggested';
  }

  private inferSeverityFromContext(content: string, matchIndex: number): 'critical' | 'high' | 'medium' | 'low' | 'info' {
    const preceding = content.slice(Math.max(0, matchIndex - 200), matchIndex).toLowerCase();
    if (preceding.includes('critical') || preceding.includes('🔴')) return 'critical';
    if (preceding.includes('warning') || preceding.includes('🟡')) return 'medium';
    if (preceding.includes('suggestion') || preceding.includes('🔵')) return 'low';
    return 'medium';
  }

  /** Resolved source objects from common nesting patterns. Reduces parameter passing across resolve methods. */
  private buildParseSources(obj: Record<string, unknown>) {
    const result = this.asRecord(obj['result']);
    const summary = this.asRecord(obj['summary']) ?? this.asRecord(result?.['summary']);
    const report = this.asRecord(obj['report']);
    const reportResults = this.asRecord(report?.['results']) ?? this.asRecord(obj['results']);
    const reportSummary = this.asRecord(report?.['summary']) ?? this.asRecord(reportResults?.['summary']);
    const validationSummary = this.findWrapperWithScoreOrDecision(obj);
    return { obj, result, summary, report, reportResults, reportSummary, validationSummary };
  }

  private normalizeOutput(raw: unknown, agentType: AgentType): ParsedOutput {
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
      output.score = parseFloat(rawScore);
    }

    this.resolveAgentFields(output, sources);

    if (Array.isArray(obj['artifacts'])) {
      output.artifacts = this.parseArtifacts(obj['artifacts']);
    }

    return output;
  }

  private resolveAgentFields(
    output: ParsedOutput,
    sources: ReturnType<OutputExtractor['buildParseSources']>,
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
      output.maxScore = parseInt(rawMaxScore, 10);
    }

    // Resolve categories
    output.categories = this.resolveCategories(obj, result, report);

    // If no score found but categories exist, sum category scores
    if (output.score === undefined && output.categories && output.categories.length > 0) {
      output.score = output.categories.reduce((sum, c) => sum + c.score, 0);
    }

    // Resolve flat issues and attach to categories
    this.attachFlatIssues(output, sources);
  }

  private attachFlatIssues(
    output: ParsedOutput,
    sources: ReturnType<OutputExtractor['buildParseSources']>,
  ): void {
    const flatIssues = this.resolveIssuesFlat(sources.obj, sources.result, sources.report, sources.validationSummary);
    if (flatIssues.length === 0) return;

    const issuesFinding = {
      criterion: 'Extracted findings',
      pointsEarned: 0,
      pointsPossible: 0,
      issues: flatIssues,
    };
    if (!output.categories || output.categories.length === 0) {
      output.categories = [{
        name: 'Extracted Issues',
        score: output.score ?? 0,
        maxScore: output.maxScore ?? 100,
        findings: [issuesFinding],
      }];
    } else {
      const emptyCategory = output.categories.find(c => c.findings.length === 0);
      if (emptyCategory) {
        emptyCategory.findings.push(issuesFinding);
      } else {
        output.categories.push({
          name: 'Extracted Issues',
          score: output.score ?? 0,
          maxScore: output.maxScore ?? 100,
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
    ctx: ReturnType<OutputExtractor['buildParseSources']>,
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
    ctx: ReturnType<OutputExtractor['buildParseSources']>,
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
    // Check breakdown with sub-scores sum (search wrapper objects too)
    const wrapper = this.findWrapperWithScoreOrDecision(obj);
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
  ): ParsedCategory[] | undefined {
    // Direct categories array
    for (const source of [obj, result, report]) {
      if (!source) continue;
      if (Array.isArray(source['categories'])) {
        return this.parseCategories(source['categories']);
      }
    }

    // Named scores object → synthetic categories (e.g., { scores: { "Code Quality": 23, ... } })
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
    const wrapper = this.findWrapperWithScoreOrDecision(obj);
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

    return issues;
  }

  private normalizeDecision(decision: string, agentType: AgentType): string {
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

  private parseCategories(raw: unknown[]): ParsedCategory[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map(item => ({
        name: String(item['name'] ?? item['category'] ?? 'Unknown'),
        score: Number(item['score'] ?? item['points'] ?? 0),
        maxScore: Number(item['maxScore'] ?? item['maxPoints'] ?? item['max_points'] ?? item['total'] ?? 100),
        findings: this.parseFindings(
          Array.isArray(item['findings']) ? item['findings'] : [],
        ),
      }));
  }

  private parseFindings(raw: unknown[]): ParsedFinding[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map(item => ({
        criterion: String(item['criterion'] ?? item['name'] ?? 'Unknown'),
        pointsEarned: Number(item['pointsEarned'] ?? item['points_earned'] ?? item['score'] ?? 0),
        pointsPossible: Number(item['pointsPossible'] ?? item['points_possible'] ?? item['maxScore'] ?? item['maxPoints'] ?? 0),
        issues: this.parseIssues(
          Array.isArray(item['issues']) ? item['issues'] : [],
        ),
      }));
  }

  private parseIssues(raw: unknown[]): Issue[] {
    // Flatten grouped issues: [{severity: "CRITICAL", issues: [...]}, ...] → flat array
    const flatItems: Record<string, unknown>[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (Array.isArray(rec['issues'])) {
        // This is a group — recurse into the nested issues array, inheriting severity
        const groupSeverity = rec['severity'] as string | undefined;
        for (const sub of rec['issues'] as unknown[]) {
          if (typeof sub === 'object' && sub !== null) {
            const subRec = sub as Record<string, unknown>;
            if (groupSeverity && !subRec['severity']) subRec['severity'] = groupSeverity;
            flatItems.push(subRec);
          }
        }
      } else {
        flatItems.push(rec);
      }
    }
    return flatItems
      .map(item => {
        // Resolve file path and line number from various shapes
        let filePath = (item['filePath'] as string | undefined)
          ?? (item['file_path'] as string | undefined)
          ?? (item['file'] as string | undefined);
        let lineNumber = typeof item['lineNumber'] === 'number'
          ? item['lineNumber']
          : typeof item['line_number'] === 'number'
            ? item['line_number']
            : typeof item['line'] === 'number'
              ? item['line']
              : typeof item['line_start'] === 'number'
                ? item['line_start']
                : undefined;

        // Handle line as string: "24-50" or "24"
        if (lineNumber === undefined && typeof item['line'] === 'string') {
          const lineMatch = item['line'].match(/^(\d+)/);
          if (lineMatch) lineNumber = parseInt(lineMatch[1]!, 10);
        }
        if (lineNumber === undefined && typeof item['line_number'] === 'string') {
          const lineMatch = item['line_number'].match(/^(\d+)/);
          if (lineMatch) lineNumber = parseInt(lineMatch[1]!, 10);
        }
        if (lineNumber === undefined && typeof item['lineNumber'] === 'string') {
          const lineMatch = (item['lineNumber'] as string).match(/^(\d+)/);
          if (lineMatch) lineNumber = parseInt(lineMatch[1]!, 10);
        }

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

        // Resolve title: prefer explicit title/message, fall back to issue/summary/description/name
        const hasExplicitTitle = item['title'] !== undefined || item['message'] !== undefined
          || item['issue'] !== undefined || item['summary'] !== undefined;
        const title = String(
          item['title'] ?? item['message'] ?? item['issue'] ?? item['summary']
          ?? item['name'] ?? item['description'] ?? 'Untitled Issue',
        );
        // For description: if title consumed 'description', use explanation/suggestion/recommendation instead
        const detailsStr = typeof item['details'] === 'string' ? item['details'] : undefined;
        const description = hasExplicitTitle
          ? String(item['description'] ?? detailsStr ?? item['explanation'] ?? item['suggestion'] ?? item['recommendation'] ?? '')
          : String(item['explanation'] ?? detailsStr ?? item['suggestion'] ?? item['recommendation'] ?? item['description'] ?? '');

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
