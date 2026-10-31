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
 * Stage gate (PDL `$defs/gate`, PDL 1.6.0 §3.2; evaluated by `executor/stageGate.ts`).
 *
 * - **Score.** If any agentRef in the stage declares `threshold`, the gate is in per-agent mode:
 *   each agent must reach its own threshold, falling back to `gate.threshold`. Otherwise
 *   `aggregate(scores) >= threshold`. A gate with no threshold is decision-only.
 * - **Decision** (`decision`): how each agent's decision class is compared. A neutral or absent
 *   decision never fails a gate; the score decides.
 * - **`on_failure`**: `abort` makes the stage FAILED and skips its transitive dependents only (D1);
 *   `fail` makes it FAILED and the run continues; `warn` makes it WARNED; `skip` is a deprecated
 *   alias of `fail`. Absent is `abort`. A stage with no gate at all is judged as `warn` with the
 *   `not_negative` decision key: a failed step or a negative decision makes it WARNED (D43).
 *
 * Before 1.6.0, `abort` skipped every remaining stage and failed the run, `skip` skipped the
 * remaining stages, and the gate failed on any negative decision whatever its mode.
 */
export interface GateDefinition {
  /** Score threshold (0-100). Absent → the gate is decision-only, unless an agentRef declares
   *  its own threshold (per-agent mode). */
  threshold?: number;

  /** Aggregation over inline-agent scores in aggregate mode. Ref-based stages have a single score
   *  and ignore this. A load error in per-agent mode. PDL schema default 'min'. */
  aggregate?: 'min' | 'max' | 'average';

  /** Gate-decision D1-D3: `not_negative` (a negative fails; a conditional passes, and at a
   *  blocking gate makes `allGatesPassed` false), `positive` (a negative or a conditional fails),
   *  `ignore`. Absent: `not_negative` on blocking gates, `ignore` on `warn` gates. */
  decision?: 'not_negative' | 'positive' | 'ignore';

  /** Flow action when the gate fails. PDL schema default 'abort'. */
  on_failure?: 'abort' | 'fail' | 'warn' | 'skip';

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
    /** Per-agent threshold (PDL 1.6.0, D5). Its presence on any agent puts the gate in per-agent
     *  mode: each agent must reach its own threshold, or `gate.threshold` when it has none. */
    threshold?: number;
    /** Agent timeout in milliseconds (PDL `agentRef.timeout`, minimum 1000). Overrides the run's
     *  timeout for this agent. An agent that times out is unjudgeable, so its stage is ERRORED.
     *  Declared by the schema since 1.4 and read by nothing until 1.6.0 P4b. */
    timeout?: number;
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

  /**
   * The run's saved verdict (PDL 1.6.0 §3.1, D13), computed once by `executor/runVerdict.ts` and
   * written as-is by `SubmissionClient`. False when a stage ended FAILED, a stage ended ERRORED
   * behind a blocking gate, a blocking gate accepted a CONDITIONAL, or a stop came before every
   * stage reached a terminal status; otherwise true. `decision` is derived from it: FAIL when
   * false; else WARN when a stage WARNED or ended ERRORED behind `warn`; else PASS.
   */
  allGatesPassed: boolean;

  /** Run-level warnings ({@link PipelineWarning}), in the order they arose. */
  warnings: PipelineWarning[];

  /** The resolved run parameters (declared defaults bound), as conditions read them. Written into
   *  the submitted run's raw markdown as its `params:` line. */
  params?: Record<string, string | number | boolean>;

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
  /** Number of stages not SKIPPED. An ERRORED stage counts, whether or not it ran. */
  stagesExecuted: number;

  /** Stages whose {@link StageResult.outcome} is PASSED. The five outcome counts partition the
   *  stages. Before PDL 1.6.0 these counted decision categories, not gate outcomes. */
  stagesPassed: number;

  /** Stages FAILED. */
  stagesFailed: number;

  /** Stages WARNED (a `warn` gate failed). Before 1.6.0: stages with a conditional decision. */
  stagesWarned: number;

  /** Stages ERRORED. */
  stagesErrored: number;

  /** Stages SKIPPED. */
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

  /** Execution status. `completed`: the stage ran to the end (its gate may still have failed:
   *  read {@link outcome}). `failed`: the stage threw. `skipped`: it did not run. `errored`: it
   *  could not be judged (PDL 1.6.0 ERRORED; {@link erroredReasons} says why), whether or not it ran. */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'errored';

  /** The stage's PDL 1.6.0 status (§3.1), set on every stage that has ended. PASSED: ran and its
   *  gate passed (or no gate and every step succeeded). WARNED: a `warn` gate failed, or a step
   *  failed or an agent was negative in a stage with no gate (D43). FAILED: a blocking gate failed,
   *  a step failed behind a blocking gate, or the stage threw. SKIPPED: its
   *  condition was false, every agent was skipped by its own condition, a stage it depends on
   *  failed behind `abort`, or a stop came before it launched. ERRORED: could not be judged.
   *  `stages.<id>.passed` in a condition is `outcome === 'PASSED'`. */
  outcome?: StageOutcome;

  /** The failure mode the stage was judged under: `on_failure`, with `skip` read as `fail`, an
   *  absent `on_failure` as `abort`, and a stage with no gate as `warn` (D43; its decision key is
   *  `not_negative`, not `warn`'s `ignore`). Decides what an
   *  ERRORED stage does to the run (§3.1). Absent on a stage that did not launch. */
  gateMode?: GateMode;

  /** Why the stage is ERRORED (each reason that holds): `agent_unjudgeable` (an agent gave no
   *  decision at a blocking gate, whatever its score (D12); no score at a gate with a threshold; no
   *  score and no classifiable decision; or crashed, a timeout included), `condition_error` (a condition evaluated to E), `stopped` (in flight at a cancel,
   *  deadline or credit stop). Each reason is also a `STAGE_ERRORED` warning on the run. */
  erroredReasons?: ErroredReason[];

  /** Result (command or workflow depending on stage type) */
  result?: CommandResult | WorkflowResult;

  /** Individual agent results for inline-agent stages (preserved for tracker decomposition) */
  agentResults?: AgentResult[];

  /** Per-step results for steps stages executed under allowStageSteps
   *  (pdl-steps-execution-spec D4). Absent when steps were not executed. */
  steps?: StepResult[];

  /** Why the stage did not complete normally, as text: the skip reason for a SKIPPED stage
   *  (`condition_not_met`, `gate_abort`, `cancelled`, …), the error for a stage that threw, and the
   *  ERRORED reasons with their detail for an ERRORED stage (`agent_unjudgeable: "a" gave no
   *  decision at a blocking gate`). Forwarded upstream context reads it as a stage's failure text.
   *  For a machine-readable reason, read `outcome` and `erroredReasons`. */
  skipReason?: string;

  /** Stage start time */
  startedAt?: string;

  /** Stage completion time */
  completedAt?: string;

  /** Stage duration */
  durationMs?: number;
}

/** PDL 1.6.0 stage status (§3.1). */
export type StageOutcome = 'PASSED' | 'WARNED' | 'FAILED' | 'SKIPPED' | 'ERRORED';

/** A stage's failure mode: `abort` and `fail` are blocking, `warn` is not. */
export type GateMode = 'abort' | 'fail' | 'warn';

/** Why a stage is ERRORED (§3.1, D19). */
export type ErroredReason = 'agent_unjudgeable' | 'condition_error' | 'stopped';

/**
 * A run-level warning (PDL 1.6.0). Agent-level reading warnings live on each agent's
 * `AgentResult.verdict.warnings`; these are the ones a stage or the run produces.
 * - `STAGE_ERRORED` (D19): every ERRORED stage, once per reason. Behind `warn` an ERRORED stage
 *   leaves `allGatesPassed` unchanged, so this warning is the only place the error shows.
 * - `CONDITIONAL_ACCEPTED` (gate-decision D2): a blocking gate passed a CONDITIONAL agent;
 *   `allGatesPassed` is false.
 */
export type PipelineWarning =
  | { code: 'STAGE_ERRORED'; stage: string; reason: ErroredReason }
  | { code: 'CONDITIONAL_ACCEPTED'; stage: string; agent: string };

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

  /** Run-level warnings raised so far (PDL 1.6.0; see {@link PipelineWarning}). */
  warnings?: PipelineWarning[];

  /** The resolved run parameters, recorded when the stage loop starts. */
  params?: Record<string, string | number | boolean>;

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
