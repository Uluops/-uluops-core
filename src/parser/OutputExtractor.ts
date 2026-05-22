import type { AgentType } from '../types/execution.js';
import type { Issue } from '../types/command.js';
import type {
  ParsedOutput,
  ExtractionOptions,
  ExtractionResult,
} from '../types/parser.js';
import { ParseError } from '../errors/index.js';
import { OutputNormalizer } from './OutputNormalizer.js';

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

    // ── Extraction strategies (ordered by confidence) ──────────────────────
    // Confidence values are heuristics encoding relative trust in each method.
    // They were calibrated against Claude's output patterns and may need
    // recalibration as new models (GPT, Gemini) are added. The 0.7 threshold
    // in AgentExecutor gates EXTRACTION_FAILED decisions — any strategy below
    // that threshold produces results that won't be trusted as real decisions.
    //
    // Strategy 1: JSON code fence (0.95) — model explicitly wrapped output
    // Strategy 2: Whole/inline JSON (0.9/0.75) — found parseable JSON in text
    // Strategy 3: Structured text (0.5) — regex matched decision/score patterns
    // Strategy 4: Fallback (0.0) — nothing found, emit ERROR/0 defaults

    // Strategy 1: Try JSON code fence (highest confidence)
    const fenceResult = this.extractFromCodeFence(content, options);
    if (fenceResult) {
      return {
        output: this.normalizer.normalizeOutput(fenceResult, agentType),
        method: 'json_code_fence',
        confidence: 0.95,
        warnings,
      };
    }

    // Strategy 1b: Try parsing trimmed content as whole JSON object
    const wholeJsonResult = this.extractWholeJson(content);
    if (wholeJsonResult) {
      return {
        output: this.normalizer.normalizeOutput(wholeJsonResult, agentType),
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
        output: this.normalizer.normalizeOutput(inlineResult, agentType),
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
        ? this.normalizer.normalizeDecision(decisionMatch[1] ?? '', agentType)
        : 'UNKNOWN',
    };

    if (scoreMatch?.[1]) {
      const parsed = parseFloat(scoreMatch[1]);
      if (!isNaN(parsed)) output.score = parsed;
    }

    if (agentType === 'validator') {
      // Extract maxScore from fraction pattern (95/100) or explicit pattern
      if (scoreMatch?.[2]) {
        const parsed = parseInt(scoreMatch[2], 10);
        if (!isNaN(parsed)) output.maxScore = parsed;
      } else {
        const maxScoreMatch = content.match(patterns.maxScore);
        if (maxScoreMatch?.[1]) {
          const parsed = parseInt(maxScoreMatch[1], 10);
          if (!isNaN(parsed)) output.maxScore = parsed;
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
}
