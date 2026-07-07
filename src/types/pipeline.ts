import type { ExecutionResult, ExecutionMetrics, Domain, SubscriptionTier } from './execution.js';
import type { AgentResult } from './agent.js';
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

    /** Pipeline-level settings.
     *
     * DESIGN (2026-04-16): some fields here are schema-forward — they exist in the
     * PDL spec and are preserved in types for definition round-tripping, but are not
     * yet enacted by PipelineExecutor. This is intentional: the type system tracks
     * the spec, the executor implements incrementally. Fields marked @reserved are
     * the delta between spec completeness and runtime completeness. */
    settings?: {
      timeout?: number;
      retries?: number;
      /** @reserved — typed for schema fidelity; PipelineExecutor runs stages sequentially. */
      parallel_stages?: boolean;
    };
  };
}

/**
 * Inline shell step within a pipeline stage (PDL `steps:` block).
 * Mirrors the PDL schema step contract (pdl-schema-v1.2.0 $defs/step) and the
 * factory's PDLStep. NOT yet executed by the engine — steps-only stages pass
 * through with a null score until the opt-in StepsExecutor lands
 * (pdl-steps-execution-spec-v0_1_0 Phase 2).
 */
export interface StepDefinition {
  name: string;
  command: string;
  working_dir?: string;
  env?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retry_delay?: number;
  continue_on_error?: boolean;
  always_run?: boolean;
  expect_empty?: boolean;
  expect_match?: string;
}

/**
 * Stage definition within a pipeline
 */
export interface StageDefinition {
  id: string;
  name: string;

  /** Explicit type of the referenced definition. 'steps' is inferred by
   *  normalizePipelineSection for steps-only stages; steps stages map to
   *  type:'command' in StageResult (agents precedent) until the engine
   *  executes steps for real. */
  type: 'workflow' | 'command' | 'agents' | 'steps';

  /** Reference to command or workflow (name@version format) */
  ref?: string;

  /** Inline agent refs — PDL stages can list agents directly instead of ref */
  agents?: Array<{ ref: string }>;

  /** Inline shell steps (PDL shell preflight). Preserved through normalization;
   *  not yet executed — see StepDefinition. */
  steps?: StepDefinition[];

  /** @reserved — typed for schema fidelity. A single-entry workflows array is
   *  hoisted to ref by normalizePipelineSection (entry args are NOT threaded —
   *  stage args reach no executor, a pre-existing gap); multi-entry arrays fail
   *  loud in executeStage instead of auto-passing (pdl-steps-execution-spec D7). */
  workflows?: Array<{ ref: string; args?: Record<string, unknown> }>;

  /** @reserved — typed for schema fidelity; not executed. Arrays with no
   *  hoistable ref fail loud in executeStage (pdl-steps-execution-spec D7). */
  commands?: Array<{ ref: string; args?: Record<string, unknown> }>;

  /** Stage dependencies */
  depends_on?: string[];

  /** Skip condition expression — stage is skipped when this evaluates to true. Takes precedence over skip_if. */
  condition?: string;

  /** @deprecated Use condition instead. */
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

  /** Individual agent results for inline-agent stages (preserved for tracker decomposition) */
  agentResults?: AgentResult[];

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

  /** Definition name (e.g., 'peirce-pipeline') */
  definitionName: string;

  /** Version of the pipeline definition being executed */
  definitionVersion: string;

  /** Hash of the pipeline definition for audit trail */
  definitionHash: string;

  /** Minimum subscription tier (from registry, for run submission) */
  minSubscription?: SubscriptionTier;

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
 * Handle for monitoring an async pipeline execution.
 *
 * IN-MEMORY ONLY: the handle is bound to the process that started the
 * pipeline. State and the underlying execution Promise live in JS heap;
 * if the process exits, the handle is gone. `executionId` is a transient
 * identifier scoped to that process — it cannot be persisted and resumed
 * after a restart. For durable pipeline runs (resume across processes,
 * survive restarts), an external orchestrator is required and is out of
 * scope for @uluops/core.
 */
export interface PipelineHandle {
  readonly executionId: string;
  status(): Promise<PipelineResult>;
  wait(pollIntervalMs?: number): Promise<PipelineResult>;
  cancel(): Promise<void>;
}
