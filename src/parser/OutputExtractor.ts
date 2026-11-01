import type { AgentType } from '../types/execution.js';
import type { Issue } from '../types/command.js';
import type {
  ParsedOutput,
  ExtractionOptions,
  ExtractionResult,
} from '../types/parser.js';
import { ParseError } from '../errors/index.js';
import { OutputNormalizer } from './OutputNormalizer.js';
import { parseExternalNumber } from '../utils/externalValue.js';

/**
 * Extracts structured output from LLM responses using a 4-strategy fallback:
 * 0. AI SDK structured output (highest confidence — schema-validated by the SDK)
 * 1. JSON code fence
 * 2. Inline JSON detection
 * 3. Structured text pattern matching (lowest confidence)
 *
 * Normalization of parsed JSON into the unified ParsedOutput type is delegated
 * to OutputNormalizer, which handles the diversity of LLM output shapes.
 */
export class OutputExtractor {
  private normalizer = new OutputNormalizer();

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
    // Extensions synced with LANG_MAP in ToolHandler.ts — if a language is detectable, issues should be parseable.
    issueLine: /^[\s]*[-•🟡🔴🟠🔵]\s+(.+?):\s+([\w/.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|cpp|c|swift|kt|css|scss|html|json|yaml|yml|toml|md|sql|sh|bash)):(\d+)\s*(?:\[([^\]]+)\])?/gm,
  };

  /**
   * Extract structured output from LLM response text.
   *
   * Convenience wrapper over {@link OutputExtractor.extractWithMetadata} that
   * discards the extraction metadata and returns only the parsed output.
   *
   * @param content - The raw LLM response text.
   * @param agentType - The agent type, used to shape normalization of the parsed output.
   * @param options - Optional extraction options. When `options.structuredOutput` is supplied,
   *   it short-circuits the fallback strategies (confidence 1.0).
   * @returns The normalized {@link ParsedOutput}.
   * @throws {ParseError} If no strategy can extract structured output from the content.
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
   * Extract with full metadata about extraction method and confidence.
   *
   * Tries the strategies in descending confidence and returns the first that
   * succeeds, along with the method used and a confidence score. The ladder has
   * five rungs but `method` has only four values: `inline_json` covers both
   * whole-content JSON and JSON embedded in prose, which are trusted differently.
   * - `1.0` — AI SDK structured output (`options.structuredOutput`, short-circuits the rest)
   * - `0.95` — JSON code fence
   * - `0.9` — whole trimmed content parses as JSON (method `inline_json`)
   * - `0.75` — JSON embedded in surrounding prose (method `inline_json`; emits a warning)
   * - `0.5` — structured-text / regex pattern matching
   * - `0` — nothing extracted; ERROR/null defaults (non-strict mode only)
   *
   * @param content - The raw LLM response text.
   * @param agentType - The agent type, used to shape normalization of the parsed output.
   * @param options - Optional extraction options (e.g. `structuredOutput`).
   * @returns The {@link ExtractionResult} — `output`, `method`, `confidence`, and any `warnings`.
   * @throws {ParseError} If no strategy can extract structured output from the content.
   * @example
   * ```typescript
   * const r = extractor.extractWithMetadata(llmText, 'validator');
   * // r.method:     'json_code_fence' | 'inline_json' | 'structured_text' | 'structured_output'
   * // r.confidence: 1.0 (structured) | 0.95 (fence) | 0.9 (whole JSON)
   * //               | 0.75 (embedded JSON) | 0.5 (regex) | 0 (nothing found)
   * if (r.confidence < 0.7) console.warn('low-confidence extraction', r.warnings); // EXTRACTION_CONFIDENCE_THRESHOLD
   * ```
   */
  extractWithMetadata(
    content: string,
    agentType: AgentType,
    options: ExtractionOptions = {},
  ): ExtractionResult {
    const warnings: string[] = [];

    // ── Extraction strategies (ordered by confidence) ──────────────────────
    // Confidence values are heuristics encoding relative trust in each method.
    // They were calibrated against Claude's output patterns and may need
    // recalibration as new models (GPT, Gemini) are added. The parsed decision
    // is always preserved on the result; SubmissionClient gates on
    // EXTRACTION_CONFIDENCE_THRESHOLD (constants.ts) so a strategy below that
    // threshold yields a decision that is reported but not trusted to pass a gate.
    //
    // Strategy 1: JSON code fence (0.95) — model explicitly wrapped output
    // Strategy 2: Whole/inline JSON (0.9/0.75) — found parseable JSON in text
    // Strategy 3: Structured text (0.5) — regex matched decision/score patterns
    // Strategy 4: Fallback (0.0) — nothing found, emit ERROR/0 defaults

    // A JSON rung WINS only when what it found carries a verdict: a decision or a score. Until
    // 0.56.0 any object that parsed won its rung, so `{"analysisRecords":[]}` returned
    // `inline_json` at 0.9 with decision UNKNOWN and the text rung, which could have read a
    // `PASS`/`FAIL` line, never ran (R-D12 live run, 2026-11-01: Haiku under jsonTool mode).
    // A verdictless object is kept as a CANDIDATE: its records survive if nothing better is found.
    //
    // The text rung reads only the prose OUTSIDE the verdictless JSON spans. Its patterns
    // (`status: x`, `score: n`) match keys inside JSON too, so scanning the object itself would
    // read a finding's `"status": "open"` as the decision or a category's `"score": 8` as the
    // overall score. When the whole reply is JSON there is no prose, and nothing is read.
    let verdictless: { output: ParsedOutput; method: ExtractionResult['method']; confidence: number; warnings: string[] } | undefined;
    const spans: Array<[number, number]> = [];
    const consider = (
      found: { parsed: unknown; span: [number, number] } | null,
      method: ExtractionResult['method'],
      confidence: number,
      rungWarnings: string[],
    ): ExtractionResult | undefined => {
      if (!found) return undefined;
      const output = this.normalizer.normalizeOutput(found.parsed, agentType);
      if (OutputExtractor.carriesVerdict(output)) {
        return { output, method, confidence, warnings: [...warnings, ...rungWarnings] };
      }
      spans.push(found.span);
      verdictless ??= { output, method, confidence, warnings: rungWarnings };
      return undefined;
    };

    // Strategy 1: Try JSON code fence (highest confidence)
    const fenceWin = consider(this.extractFromCodeFence(content, options), 'json_code_fence', 0.95, []);
    if (fenceWin) return fenceWin;

    // Strategy 1b: Try parsing trimmed content as whole JSON object
    const wholeWin = consider(this.extractWholeJson(content), 'inline_json', 0.9, []);
    if (wholeWin) return wholeWin;

    // Strategy 2: Try inline JSON detection. Skipped when the whole reply was one JSON object:
    // the inline scan would find that same object (or a fragment of it) again.
    if (spans.length === 0 || !this.extractWholeJson(content)) {
      const inlineWin = consider(
        this.extractInlineJson(content), 'inline_json', 0.75,
        ['Extracted from inline JSON - consider using code fence for reliability'],
      );
      if (inlineWin) return inlineWin;
    }

    // Strategy 3: Fall back to structured text parsing, over the prose outside any verdictless JSON
    const prose = OutputExtractor.withoutSpans(content, spans);
    const textResult = prose.trim() === '' ? null : this.extractFromStructuredText(prose, agentType);
    if (textResult && OutputExtractor.carriesVerdict(textResult)) {
      warnings.push('Extracted from structured text patterns - JSON output recommended');
      if (verdictless) {
        warnings.push(
          `The ${verdictless.method} JSON carried no decision or score; they were read from the text around it, and the JSON's other fields were kept.`,
        );
        return {
          output: {
            ...textResult,
            ...verdictless.output,
            decision: textResult.decision,
            ...(textResult.score !== undefined && textResult.score !== null
              ? { score: textResult.score, maxScore: textResult.maxScore ?? verdictless.output.maxScore }
              : {}),
          },
          method: 'structured_text',
          confidence: 0.5,
          warnings,
        };
      }
      return { output: textResult, method: 'structured_text', confidence: 0.5, warnings };
    }

    // Nothing carried a verdict. A verdictless JSON object is still the best record of what the
    // model said (its findings, records, categories), so it is returned as before. The warning
    // says what is missing; ABSENT_DECISION and the gate decide what that means downstream.
    if (verdictless) {
      return {
        ...verdictless,
        warnings: [
          ...warnings, ...verdictless.warnings,
          `The ${verdictless.method} JSON carried no decision or score, and no text outside it did either.`,
        ],
      };
    }

    if (textResult) {
      warnings.push('Extracted from structured text patterns - JSON output recommended');
      return { output: textResult, method: 'structured_text', confidence: 0.5, warnings };
    }

    // Extraction failed
    if (options.strict) {
      throw new ParseError(
        'Failed to extract structured output from response',
        content.substring(0, 500),
      );
    }

    return {
      // Hard parse failure produced no parseable output — it did not "score zero",
      // it failed to score. Null is the honest signal; buildResult's pair rule then
      // yields maxScore: null too. (score-nullability spec, confirmed decision.)
      output: {
        decision: 'ERROR',
        score: null,
      },
      method: 'structured_text',
    // FABRICATION-OK: a failed extraction genuinely has zero confidence — this is a
    // MEASURED floor, not an unknown standing in for a number.
      confidence: 0,
      warnings: ['Could not extract structured output from response'],
    };
  }

  /** A decision other than the normalizer's UNKNOWN sentinel, or a numeric score. */
  private static carriesVerdict(output: ParsedOutput): boolean {
    return (output.decision !== undefined && output.decision !== 'UNKNOWN')
      || (typeof output.score === 'number' && Number.isFinite(output.score));
  }

  /** `content` with each [start, end) span replaced by a newline, so lines either side stay apart. */
  private static withoutSpans(content: string, spans: Array<[number, number]>): string {
    if (spans.length === 0) return content;
    const ordered = [...spans].sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    for (const [start, end] of ordered) {
      if (start < at) { at = Math.max(at, end); continue; }
      out += content.slice(at, start) + '\n';
      at = end;
    }
    return out + content.slice(at);
  }

  private extractFromCodeFence(
    content: string,
    options: ExtractionOptions,
  ): { parsed: unknown; span: [number, number] } | null {
    const lang = options.codeFenceLanguage ?? 'json';
    // Prefer the disambiguated fence (introduced by report-mode invocations) so
    // example ```${lang} blocks in prose cannot claim the last-match. Fall back
    // to the legacy pattern for non-report-mode invocations that emit only one
    // ```${lang} fence at the end of the output.
    const discriminatedPattern = new RegExp(
      `\`\`\`${lang}\\s+analysis\\s*\\n([\\s\\S]*?)\\n\`\`\``,
      'g',
    );
    const legacyPattern = new RegExp(
      `\`\`\`(?:${lang})?\\s*\\n([\\s\\S]*?)\\n\`\`\``,
      'g',
    );
    const discriminatedMatches = [...content.matchAll(discriminatedPattern)];
    const matches =
      discriminatedMatches.length > 0
        ? discriminatedMatches
        : [...content.matchAll(legacyPattern)];
    if (matches.length === 0) return null;

    const lastMatch = matches[matches.length - 1];
    if (!lastMatch?.[1]) return null;
    try {
      const start = lastMatch.index ?? 0;
      const span: [number, number] = [start, start + lastMatch[0].length];
      const parsed = JSON.parse(lastMatch[1].trim()) as unknown;
      return { parsed, span };
    } catch {
      return null;
    }
  }

  private extractWholeJson(content: string): { parsed: unknown; span: [number, number] } | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) return { parsed, span: [0, content.length] };
    } catch {
      // Not valid JSON
    }
    return null;
  }

  private extractInlineJson(content: string): { parsed: unknown; span: [number, number] } | null {
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
    const best = scored[0]!;
    return { parsed: best.parsed, span: [best.index, best.index + best.length] };
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
        ? this.normalizer.normalizeDecision(decisionMatch[1] ?? '', agentType)
        : 'UNKNOWN',
    };

    if (scoreMatch?.[1]) {
      const parsed = parseExternalNumber(scoreMatch[1]) ?? NaN;
      if (!isNaN(parsed)) output.score = parsed;
    }

    if (agentType === 'validator') {
      // Extract maxScore from fraction pattern (95/100) or explicit pattern
      if (scoreMatch?.[2]) {
        const parsed = parseExternalNumber(scoreMatch[2]) ?? NaN;
        if (!isNaN(parsed)) output.maxScore = parsed;
      } else {
        const maxScoreMatch = content.match(patterns.maxScore);
        if (maxScoreMatch?.[1]) {
          const parsed = parseExternalNumber(maxScoreMatch[1]) ?? NaN;
          if (!isNaN(parsed)) output.maxScore = parsed;
        }
      }

      // Extract issues from structured text (warning/suggestion lines with file:line references)
      const issues = this.extractIssuesFromText(content);
      if (issues.length > 0) {
        // Pair-resolution: null pair for scoreless agents, else score with its scale.
        const catScore = output.score ?? null;
        const catMaxScore = catScore === null ? null : (output.maxScore ?? 100);
        output.categories = [{
          name: 'Extracted Issues',
          score: catScore,
          maxScore: catMaxScore,
          findings: [{
            criterion: 'Text-extracted findings',
            pointsEarned: null,
            pointsPossible: null,
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
          lineNumber: parseExternalNumber(lineStr),
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
}
