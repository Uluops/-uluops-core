import type { ExecutionResult, ExecutionMetrics, Domain, AgentType } from './execution.js';
import type { DegradationMarker } from './degradation.js';

/**
 * Command definition - Agent(s) + execution context
 */
export interface CommandDefinition {
  command: {
    /** Command metadata */
    interface: {
      name: string;
      version: string;
      displayName: string;
      description: string;
      domain: Domain;
      subdomain?: string;
    };

    /** References to wrapped agent(s) as refs (name@version format) */
    agents: string[];

    /**
     * Execution configuration. Optional, as in the CDL 2.0.0 schema (which requires only
     * `interface`): a command may declare no `execution` block, or one holding only `preflight`
     * (the normalizer builds that shape). Until 0.55.0 this type declared the block and its `model`
     * always present, which a schema-valid definition does not guarantee; an unguarded read of
     * `execution.model.default` threw a TypeError on such a command.
     */
    execution?: {
      /**
       * Model selection (alias, tier, or provider:modelId — resolved via ModelCatalog). Optional;
       * when absent the command runs on the operator override, else the agent's own model.
       * `default` is required when `model` is present, as in the schema.
       */
      model?: {
        default: string;
        allowed?: string[];
      };

      /** Timeout in ms */
      timeout?: number;

      /** Sequential execution for multiple agents (default: true) */
      sequential?: boolean;

      /** Preflight checks */
      preflight?: PreflightCheck[];

      /** Postflight actions. @reserved — typed for schema fidelity; not yet processed by CommandExecutor. */
      postflight?: PostflightAction[];

      /** Thresholds for validators */
      thresholds?: {
        /** Score threshold for PASS decision */
        pass: number;
        /** Score threshold for WARN decision (optional) */
        warn?: number;
      };
    };

    /** Aggregation config (required when multiple validators) */
    aggregation?: {
      method: 'average' | 'weighted_average' | 'min' | 'max' | 'sum';
      weights?: Record<string, number>;
    };

    /** Pipeline config (for mixed validator -> executor commands) */
    pipeline?: Array<{
      agent: string;
      output_as?: string;
      input_from?: string;
      filter?: string;
    }>;

    /** Output schema override (optional) */
    output?: {
      schema: string;
    };
  };
}

/**
 * Preflight check definition
 */
export interface PreflightCheck {
  /** Check type */
  check: 'file_exists' | 'path_exists' | 'command' | 'env_var' | 'git_clean';

  /** Path for file_exists check */
  path?: string;

  /** Command for command check */
  command?: string;

  /** Environment variable name for env_var check */
  var?: string;

  /** Error message shown when check fails */
  message?: string;
}

/**
 * Postflight action definition
 */
export interface PostflightAction {
  type: 'report' | 'notify' | 'custom';
  config: Record<string, unknown>;
}

/**
 * Command execution result
 */
export interface CommandResult extends ExecutionResult {
  type: 'command';

  /** Agent type that was executed */
  agentType: AgentType;

  /** Maximum possible score (validators only; null iff score null) */
  maxScore?: number | null;

  /** Threshold for pass/fail (validators only) */
  threshold?: number;

  /** Per-category breakdown (validators only) */
  categories?: CategoryResult[];

  /** Generated artifacts (executors only) */
  artifacts?: ArtifactResult[];

  /** Command-specific metrics */
  metrics: CommandMetrics;

  /**
   * Core-stamped marks of what happened INSIDE this command (utils/stopVerdict.ts):
   * `execution.run-stopped` (a stop left it without a verdict — what `isStoppedResult` keys on),
   * `execution.run-stopped-partial` (a stop reached it and something inside crashed, so it is
   * FAIL), `execution.child-crashed` (a real crash inside), `execution.deadline` (a crash record a
   * caller deadline produced). Never inferred from the decision string, which a model can emit
   * freely. Not a general channel: an agent's own markers (`budget.*`, `context.*`) are not lifted
   * onto a command.
   */
  degradationMarkers?: DegradationMarker[];
}

/**
 * Command-specific metrics (extends base)
 */
export interface CommandMetrics extends ExecutionMetrics {
  /** Number of tool calls made */
  toolCalls: number;
}

/**
 * Category-level result (for validators)
 */
export interface CategoryResult {
  /** Category name */
  name: string;

  /** Points earned (null iff maxScore null) */
  score: number | null;

  /** Maximum score possible (null for scoreless agents) */
  maxScore: number | null;

  /** Findings within category */
  findings: Finding[];
}

/**
 * Finding within a category
 */
export interface Finding {
  /** Criterion evaluated */
  criterion: string;

  /** Points earned (null for scoreless agents / degenerate parses) */
  pointsEarned: number | null;

  /** Points possible (null for scoreless agents / degenerate parses) */
  pointsPossible: number | null;

  /** Issues found */
  issues: Issue[];
}

/**
 * Individual issue (before flattening to Recommendation).
 *
 * COUPLING: This type must stay synchronized with:
 * - `issueSchema` in parser/outputSchemas.ts (Zod schema for structured output)
 * - `flattenRecommendations()` in executor/AgentExecutor.ts (Issue → Recommendation mapping)
 * A compile-time check in outputSchemas.ts will error if fields diverge.
 */
export interface Issue {
  title: string;
  priority: 'critical' | 'high' | 'suggested' | 'backlog';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  failureCode?: string;
  filePath?: string;
  lineNumber?: number;
  description: string;
}

/**
 * Artifact result (for executors)
 */
export interface ArtifactResult {
  name: string;
  path: string;
  size?: number;
  contentType?: string;
}
