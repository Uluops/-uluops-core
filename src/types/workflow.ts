import type { ExecutionResult, ExecutionMetrics, Domain } from './execution.js';
import type { CommandResult } from './command.js';

/**
 * Workflow definition - multi-phase command orchestration
 */
export interface WorkflowDefinition {
  workflow: {
    /** Workflow metadata */
    interface: {
      name: string;
      version: string;
      displayName: string;
      description: string;
      domain: Domain;
      subdomain?: string;
    };

    /** Phase orchestration */
    orchestration: {
      /** Ordered phases */
      phases: PhaseDefinition[];

      /** Behavior on phase failure */
      on_failure: 'stop' | 'continue' | 'abort' | 'warn';

      /** Maximum concurrent phases (default: unlimited) */
      max_parallel?: number;
    };

    /** Result aggregation */
    aggregation: {
      /** Score aggregation */
      score: {
        method: 'average' | 'weighted_average' | 'min' | 'max' | 'sum';
        weights?: Record<string, number>;
      };

      /** Decision mapping */
      decision: {
        SHIP: string;
        HOLD: string;
        BLOCK: string;
      };
    };
  };
}

/**
 * Phase definition within a workflow
 */
export interface PhaseDefinition {
  id: string;
  name: string;

  /** Phase type hint */
  type?: 'validate' | 'execute' | 'mixed';

  /** Commands to execute in this phase (refs in name@version format) */
  commands: string[];

  /** Execute commands in parallel */
  parallel?: boolean;

  /** Phase dependencies */
  depends_on?: string[];

  /** Input mappings from previous phases */
  inputs?: Record<string, string>;

  /** Skip condition expression */
  skip_if?: string;

  /** Phase gate (validators only) */
  gate?: {
    threshold: number;
    aggregate: 'average' | 'min' | 'max';
    on_fail: 'stop' | 'warn' | 'abort';
  };
}

/**
 * Workflow execution result
 */
export interface WorkflowResult extends ExecutionResult {
  type: 'workflow';

  /** Phase-by-phase results */
  phases: PhaseResult[];

  /** Path to generated features list (if enabled) */
  featuresListPath?: string;

  /** Workflow-specific metrics */
  metrics: WorkflowMetrics;
}

/**
 * Workflow-specific metrics
 */
export interface WorkflowMetrics extends ExecutionMetrics {
  /** Number of phases executed */
  phasesExecuted: number;

  /** Number of phases passed */
  phasesPassed: number;

  /** Number of phases warned */
  phasesWarned: number;

  /** Number of phases blocked */
  phasesBlocked: number;

  /** Number of phases skipped */
  phasesSkipped: number;

  /** Number of phases aborted */
  phasesAborted: number;

  /** Per-command metrics breakdown */
  commands: CommandMetricsSummary[];
}

/**
 * Per-command metrics within a workflow
 */
export interface CommandMetricsSummary {
  name: string;
  score: number;
  decision: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd?: number;
}

/**
 * Result for a single phase
 */
export interface PhaseResult {
  /** Phase identifier */
  id: string;

  /** Phase display name */
  name: string;

  /** Phase decision */
  decision: 'passed' | 'warned' | 'blocked' | 'skipped' | 'aborted';

  /** Command results within phase */
  commands: CommandResult[];

  /** Gate threshold that was applied */
  gateThreshold: number;

  /** Aggregated phase score */
  score: number;

  /** Phase duration */
  durationMs: number;
}
