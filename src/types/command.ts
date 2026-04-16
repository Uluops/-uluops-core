import type { ExecutionResult, ExecutionMetrics, Domain, AgentType } from './execution.js';

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

    /** Execution configuration */
    execution: {
      /** Model selection (alias, tier, or provider:modelId — resolved via ModelCatalog) */
      model: {
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

  /** Maximum possible score (validators only) */
  maxScore?: number;

  /** Threshold for pass/fail (validators only) */
  threshold?: number;

  /** Per-category breakdown (validators only) */
  categories?: CategoryResult[];

  /** Generated artifacts (executors only) */
  artifacts?: ArtifactResult[];

  /** Command-specific metrics */
  metrics: CommandMetrics;
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

  /** Points earned */
  score: number;

  /** Maximum score possible */
  maxScore: number;

  /** Findings within category */
  findings: Finding[];
}

/**
 * Finding within a category
 */
export interface Finding {
  /** Criterion evaluated */
  criterion: string;

  /** Points earned */
  pointsEarned: number;

  /** Points possible */
  pointsPossible: number;

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
  priority: 'critical' | 'suggested' | 'backlog';
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
