import type { ArtifactResult, Issue } from './command.js';

/**
 * Raw parsed output from LLM response
 */
export interface ParsedOutput {
  /** Decision outcome from the agent */
  decision: string;

  /** Numeric score (0-100 for validators, may be undefined for executors) */
  score?: number;

  /** Maximum possible score (validators only) */
  maxScore?: number;

  /** Category breakdown with findings (validators only) */
  categories?: ParsedCategory[];

  /** Generated artifacts (executors only) */
  artifacts?: ArtifactResult[];

  /** Raw JSON if extraction was from code fence */
  rawJson?: unknown;
}

/**
 * Parsed category from validator output
 */
export interface ParsedCategory {
  /** Category name */
  name: string;

  /** Points earned in this category */
  score: number;

  /** Maximum points possible */
  maxPoints: number;

  /** Findings within this category */
  findings: ParsedFinding[];
}

/**
 * Parsed finding within a category
 */
export interface ParsedFinding {
  /** Criterion being evaluated */
  criterion: string;

  /** Points earned */
  pointsEarned: number;

  /** Points possible */
  pointsPossible: number;

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
  method: 'json_code_fence' | 'inline_json' | 'structured_text';

  /** Confidence in extraction (0-1) */
  confidence: number;

  /** Any warnings during extraction */
  warnings: string[];
}
