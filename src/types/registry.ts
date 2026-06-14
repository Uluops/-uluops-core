import type { DefinitionType, Domain, AgentType, SubscriptionTier } from './execution.js';
import type { AgentDefinition } from './agent.js';
import type { CommandDefinition } from './command.js';
import type { WorkflowDefinition } from './workflow.js';
import type { PipelineDefinition } from './pipeline.js';

// Re-export SubscriptionTier — canonical definition is in execution.ts to avoid circular imports
export type { SubscriptionTier } from './execution.js';

/**
 * Resolved definition from registry
 */
export interface ResolvedDefinition {
  /** Definition type */
  type: DefinitionType;

  /** Definition name */
  name: string;

  /** Resolved version */
  version: string;

  /** SHA-256 hash of source YAML */
  hash: string;

  /**
   * SHA-256 hash of the rendered prompt (runtime_md), as stored by the registry
   * at publish/retranslate time. Undefined for local definitions and for remote
   * definitions with no rendered prompt (WDL/PDL, content-gated).
   */
  promptHash?: string;

  /**
   * Translator (definition-factory) version that produced the frozen runtime_md.
   * Lets callers detect a retranslation restamp. Undefined for local definitions.
   */
  translatorVersion?: string;

  /** Raw YAML content (null when content-gated — check proRestricted) */
  yaml: string;

  /** Parsed definition (Partial when no YAML available — use optional chaining) */
  definition: AgentDefinition | CommandDefinition | WorkflowDefinition | PipelineDefinition | Partial<AgentDefinition>;

  /** Rendered runtime - type depends on agentType */
  runtime: BaseRuntime | AgentRuntime | ExecutorRuntime | WorkflowRuntime | PipelineRuntime;

  /** Domain classification */
  domain: Domain;

  /** Agent type (only for agents/commands) */
  agentType?: AgentType;

  /** Minimum subscription tier required to access this definition's content */
  minSubscription?: SubscriptionTier;

  /** Safety analysis results — null when not yet analyzed */
  riskProfile?: Record<string, unknown> | null;

  /** Degradation markers — tracks which fallback paths were taken during resolution */
  degradations?: string[];
}

/**
 * Base runtime shared by all definition types — the minimum shape
 * available after registry resolution (before type-narrowing).
 */
export interface BaseRuntime {
  /** Complete system prompt */
  prompt: string;
}

/**
 * Runtime configuration for agents (analysts, validators, forecasters, explorers, generators)
 */
export interface AgentRuntime extends BaseRuntime {
  /** Agent interface metadata (tools, name, etc.) */
  interface?: {
    tools?: string[];
    [key: string]: unknown;
  };

  /** Default execution settings */
  defaults: {
    model: string;
    timeout: number;
    maxTokens?: number;
    temperature?: number;
    thresholds?: { pass?: number; warn?: number };
  };

  /** Scoring configuration */
  config: {
    maxScore: number;
    threshold: number;
    categories: CategoryConfig[];
    outputSchema: string;
  };
}

/**
 * Runtime configuration for executor agents
 */
export interface ExecutorRuntime extends BaseRuntime {
  /** Agent interface metadata (tools, name, etc.) */
  interface?: {
    tools?: string[];
    [key: string]: unknown;
  };

  /** Default execution settings */
  defaults: {
    model: string;
    timeout: number;
    maxTokens?: number;
    temperature?: number;
  };

  /** Execution configuration */
  config: {
    mode: string;
    inputs: InputConfig[];
    tasks: TaskConfig[];
    outputs: OutputConfig[];
    completionCriteria: string[];
    outputSchema: string;
  };
}

/**
 * Scoring category configuration
 */
export interface CategoryConfig {
  name: string;
  weight: number;
  criteria: CriteriaConfig[];
  description?: string;
}

/**
 * Individual scoring criterion
 */
export interface CriteriaConfig {
  name: string;
  points: number;
  description?: string;
}

/**
 * Input configuration for executors
 */
export interface InputConfig {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Task configuration for executors
 */
export interface TaskConfig {
  id: string;
  name: string;
  description: string;
  depends_on?: string[];
}

/**
 * Output configuration for executors
 */
export interface OutputConfig {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
}

/**
 * Runtime configuration for workflows
 */
export interface WorkflowRuntime {
  phases: PhaseConfig[];
  onFailure: 'stop' | 'continue' | 'abort' | 'warn';
  aggregation: AggregationConfig;
  outputs?: OutputMapping[];
}

/**
 * Runtime configuration for pipelines
 */
export interface PipelineRuntime {
  stages: StageConfig[];
  triggers: TriggerConfig[];
  state: StateConfig;
}

/**
 * Workflow phase configuration
 */
export interface PhaseConfig {
  id: string;
  name: string;
  type?: 'validate' | 'execute' | 'mixed';
  commands: string[];
  parallel?: boolean;
  depends_on?: string[];
  gate?: { threshold: number; aggregate?: 'min' | 'max' | 'average'; on_fail?: 'stop' | 'warn' | 'abort' };
  inputs?: Record<string, string>;
  skip_if?: string;
}

/**
 * Score aggregation configuration
 */
export interface AggregationConfig {
  method: 'average' | 'weighted_average' | 'min' | 'max' | 'sum';
  weights?: Record<string, number>;
}

/**
 * Output mapping for workflows
 */
export interface OutputMapping {
  name: string;
  source: string;
}

/**
 * Pipeline stage configuration
 */
export interface StageConfig {
  id: string;
  name: string;
  type: 'workflow' | 'command';
  ref: string;
  depends_on?: string[];
  condition?: string;
}

/**
 * Pipeline trigger configuration
 */
export interface TriggerConfig {
  type: 'webhook' | 'schedule' | 'event' | 'manual';
  event?: string;
  cron?: string;
}

/**
 * Pipeline state configuration
 */
export interface StateConfig {
  persistence: boolean;
  ttl: string;
}

/**
 * Definition summary for listings
 */
export interface DefinitionSummary {
  type: DefinitionType;
  name: string;
  version: string;
  displayName: string;
  description: string;
  domain: Domain;
  subdomain?: string;
  agentType?: AgentType;
  status: 'draft' | 'published' | 'deprecated' | 'archived';
  tags?: string[];
  /** Minimum subscription tier required to access this definition's content */
  minSubscription?: SubscriptionTier;
}

/**
 * Definition reference (for dependency tracking)
 */
export interface Reference {
  fromType: DefinitionType;
  fromName: string;
  fromVersion: string;
  toType: DefinitionType;
  toName: string;
  toVersion: string;
  context: string;
}
