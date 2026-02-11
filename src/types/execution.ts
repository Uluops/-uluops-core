/**
 * Definition type discriminator
 */
export type DefinitionType = 'agent' | 'command' | 'workflow' | 'pipeline';

/**
 * Execution type discriminator (excludes agent - agents aren't directly executable)
 */
export type ExecutionType = 'command' | 'workflow' | 'pipeline';

/**
 * Domain classification for definitions
 */
export type Domain =
  | 'software'
  | 'legal'
  | 'medical'
  | 'financial'
  | 'scientific'
  | 'content'
  | 'general';

/**
 * Agent type discriminator.
 *
 * - `validator` — Scores code against criteria, produces pass/warn/fail decisions
 * - `executor` — Performs actions (refactoring, generation), produces complete/partial/failed decisions
 * - `analyst` — Analyzes patterns and trends, produces analytical reports
 * - `generator` — Creates new artifacts (scaffolding, templates, documentation)
 */
export type AgentType = 'validator' | 'executor' | 'analyst' | 'generator';

/**
 * Base input for all execution types
 */
export interface ExecutionInput {
  /** Target path to analyze */
  target: string;

  /** Execution options */
  options?: Record<string, unknown>;
}

/**
 * Base result for all execution types
 */
export interface ExecutionResult {
  /** Execution type discriminator */
  type: ExecutionType;

  /** Name of executed definition */
  name: string;

  /** Version executed */
  version: string;

  /** Definition hash for audit trail */
  definitionHash: string;

  /** Final decision */
  decision: string;

  /** Aggregated score (0-100). Optional — not all execution types produce scores. */
  score?: number;

  /** Total execution duration */
  durationMs: number;

  /** Dashboard URL for this run (populated after validation service submission) */
  dashboardUrl?: string;

  /** All recommendations (flattened for workflows/pipelines) */
  recommendations: Recommendation[];

  /** Execution metrics */
  metrics: ExecutionMetrics;
}

/**
 * Base metrics collected for all executions
 */
export interface ExecutionMetrics {
  /** Total input tokens */
  inputTokens: number;

  /** Total output tokens */
  outputTokens: number;

  /** Cache creation tokens */
  cacheCreationTokens?: number;

  /** Cache read tokens */
  cacheReadTokens?: number;

  /** Total effective tokens (for cost) */
  totalEffectiveTokens: number;

  /** Execution duration in ms */
  durationMs: number;

  /** Model used (or primary model for workflows) */
  model: string;

  /** Estimated cost in USD */
  costUsd?: number;
}

/**
 * Call-time execution options for direct agent runs
 */
export interface ExecutionOptions {
  /** Model override: alias ('sonnet'), tier ('premium'), or 'provider:modelId' */
  model?: string;

  /** Maximum tokens for response */
  maxTokens?: number;

  /** Execution timeout in milliseconds */
  timeoutMs?: number;

  /** Threshold overrides for validators */
  thresholds?: {
    pass?: number;
    warn?: number;
  };

  /** Submit results to validation service (default: true) */
  trackResults?: boolean;

  /** Project name for result tracking */
  project?: string;

  /** Temperature for generation (0-1). Default: 0 */
  temperature?: number;

  /** Maximum tool loop steps. Default: 50 */
  maxSteps?: number;
}

/**
 * Merged execution context from agent defaults + runtime options
 * Used internally by AgentExecutor
 */
export interface ResolvedExecutionContext {
  /** Resolved model: alias, tier, or provider:modelId (from options > agent defaults > config default) */
  model: string;

  /** Resolved max tokens */
  maxTokens: number;

  /** Resolved timeout in ms */
  timeoutMs: number;

  /** Resolved thresholds (for validators) */
  thresholds?: {
    pass: number;
    warn: number;
  };

  /** Whether to track results */
  trackResults: boolean;

  /** Project for tracking */
  project?: string;

  /** Resolved temperature (from options > agent defaults > 0) */
  temperature: number;

  /** Resolved max tool loop steps (from options > 50) */
  maxSteps: number;
}

/**
 * Individual recommendation/issue
 */
export interface Recommendation {
  /** Source validator name */
  validator?: string;

  /** Issue title */
  title: string;

  /** Priority level */
  priority: 'critical' | 'suggested' | 'backlog';

  /** Severity level */
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';

  /** Failure taxonomy code (e.g., "SEM-INC/H") */
  failureCode?: string;

  /** Failure domain (STR=Structural, SEM=Semantic, PRA=Pragmatic, EPI=Epistemic) */
  failureDomain?: 'STR' | 'SEM' | 'PRA' | 'EPI';

  /** Failure mode code (e.g., "SYN", "VAL", "INC") */
  failureMode?: string;

  /** Issue category (e.g., "type-safety", "security") */
  category?: string;

  /** Type of issue (e.g. "feature", "bug", "docs", "config") */
  type?: string;

  /** File path relative to target */
  filePath?: string;

  /** Line number in file */
  lineNumber?: number;

  /** Detailed description */
  description?: string;

  /** Classification confidence */
  classificationConfidence?: 'high' | 'medium' | 'low';

  /** Who classified this issue */
  classifiedBy?: 'validator' | 'classifier' | 'human';

  /** Secondary failure codes when multiple issues apply */
  secondaryFailureCodes?: string[];

  /** Version of failure taxonomy used */
  taxonomyVersion?: string;

  /** Fingerprint for correlation (populated by validation API) */
  fingerprint?: string;
}
