import type { ArtifactResult, Issue } from './command.js';

/**
 * Raw parsed output from LLM response
 */
export interface ParsedOutput {
  /** Decision outcome from the agent */
  decision: string;

  /** Numeric score (0-100 for validators; null for generators/executors). Null iff maxScore null. */
  score?: number | null;

  /** Maximum possible score (null iff score is null) */
  maxScore?: number | null;

  /** Category breakdown with findings (validators only) */
  categories?: ParsedCategory[];

  /** Generated artifacts (executors only) */
  artifacts?: ArtifactResult[];

  /** Raw JSON if extraction was from code fence */
  rawJson?: unknown;

  /** Brief human-readable summary of the result */
  summary?: string;
}

/**
 * Parsed category from validator output
 */
export interface ParsedCategory {
  /** Category name */
  name: string;

  /** Points earned in this category (null iff maxScore null) */
  score: number | null;

  /** Maximum points possible (null for scoreless agents) */
  maxScore: number | null;

  /** Findings within this category */
  findings: ParsedFinding[];
}

/**
 * Parsed finding within a category
 */
export interface ParsedFinding {
  /** Criterion being evaluated */
  criterion: string;

  /** Points earned (null for scoreless agents / degenerate parses) */
  pointsEarned: number | null;

  /** Points possible (null for scoreless agents / degenerate parses) */
  pointsPossible: number | null;

  /** Individual issues found */
  issues: Issue[];
}

/**
 * Extraction options
 */
export interface ExtractionOptions {
  /**
   * Whether to throw on parse failure
   * @default false
   */
  strict?: boolean;

  /**
   * Custom JSON code fence language identifier
   * @default 'json'
   */
  codeFenceLanguage?: string;
}

/**
 * Extraction result with metadata
 */
export interface ExtractionResult {
  /** Parsed output */
  output: ParsedOutput;

  /** Extraction method used */
  method: 'json_code_fence' | 'inline_json' | 'structured_text' | 'structured_output';

  /** Confidence in extraction (0-1) */
  confidence: number;

  /** Any warnings during extraction */
  warnings: string[];
}
