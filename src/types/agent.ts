import type { Domain, AgentType, ExecutionMetrics, Recommendation } from './execution.js';
import type { Finding, ArtifactResult } from './command.js';

/**
 * Agent definition - the atomic validation/execution unit
 * Agents are NOT directly executable; they must be wrapped in a Command
 */
export interface AgentDefinition {
  agent: {
    /** Agent metadata */
    interface: {
      name: string;
      version: string;
      displayName: string;
      description: string;
      domain: Domain;
      subdomain?: string;
      agentType: AgentType;
      tags?: string[];
    };

    /** Agent behavior specification */
    behavior: {
      /** Role description for the agent */
      role: string;

      /** Core competencies */
      expertise: string[];

      /** Evaluation methodology */
      methodology?: string;

      /** Scoring categories (for validators) */
      categories?: AgentCategory[];

      /** Task types (for executors) */
      tasks?: AgentTask[];
    };

    /** Output specification */
    output: {
      /** Expected output format */
      format: 'json' | 'markdown' | 'structured';

      /** JSON schema for structured output (optional) */
      schema?: Record<string, unknown>;
    };
  };
}

/**
 * Scoring category for validator agents
 */
export interface AgentCategory {
  name: string;
  weight: number;
  criteria: string[];
}

/**
 * Task type for executor agents
 */
export interface AgentTask {
  name: string;
  description: string;
  inputs?: string[];
  outputs?: string[];
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

  /** Final decision */
  decision: string;

  /** All recommendations */
  recommendations: Recommendation[];

  /** Total execution duration in ms */
  durationMs: number;

  /** Dashboard URL (populated after validation submission) */
  dashboardUrl?: string;

  /** Execution metrics */
  metrics: ExecutionMetrics;
}

/**
 * Result from a validator agent execution
 *
 * Validators produce a numerical score, decision (PASS/WARN/FAIL),
 * and scored categories.
 */
export interface ValidatorAgentResult extends AgentResultBase {
  agentType: 'validator';

  /** Decision for validators */
  decision: 'PASS' | 'WARN' | 'FAIL';

  /** Validator score (0-100) */
  score: number;

  /** Maximum possible score */
  maxScore: number;

  /** Pass threshold used */
  threshold?: number;

  /** Scored categories */
  categories?: Array<{
    name: string;
    score: number;
    maxScore: number;
    findings: Finding[];
  }>;
}

/**
 * Result from an executor agent execution
 *
 * Executors produce artifacts and a completion decision
 * (COMPLETE/PARTIAL/FAILED).
 */
export interface ExecutorAgentResult extends AgentResultBase {
  agentType: 'executor';

  /** Decision for executors */
  decision: 'COMPLETE' | 'PARTIAL' | 'FAILED';

  /** Score is optional for executors */
  score?: number;

  /** Generated artifacts */
  artifacts?: ArtifactResult[];
}

/**
 * Discriminated union of all agent result types
 *
 * Use `result.agentType` to narrow:
 * ```typescript
 * if (result.agentType === 'validator') {
 *   console.log(result.score); // ValidatorAgentResult
 * } else {
 *   console.log(result.artifacts); // ExecutorAgentResult
 * }
 * ```
 */
export type AgentResult = ValidatorAgentResult | ExecutorAgentResult;
