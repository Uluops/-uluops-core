import type { ParsedCategory } from '../types/parser.js';
import type { CategoryResult } from '../types/command.js';

/** Map a ParsedCategory to a CategoryResult. Single source of truth for both executors. */
export function mapCategory(c: ParsedCategory): CategoryResult {
  return { name: c.name, score: c.score, maxScore: c.maxScore, findings: c.findings };
}
