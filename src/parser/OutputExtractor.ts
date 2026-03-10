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
  private static readonly INLINE_JSON_PATTERN = /\{[\s\S]*?"decision"[\s\S]*?\}/;
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

  private extractInlineJson(content: string): unknown | null {
    const match = content.match(OutputExtractor.INLINE_JSON_PATTERN);
    if (!match) return null;

    const startIndex = content.indexOf(match[0]);
    const jsonStr = this.extractBalancedJson(content, startIndex);

    if (!jsonStr) return null;

    try {
      return JSON.parse(jsonStr) as unknown;
    } catch {
      return null;
    }
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
          maxPoints: output.maxScore ?? 100,
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

  private normalizeOutput(raw: unknown, agentType: AgentType): ParsedOutput {
    if (!raw || typeof raw !== 'object') {
      return { decision: 'ERROR' };
    }

    const obj = raw as Record<string, unknown>;

    // Unwrap common nesting: { result: { decision, score, ... }, categories, ... }
    const result = (obj['result'] && typeof obj['result'] === 'object')
      ? obj['result'] as Record<string, unknown>
      : undefined;

    // Resolve decision: top-level > result.decision > result.status
    const rawDecision = obj['decision']
      ?? result?.['decision']
      ?? result?.['status']
      ?? obj['status']
      ?? 'UNKNOWN';

    const output: ParsedOutput = {
      decision: this.normalizeDecision(String(rawDecision), agentType),
      rawJson: raw,
    };

    // Resolve score: top-level > result.score
    const rawScore = obj['score'] ?? result?.['score'];
    if (typeof rawScore === 'number') {
      output.score = rawScore;
    } else if (typeof rawScore === 'string') {
      output.score = parseFloat(rawScore);
    }

    if (agentType === 'validator') {
      // Resolve maxScore: top-level > result.max_score > result.maxScore
      const rawMaxScore = obj['maxScore'] ?? obj['max_score']
        ?? result?.['max_score'] ?? result?.['maxScore'];
      if (typeof rawMaxScore === 'number') {
        output.maxScore = rawMaxScore;
      } else if (typeof rawMaxScore === 'string') {
        output.maxScore = parseInt(rawMaxScore, 10);
      }

      if (Array.isArray(obj['categories'])) {
        output.categories = this.parseCategories(obj['categories']);
      }
    }

    if (agentType === 'executor') {
      if (Array.isArray(obj['artifacts'])) {
        output.artifacts = this.parseArtifacts(obj['artifacts']);
      }
    }

    return output;
  }

  private normalizeDecision(decision: string, agentType: AgentType): string {
    const upper = decision.toUpperCase().trim();

    if (agentType === 'validator') {
      if (['PASS', 'PASSED', 'OK', 'SUCCESS'].includes(upper)) return 'PASS';
      if (['WARN', 'WARNING', 'CAUTION'].includes(upper)) return 'WARN';
      if (['FAIL', 'FAILED', 'ERROR', 'REJECT'].includes(upper)) return 'FAIL';
    }

    if (agentType === 'executor') {
      if (['SUCCESS', 'COMPLETE', 'DONE', 'PASS'].includes(upper)) return 'COMPLETE';
      if (['PARTIAL', 'INCOMPLETE'].includes(upper)) return 'PARTIAL';
      if (['FAIL', 'FAILED', 'ERROR'].includes(upper)) return 'FAILED';
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
        maxPoints: Number(item['maxPoints'] ?? item['max_points'] ?? item['total'] ?? 100),
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
        pointsPossible: Number(item['pointsPossible'] ?? item['points_possible'] ?? item['maxPoints'] ?? 0),
        issues: this.parseIssues(
          Array.isArray(item['issues']) ? item['issues'] : [],
        ),
      }));
  }

  private parseIssues(raw: unknown[]): Issue[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map(item => ({
        title: String(item['title'] ?? 'Untitled Issue'),
        priority: this.normalizePriority(item['priority']),
        severity: this.normalizeSeverity(item['severity']),
        failureCode: item['failureCode'] as string | undefined,
        filePath: (item['filePath'] as string | undefined) ?? (item['file_path'] as string | undefined),
        lineNumber: typeof item['lineNumber'] === 'number'
          ? item['lineNumber']
          : typeof item['line_number'] === 'number'
            ? item['line_number']
            : undefined,
        description: String(item['description'] ?? ''),
      }));
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
