import type { Domain, AgentType, ExecutionMetrics, Recommendation, SubscriptionTier } from './execution.js';
import type { Finding, ArtifactResult } from './command.js';

// ─────────────────────────────────────────────────────────────────────────────
// Agent Definition — matches ADL v1.6.0 schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent definition — the atomic validation/execution unit.
 * Matches the ADL v1.6.0 JSON schema structure.
 *
 * NAMING CONVENTION: The ADL schema uses snake_case for YAML-native keys
 * (knowledge_base, auto_fail, edge_cases) and camelCase for TypeScript-native
 * keys added after the YAML schema was locked (displayName, agentType).
 * This reflects an era boundary: original keys followed YAML convention,
 * later keys followed TypeScript convention. New fields MUST use camelCase.
 * Changing existing snake_case keys requires a breaking ADL schema migration.
 *
 * Agents can be executed directly via `UluOpsClient.runAgent()` or wrapped
 * in a Command for preflight checks, multi-agent aggregation, and saved config.
 */
export interface AgentDefinition {
  agent: {
    /** Agent metadata (required) */
    interface: AgentInterface;

    /** Default execution settings */
    defaults?: AgentDefaults;

    /** Execution context configuration */
    context?: AgentContext;

    /** Agent identity, purpose framing, and behavioral boundaries */
    mission?: AgentMission;

    /** Embedded domain expertise for scoring categories */
    knowledge_base?: AgentKnowledgeBase;

    /** Scoring configuration — required for validators, forbidden for executors */
    scoring?: AgentScoring;

    /** Decision vocabulary and thresholds — required for validators */
    decisions?: AgentDecisions;

    /** Task definitions — required for executors, forbidden for validators */
    tasks?: AgentTasks;

    /** Completion criteria — required for executors */
    completion?: AgentCompletion;

    /** Auto-fail conditions */
    auto_fail?: AgentAutoFail;

    /** Severity deduction scale */
    deductions?: AgentDeductions;

    /** Rollback configuration — executors only */
    rollback?: AgentRollback;

    /** Reasoning process and scaffolding */
    process?: AgentProcess;

    /** Output specification */
    output?: AgentOutput;

    /** Edge case handling */
    edge_cases?: AgentEdgeCase[];

    /** Communication tone */
    tone?: AgentTone;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface Section
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentInterface {
  name: string;
  version: string;
  displayName: string;
  description: string;
  agentType: AgentType;
  domain: Domain;
  subdomain?: string;
  domain_profile?: string;
  risk_level?: 'low' | 'standard' | 'high' | 'critical';
  tools?: string[];
  tags?: string[];
  triggers?: AgentTriggers;
  dependencies?: AgentDependencies;
}

export interface AgentTriggers {
  file_patterns?: string[];
  explicit_only?: boolean;
}

export interface AgentDependencies {
  requires?: string[];
  recommends?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults Section
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentDefaults {
  model?: string;
  timeout?: number;
  max_tokens?: number;
  temperature?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Section
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentContext {
  working_directory?: string;
  environment?: Record<string, string>;
  timeout_behavior?: 'fail' | 'warn' | 'continue';
  shell?: 'bash' | 'sh' | 'zsh' | 'powershell';
  data_sources?: unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mission Section
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMission {
  /** Present-tense immersive opening statement */
  opener?: string;
  /** Why this validation matters */
  stakes?: string;
  /** What the agent produces */
  outcome_framing?: string;
  /** Agent scope and limitations */
  role_boundaries?: string[];
  /** Whether issues must include taxonomy classification */
  taxonomy_mandate?: boolean;
  /** Why this decision vocabulary was chosen */
  vocabulary_rationale?: string;
  /** Hard boundaries — what agent must NOT do */
  explicit_prohibitions?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base Section
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentKnowledgeBase {
  sections?: KnowledgeSection[];
  failure_code_examples?: FailureCodeExample[];
  global_references?: string[];
}

export interface KnowledgeSection {
  category_ref: string;
  what_to_check?: string[];
  detection_patterns?: unknown[];
  red_flags?: CodeExample[];
  safe_patterns?: CodeExample[];
  references?: string[];
  common_mistakes?: CommonMistake[];
}

export interface CodeExample {
  description: string;
  code?: string;
  language?: string;
  severity?: string;
  why?: string;
}

export interface CommonMistake {
  mistake: string;
  why_wrong: string;
  correct_approach: string;
}

export interface FailureCodeExample {
  issue: string;
  failure_code: string;
  explanation: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring Section (validators)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentScoring {
  maxScore: number;
  categories: ScoringCategory[];
  calibration_examples?: CalibrationExample[];
  constraints?: ScoringConstraints;
}

export interface ScoringCategory {
  id: string;
  name: string;
  weight: number;
  description?: string;
  criteria: ScoringCriterion[];
}

export interface ScoringCriterion {
  id: string;
  name: string;
  points: number;
  description?: string;
  failure_taxonomy?: FailureTaxonomy;
  verification?: CriterionVerification;
}

export interface FailureTaxonomy {
  domain: 'structural' | 'semantic' | 'pragmatic' | 'epistemic';
  failure_mode: string;
  default_severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

export interface CriterionVerification {
  method: 'manual' | 'automated' | 'hybrid';
  checks?: string[];
  automation?: { tool: string; pattern?: string };
}

export interface CalibrationExample {
  score: number;
  scenario: string;
  description?: string;
  deductions?: Array<{
    criterion: string;
    points_lost: number;
    reason: string;
  }>;
}

export interface ScoringConstraints {
  min_categories?: number;
  max_categories?: number;
  min_category_weight?: number;
  max_category_weight?: number;
  min_criterion_points?: number;
  max_criterion_points?: number;
  total_must_equal?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions Section (validators)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentDecisions {
  vocabulary: {
    positive: string;
    negative: string;
    conditional?: string | null;
  };
  thresholds?: DecisionThreshold[];
  preset?: 'low_risk' | 'quality_gate' | 'high_stakes' | 'security' | 'critical' | null;
  tracking?: {
    category: 'gate' | 'safety' | 'advisory';
    notify_on?: string[];
  };
  success_criteria?: {
    description: string;
    criteria: string[];
  };
}

export interface DecisionThreshold {
  decision: 'positive' | 'conditional' | 'negative';
  min_score?: number;
  max_score?: number;
  label?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks Section (executors)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentTasks {
  inputs: TaskInput[];
  operations: TaskOperation[];
  outputs: TaskOutput[];
}

export interface TaskInput {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface TaskOperation {
  id: string;
  name: string;
  description: string;
  steps?: string[];
  depends_on?: string[];
}

export interface TaskOutput {
  name: string;
  type: string;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion Section (executors)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentCompletion {
  vocabulary: {
    complete: string;
    partial: string;
    failed: string;
  };
  criteria: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Fail Section
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentAutoFail {
  enabled?: boolean;
  conditions: AutoFailCondition[];
}

export interface AutoFailCondition {
  id: string;
  display_id: string;
  name: string;
  severity: 'critical';
  detection: {
    method: 'pattern' | 'semantic' | 'tool';
    patterns?: string[];
    description?: string;
    command?: string;
    failure_condition?: string;
  };
  category_override?: string;
  evidence_required?: boolean;
  remediation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Other Sections
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentDeductions {
  severity_scale?: Record<string, { points: number; description: string }>;
}

export interface AgentRollback {
  enabled: boolean;
  strategy?: string;
  preserve_logs?: boolean;
}

export interface AgentProcess {
  reasoning_scaffolding?: string[];
  pre_decision_checklist?: string[];
  phases?: Array<{
    name: string;
    actions: Array<{ action: string; description: string }>;
  }>;
}

export interface AgentOutput {
  format: 'markdown' | 'json' | 'html' | 'structured';
  schema?: string;
  token_budget?: { target: number; max: number; guidance?: string };
  section_order?: string[];
  sections?: Array<{ id: string; condition?: string; template: string }>;
  symbols?: Record<string, string>;
  classification?: { enabled: boolean; allow_secondary?: boolean; taxonomy_version?: string };
  examples?: Array<{ scenario: string; input_summary?: string; output: string }>;
}

export interface AgentEdgeCase {
  id: string;
  condition: string;
  condition_expression?: string;
  behavior?: string[];
  score_adjustment?: {
    exclude_categories?: string[];
    rescale?: boolean;
    fixed_score?: number;
  };
  report_wording?: string;
  judgment_rationale?: string;
  decision_override?: {
    affects_decision: boolean;
    forced_decision?: string;
    override_rationale?: string;
  };
}

export interface AgentTone {
  attributes?: string[];
  guidelines?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Result Types (discriminated union by agentType)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base agent result fields shared by both validator and executor results
 */
interface AgentResultBase {
  /** Discriminator — always 'agent' for direct agent execution */
  type: 'agent';

  /** Agent type discriminator for result shape */
  agentType: AgentType;

  /** Agent definition name */
  name: string;

  /** Agent definition version */
  version: string;

  /** Content-addressed hash of the definition */
  definitionHash: string;

  /** Minimum subscription tier required for this definition (from registry) */
  minSubscription?: SubscriptionTier;

  /** Final decision */
  decision: string;

  /** Normalized decision category, resolved from the agent definition's vocabulary.
   * When present, consumers should use this instead of re-classifying via classifyDecision(). */
  decisionCategory?: import('../executor/classifyDecision.js').DecisionCategory;

  /** All recommendations */
  recommendations: Recommendation[];

  /** Total execution duration in ms */
  durationMs: number;

  /** Dashboard URL (populated after validation submission) */
  dashboardUrl?: string;

  /** Execution metrics */
  metrics: ExecutionMetrics;

  /** Raw LLM output text (the agent's full report before parsing) */
  rawOutput?: string;

  /** Output extraction method used (structured_output, json_code_fence, inline_json, structured_text) */
  extractionMethod?: string;

  /** Brief human-readable summary of the result, as provided by the agent.
   * Extracted from the LLM's structured output `summary` field. */
  summary?: string;

  /** Confidence in output extraction (0-1). 1.0 = structured output, 0.5 = regex fallback.
   * Low confidence indicates the result may be unreliable — decision/score may be defaults. */
  extractionConfidence?: number;

  /** Degradation markers from definition resolution (e.g., render fallback paths taken) */
  degradations?: string[];

  /** Full parsed JSON from LLM output (pre-Zod-strip).
   * Contains fields beyond agentOutputSchema — epistemicAssessment, explorationMaps,
   * auditImplications — used by AnalysisSummaryExtractor at submission time.
   * Internal: not part of the public API surface. */
  rawJson?: unknown;
}

/**
 * Universal agent result — used by all 6 agent types.
 *
 * The agent's native decision string passes through as-is (PASS, EXAMINED,
 * VITAL, COMPLETE, etc.). Use `decisionCategory` for canonical classification.
 *
 * Categories and artifacts are both optional — validators and analysts
 * produce categories; executors produce artifacts; some agents produce both.
 */
export interface AgentResult extends AgentResultBase {
  /** Score (0-100) */
  score: number;

  /** Maximum possible score */
  maxScore: number;

  /** Pass threshold used (if applicable) */
  threshold?: number;

  /** Scored categories with findings */
  categories?: Array<{
    name: string;
    score: number;
    maxScore: number;
    findings: Finding[];
  }>;

  /** Generated artifacts (executor agents) */
  artifacts?: ArtifactResult[];
}
