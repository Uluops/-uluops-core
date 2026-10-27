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
 * Stage gate (PDL `$defs/gate`, pdl-schema-v1.2.0). Controls pipeline flow
 * after the stage completes:
 *
 * - The gate FAILS when the stage's vocabulary-resolved decision is negative,
 *   the stage errored, or (when `threshold` is set) the aggregated score falls
 *   below it. A stage with no evaluable score is fail-open for the threshold
 *   check (WorkflowExecutor.evaluateGate precedent) — decision-negative still
 *   fails it.
 * - `on_failure` is the enacted hard-stop contract (G5): `abort` fails the
 *   pipeline and skips everything downstream; `skip` skips the remaining
 *   stages but lets the pipeline complete; `warn` logs and continues.
 *   PDL schema default is `abort` — a gate is a gate.
 */
export interface GateDefinition {
  /** Score threshold (0-100). Absent → the gate fails only on negative
   *  decisions / stage errors, never on score. */
  threshold?: number;

  /** Aggregation over inline-agent scores when `threshold` is set. Ref-based
   *  stages have a single score and ignore this. PDL schema default 'min'. */
  aggregate?: 'min' | 'max' | 'average';

  /** Flow action when the gate fails. PDL schema default 'abort'. */
  on_failure?: 'abort' | 'warn' | 'skip';

  /** Flow action when the gate passes. `skip_remaining` is the early-exit
   *  pattern: downstream stages are skipped, pipeline completes. PDL schema
   *  default 'continue'. */
  on_success?: 'continue' | 'skip_remaining';
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

  /** Inline agent refs — PDL stages can list agents directly instead of ref.
   *  Per-agent `condition` is in the PDL 1.6.0 condition language (see `condition`):
   *  false → agent not dispatched, not scored; E → agent not dispatched, stage ERRORED. */
  agents?: Array<{
    ref: string;
    condition?: string;
    /** Per-agent threshold (PDL 1.6.0, D5). Its presence puts the gate in per-agent mode; per-agent
     *  scoring is P4b's. P4a reads only whether the gate has a threshold (D24). */
    threshold?: number;
  }>;

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

  /** Producer-side forwarding mode (stage-output-forwarding spec §3.1).
   *  What this stage's outputs offer to stages that depend_on it:
   *  - 'auto' (default, absent): the standard severity-sorted slice
   *  - 'none': never forwarded (ordering-only stages, gates)
   *  - 'full': slice plus head+tail-retained rawOutput — the explicit
   *    escalation for consumers that need full narrative. Ref-based stages
   *    have no rawOutput and degrade to 'auto'. */
  forward?: 'auto' | 'none' | 'full';

  /** Consumer-side forwarding mode (stage-output-forwarding spec §3.1).
   *  - 'auto' (default): this stage's agents receive slices of all
   *    non-suppressed depends_on outputs in their initial message
   *  - 'none': depend for ordering only; agents get a clean context. */
  receives?: 'auto' | 'none';

  /** Post-stage flow gate (PDL `$defs/gate`) — see {@link GateDefinition}.
   *  Enacted by PipelineExecutor: `on_failure`/`on_success` control pipeline
   *  flow; `threshold`/`aggregate` evaluate against inline-agent scores or the
   *  stage result score. A steps stage carrying an abort gate that cannot
   *  execute (allowStageSteps off) is refused before launch instead of silently
   *  passing (G5). */
  gate?: GateDefinition;

  /** Run-gate in the PDL 1.6.0 condition language (executor/conditions.ts): the
   *  stage runs when it is true, is SKIPPED when it is false, and is ERRORED when
   *  it is E (it read a step that did not pass). Validated when the run starts;
   *  a condition that does not parse, or references an undeclared parameter or a
   *  stage that is not an ancestor, refuses the run with a load error.
   *  Removed in 1.6.0 (D25): the deprecated `skip_if` key, now an undeclared key
   *  (`unknown_key`), and the `stage.<id>` / bare `<id>.<field>` forms, now
   *  unknown roots. */
  condition?: string;

  /** Stage-specific options. @reserved — not declared by PDL 1.6.0, so a stage carrying
   *  it is refused at load (`unknown_key`); kept on the type for source compatibility. */
  options?: Record<string, unknown>;
}

/**
 * Trigger definition for pipelines
 */
export interface TriggerDefinition {
  type: 'webhook' | 'schedule' | 'event';
  config: Record<string, unknown>;
  /** Declared run parameters (PDL `triggers[].parameters`), the union over every trigger. PDL
   *  1.6.0 reads them at load (`undeclared_parameter`, `parameter_env_collision`) and binds each
   *  declared `default` before a condition or step reads the parameter. */
  parameters?: Array<{ name: string; type?: string; default?: unknown; required?: boolean }>;
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
 * Result of a single executed shell step (pdl-steps-execution-spec D4).
 */
export interface StepResult {
  /** Step name from the definition */
  name: string;
  /** Raw (un-substituted) command from the definition */
  command: string;
  /** passed = ran clean (incl. expectation checks); failed = non-zero exit,
   *  timeout, expectation mismatch, or unresolved template; skipped = not run
   *  because an earlier step hard-failed (and this step is not always_run). */
  status: 'passed' | 'failed' | 'skipped';
  /** Process exit code when the step ran */
  exitCode?: number;
  /** Captured stdout, trimmed and truncated to 8KB */
  output: string;
  /** Failure detail when status is failed */
  error?: string;
  durationMs: number;
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

  /** Per-step results for steps stages executed under allowStageSteps
   *  (pdl-steps-execution-spec D4). Absent when steps were not executed. */
  steps?: StepResult[];

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
