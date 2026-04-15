import type { ExecutionResult, ExecutionMetrics, Domain } from './execution.js';
import type { CommandResult } from './command.js';
import type { WorkflowResult } from './workflow.js';

/**
 * Pipeline definition - multi-stage execution flow
 */
export interface PipelineDefinition {
  pipeline: {
    /** Pipeline metadata */
    interface: {
      name: string;
      version: string;
      displayName: string;
      description: string;
      domain: Domain;
      subdomain?: string;
    };

    /** Stage definitions */
    stages: StageDefinition[];

    /** Trigger configuration (optional) */
    triggers?: TriggerDefinition[];

    /** Pipeline-level settings */
    settings?: {
      timeout?: number;
      retries?: number;
      /** @reserved — typed for schema fidelity; PipelineExecutor runs stages sequentially. */
      parallel_stages?: boolean;
    };
  };
}

/**
 * Stage definition within a pipeline
 */
export interface StageDefinition {
  id: string;
  name: string;

  /** Explicit type of the referenced definition */
  type: 'workflow' | 'command';

  /** Reference to command or workflow (name@version format) */
  ref: string;

  /** Stage dependencies */
  depends_on?: string[];

  /** Execution condition. @reserved — typed for schema fidelity; use skip_if for current skip logic. */
  condition?: string;

  /** Skip condition (deprecated, use condition with negation) */
  skip_if?: string;

  /** Stage-specific options. @reserved — typed for schema fidelity; not yet passed to executors. */
  options?: Record<string, unknown>;
}

/**
 * Trigger definition for pipelines
 */
export interface TriggerDefinition {
  type: 'webhook' | 'schedule' | 'event';
  config: Record<string, unknown>;
}

/**
 * Pipeline execution result
 */
export interface PipelineResult extends ExecutionResult {
  type: 'pipeline';

  /** Execution status (pipelines can be async) */
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';

  /** Stage-by-stage results */
  stages: StageResult[];

  /** Trigger information */
  trigger?: TriggerInfo;

  /** Generated artifacts */
  artifacts?: PipelineArtifact[];

  /** Pipeline-specific metrics */
  metrics: PipelineMetrics;
}

/**
 * Pipeline-specific metrics
 */
export interface PipelineMetrics extends ExecutionMetrics {
  /** Number of stages executed */
  stagesExecuted: number;

  /** Number of stages passed */
  stagesPassed: number;

  /** Number of stages failed */
  stagesFailed: number;

  /** Number of stages with conditional decisions (WARN, HOLD) */
  stagesWarned: number;

  /** Number of stages skipped */
  stagesSkipped: number;
}

/**
 * Result for a single stage
 */
export interface StageResult {
  /** Stage identifier */
  id: string;

  /** Stage display name */
  name: string;

  /** Stage type (inferred from ref) */
  type: 'workflow' | 'command';

  /** Stage status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

  /** Result (command or workflow depending on stage type) */
  result?: CommandResult | WorkflowResult;

  /** Reason if stage was skipped */
  skipReason?: string;

  /** Stage start time */
  startedAt?: string;

  /** Stage completion time */
  completedAt?: string;

  /** Stage duration */
  durationMs?: number;
}

/**
 * Information about what triggered the pipeline
 */
export interface TriggerInfo {
  type: 'manual' | 'webhook' | 'schedule' | 'event';
  source?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pipeline artifact
 */
export interface PipelineArtifact {
  name: string;
  path: string;
  size?: number;
  contentType?: string;
}

/**
 * Internal state for tracking pipeline execution
 */
export interface PipelineState {
  /** Unique pipeline execution ID */
  pipelineId: string;

  /** Version of the pipeline definition being executed */
  definitionVersion: string;

  /** Hash of the pipeline definition for audit trail */
  definitionHash: string;

  /** Current execution status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** Index of currently executing stage */
  currentStageIndex: number;

  /** Results from completed stages */
  stageResults: StageResult[];

  /** Execution start timestamp (ms since epoch) */
  startTime: number;

  /** Error message if failed */
  error?: string;
}

/**
 * Handle for monitoring async pipeline execution
 */
export interface PipelineHandle {
  readonly executionId: string;
  status(): Promise<PipelineResult>;
  wait(pollIntervalMs?: number): Promise<PipelineResult>;
  cancel(): Promise<void>;
}
