import type { DefinitionType, Domain, AgentType } from './execution.js';
import type { AgentDefinition } from './agent.js';
import type { CommandDefinition } from './command.js';
import type { WorkflowDefinition } from './workflow.js';
import type { PipelineDefinition } from './pipeline.js';

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

  /** Raw YAML content */
  yaml: string;

  /** Parsed definition */
  definition: AgentDefinition | CommandDefinition | WorkflowDefinition | PipelineDefinition;

  /** Rendered runtime - type depends on agentType */
  runtime: ValidatorRuntime | ExecutorRuntime | WorkflowRuntime | PipelineRuntime;

  /** Domain classification */
  domain: Domain;

  /** Agent type (only for agents/commands) */
  agentType?: AgentType;
}

/**
 * Runtime configuration for validator agents
 */
export interface ValidatorRuntime {
  /** Complete system prompt */
  prompt: string;

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
export interface ExecutorRuntime {
  /** Complete system prompt */
  prompt: string;

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
