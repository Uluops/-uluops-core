/**
 * Definition type discriminator.
 *
 * Adding a new type requires updating:
 * - RegistryClient.resolveLocal() candidate path list
 * - RegistryClient.listLocal() typeConfig map
 * - RegistryClient.castDefinition() knownTopKeys
 * - UluOpsClient routing (run/execute methods)
 * - Corresponding executor class with type guard
 */
export type DefinitionType = 'agent' | 'command' | 'workflow' | 'pipeline';

/**
 * Subscription tier for content gating.
 * Mirrors @uluops/tier-gate SubscriptionTier without adding the dependency.
 */
export type SubscriptionTier = 'free' | 'hobbyist' | 'plus' | 'pro' | 'enterprise';

/**
 * Execution type for multi-layer orchestration results.
 * Excludes 'agent' because agent results use the `AgentResult` type directly
 * (discriminated by `agentType`) rather than the `ExecutionResult` base.
 * Agents ARE directly executable via `UluOpsClient.runAgent()`.
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
export type AgentType = 'validator' | 'executor' | 'analyst' | 'generator' | 'explorer' | 'forecaster';

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

  /** Minimum subscription tier required for this definition (from registry) */
  minSubscription?: SubscriptionTier;

  /** Final decision */
  decision: string;

  /** Aggregated score (0-100). Optional — not all execution types produce scores. */
  score?: number;

  /** Total execution duration */
  durationMs: number;

  /** Dashboard URL for this run (populated after validation service submission) */
  dashboardUrl?: string;

  /** Set to true when tracking submission failed — dashboardUrl will be undefined */
  trackingFailed?: boolean;

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

  /**
   * Google Gemini thinking tokens (Gemini 2.5+ with extendedThinking).
   * Charged separately from outputTokens by Google; already included in totalEffectiveTokens.
   */
  thinkingTokens?: number;

  /** Total effective tokens (for cost) */
  totalEffectiveTokens: number;

  /** Execution duration in ms */
  durationMs: number;

  /** Model used (or primary model for workflows) */
  model: string;

  /** Number of LLM tool calls made during execution (agent-level) */
  toolCallCount?: number;

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
  /** Source agent name */
  agent?: string;

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
  classifiedBy?: 'agent' | 'classifier' | 'human';

  /** Secondary failure codes when multiple issues apply */
  secondaryFailureCodes?: string[];

  /** Version of failure taxonomy used */
  taxonomyVersion?: string;

  /** Fingerprint for correlation (populated by validation API) */
  fingerprint?: string;
}
