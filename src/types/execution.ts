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

  /**
   * Operator-provided directive or context for the agent run.
   * For generators: describes WHAT to create (telos, output path, constraints).
   * For validators/analysts: provides additional focus ("focus on auth module").
   * Appears prominently in the initial user message, not as JSON.
   */
  prompt?: string;

  /**
   * Run parameters for definition templates. Currently consumed by step-command
   * substitution ({{ params.x }}, StepsExecutor); `target` is implied from the
   * target field and need not be repeated. Condition-expression evaluation over
   * params is Phase 3 of pdl-steps-execution-spec.
   */
  params?: Record<string, string | number | boolean>;

  /** Execution options */
  options?: Record<string, unknown>;

  /**
   * ENGINE-POPULATED — not an operator surface. Slices of upstream stage
   * results forwarded by PipelineExecutor when this execution runs inside a
   * pipeline stage with `depends_on` (stage-output-forwarding spec §3.4).
   * Rendered as the `## Upstream Analysis` section of the initial message.
   * MUST be attached via a per-stage shallow clone (`{ ...input, upstreamContext }`),
   * never set on a shared ExecutionInput reference — in-place mutation leaks
   * context across stages and races parallel agents (pre-impl run #31 A6).
   * CLI/SDK do not expose this field.
   */
  upstreamContext?: UpstreamStageContext[];
}

/**
 * One forwarded upstream result slice (stage-output-forwarding spec §3.3).
 * Produced by buildUpstreamContext (PipelineExecutor side); consumed by
 * renderUpstreamSection (AgentExecutor side).
 */
export interface UpstreamStageContext {
  /** Upstream stage id (provenance header). */
  stageId: string;
  /** Agent name for inline-agent results; absent for ref-stage results. */
  agentName?: string;
  /** Ref-stage label, e.g. `command: security-analyst@1.2.0` — used in place
   *  of agentName in the header for command/workflow ref stages. */
  refLabel?: string;
  /** Agent's native decision string (PASS, HARMONIOUS, FORCED, …). */
  decision?: string;
  /** Vocabulary-resolved category; rendered as `unclassified` when absent. */
  decisionCategory?: string;
  score?: number | null;
  maxScore?: number | null;
  /** Agent-provided summary, or the first 500 chars of rawOutput as fallback. */
  summary?: string;
  /** Severity-sorted top-5 recommendation slice (critical > high > medium >
   *  low > info > unknown; stable within a tier by original order). */
  recommendations?: Array<{ severity?: string; title: string; filePath?: string; lineNumber?: number | null }>;
  /** Head+tail-retained rawOutput (16K head + 8K tail + elision marker) —
   *  present only when the producer stage declared `forward: full`. */
  fullText?: string;
  /** Labeled absence: the upstream member produced no forwardable output.
   *  Reachable only in partial multi-dependency topologies (spec §3.1). */
  absent?: boolean;
  /** skipReason verbatim for skipped stages; error message ≤200 chars for failed. */
  absentReason?: string;
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

  /** Normalized decision category. For command results wrapping a single agent this is
   * the agent's vocabulary-resolved category; for aggregated results it reflects the
   * aggregation outcome. Consumers gating on decisions should read this (falling back to
   * `classifyDecision(decision)` when absent) rather than pattern-matching raw strings —
   * raw decisions carry per-definition vocabularies (EXPOSED, BEWITCHED, remapped
   * SHIP/HOLD/BLOCK) that literal comparisons silently misclassify. */
  decisionCategory?: import('../executor/classifyDecision.js').DecisionCategory;

  /** Aggregated score (0-100). Optional/null — not all execution types produce scores. */
  score?: number | null;

  /** Total execution duration */
  durationMs: number;

  /** Dashboard URL for this run (populated after validation service submission) */
  dashboardUrl?: string;

  /** Set to true when tracking submission failed — dashboardUrl will be undefined */
  trackingFailed?: boolean;

  /**
   * Typed reason the tracking submission failed (set alongside `trackingFailed`).
   * General — not PROJECT_LIMIT-specific. See {@link TrackingError}.
   */
  trackingError?: TrackingError;

  /** All recommendations (flattened for workflows/pipelines) */
  recommendations: Recommendation[];

  /** Execution metrics */
  metrics: ExecutionMetrics;
}

/**
 * Typed reason a run's tracking submission failed (non-fatal). Attached to a
 * result's `trackingError` when `trackingFailed` is set. General across failure
 * kinds (PROJECT_LIMIT, SUBSCRIPTION_REQUIRED, 401/403/429/5xx, network, timeout).
 */
export interface TrackingError {
  /** Stable machine token from the API/SDK (e.g. 'PROJECT_LIMIT'). THE contract. */
  code?: string;
  /** HTTP status when the failure came from the API (e.g. 402). */
  statusCode?: number;
  /** Human-readable message. NOT a contract — do not match on it. */
  message: string;
  /** API request id for tracing, when available. */
  requestId?: string;
  /** Structured context (e.g. upgradeUrl, currentCount, limit). */
  details?: Record<string, unknown>;
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

  /** Cache read tokens (genuine Anthropic-style cache reads only, post-disentangle §3.2) */
  cacheReadTokens?: number;

  /**
   * Cached-input tokens: cache-served portion of gross input (OpenAI/Google),
   * subtracted in the canonical total_effective. 0/undefined for Anthropic. §3.2.
   */
  cachedInputTokens?: number;

  /** OpenAI reasoning tokens. Subset of GROSS outputTokens — stored, NOT added to totalEffectiveTokens. */
  reasoningOutputTokens?: number;

  /**
   * Google Gemini thinking tokens (Gemini 2.5+).
   * The AI SDK folds these INTO gross outputTokens — a subset, stored for
   * cost/analytics and NOT re-added to totalEffectiveTokens (would double-count). §3.2.
   */
  thinkingTokens?: number;

  /** Total effective tokens (for cost): (input − cached_input) + output_gross + cache_creation */
  totalEffectiveTokens: number;

  /** Execution duration in ms */
  durationMs: number;

  /** Model used (or primary model for workflows) */
  model: string;

  /**
   * Producing harness/runtime. @uluops/core emits 'uluops-core' (vendor-derived,
   * runs OpenAI/Google — not a constant 'claude-code'). Canonical vocabulary §2.4. (G4)
   */
  harness?: string;

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

  /** Per-run override for executing PDL stage steps (host shell access).
   *  Defaults to the config-level allowStageSteps (default false). */
  allowStageSteps?: boolean;

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

  /**
   * Report mode flag. When true, AgentExecutor omits the structured output
   * schema from the AI SDK call, freeing the model to honor a publication-mode
   * prompt directive (used by @uluops/cli's `--report` flag). Defaults to
   * false. Mutually exclusive with `trackResults: true` in CLI usage — the CLI
   * forces `trackResults: false` whenever it sets `reportMode: true`.
   */
  reportMode?: boolean;

  /** Project name for result tracking */
  project?: string;

  /** Temperature for generation (0-1). Default: 0 */
  temperature?: number;

  /** Maximum tool loop steps. Default: 50 */
  maxSteps?: number;

  /**
   * Caller-pinned expected YAML hash (`sha256:...`) from a trusted, independent
   * channel. When set, resolve verifies `computeHash(resolved.yaml)` against it
   * and refuses execution (IntegrityError, kind 'yaml') on mismatch. Covers the
   * definition source + config; for WDL/PDL it fully covers execution.
   */
  expectedHash?: string;

  /**
   * Caller-pinned expected rendered-prompt hash (`sha256:...`). When set, resolve
   * verifies `computePromptHash(resolved.runtime.prompt)` against it and refuses
   * execution (IntegrityError, kind 'prompt'). Required for full agent/command
   * executed-prompt integrity. Omit for workflow/pipeline (no rendered prompt →
   * kind 'unavailable').
   */
  expectedPromptHash?: string;
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

  /** Whether the run is in report mode (structured-output enforcement gated off) */
  reportMode: boolean;

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
