# @uluops/core SDK Specification

**Version:** 0.9.0
**Status:** Implementation-Ready
**Created:** 2026-01-10
**Updated:** 2026-02-05
**Parent Specs:** uluops-core-sdk-spec-v0.8.0, uluops-ai-sdk-integration-spec-v0.1.0
**Dependencies:** Vercel AI SDK v6.x, @uluops/sdk-core

---

## Table of Contents

- [Overview](#overview)
  - [Design Principles](#design-principles)
  - [Terminology](#terminology)
- [Architecture](#architecture)
  - [Service Architecture](#service-architecture)
- [Package Structure](#package-structure)
- [Core Types](#core-types)
  - [Configuration](#configuration)
  - [Base Execution Types](#base-execution-types)
  - [Agent Types](#agent-types)
  - [Command Types](#command-types)
  - [Workflow Types](#workflow-types)
  - [Pipeline Types](#pipeline-types)
  - [Tool Types](#tool-types)
  - [Registry Types](#registry-types)
  - [Validation Types](#validation-types)
- [Core Classes](#core-classes)
  - [ToolHandler](#toolhandler)
  - [AIProvider](#aiprovider)
  - [ToolAdapter](#tooladapter)
  - [AgentExecutor](#agentexecutor)
  - [RegistryClient](#registryclient)
  - [ValidationClient](#validationclient)
  - [CommandExecutor](#commandexecutor)
  - [WorkflowExecutor](#workflowexecutor)
  - [PipelineExecutor](#pipelineexecutor)
  - [UluOpsClient](#uluopsclient)
- [Public Exports](#public-exports)
- [Usage Examples](#usage-examples)
- [Error Classes](#error-classes)
- [Configuration Reference](#configuration-reference)
- [Security Considerations](#security-considerations)
- [Deferred Features](#deferred-features)
- [Revision History](#revision-history)

---

## Overview

`@uluops/core` is the foundational SDK that powers all UluOps execution contexts. It provides:

- **Unified execution** of agents, commands, workflows, and pipelines
- **Multi-provider LLM integration** via Vercel AI SDK v6 (Claude, GPT, Gemini)
- **Automatic tool loop management** via AI SDK's `maxSteps` parameter
- **Tool-based filesystem access** for code analysis
- **Registry integration** with local development fallback
- **Result submission** to validation service for persistence and correlation
- **Hash verification** for definition integrity

The SDK is a **thin execution layer** that orchestrates two backend services:

| Service | Responsibility |
|---------|----------------|
| **uluops-registry-api** | Definition storage, versioning, rendering, hash verification |
| **uluops-validation-api** | Result persistence, fingerprinting, issue correlation, analytics |

All delivery mechanisms (CLI, MCP, direct SDK) are thin wrappers around this core.

### Design Principles

1. **Unified interface** - `run()` works for agents, commands, workflows, and pipelines
2. **Tool-loop architecture** - LLM requests files, SDK fulfills locally
3. **AI SDK delegation** - LLM communication, retries, and tool loop orchestration delegated to Vercel AI SDK v6
4. **Provider-agnostic** - Swap Claude for GPT or Gemini by changing one config field
5. **Partial results on failure** - Errors include completed work
6. **Local-first development** - Support local definitions without remote registry
7. **Thin client** - Delegate fingerprinting, correlation, and persistence to backend services
8. **Service separation** - Registry and validation services are independent and composable
9. **Content-addressed verification** - Verify definition integrity via hashes

### Terminology

| Term | Definition |
|------|------------|
| **Agent** | Atomic unit containing validation/execution logic. Two types: `validator` (scoring) or `executor` (tasks). **Directly executable** with call-time options. |
| **Command** | Saved execution configuration: agent reference(s) + model + thresholds + preflight checks. Used for reproducible runs and multi-agent aggregation. |
| **Workflow** | Multi-phase orchestration of commands with gates and aggregation |
| **Pipeline** | Multi-stage execution flow that can include commands, workflows, or both |
| **ExecutionOptions** | Runtime configuration (model, timeout, thresholds) provided at call-time for agent execution |
| **Tool Loop** | The request-fulfill-continue cycle where Claude requests files and SDK provides them locally |
| **Gate** | A threshold-based decision point in workflows that can PASS, WARN, or BLOCK |
| **Fingerprint** | A SHA-256 hash used to correlate findings across runs (computed by uluops-validation-api) |
| **Definition Hash** | SHA-256 hash of definition YAML for integrity verification (computed by uluops-registry-api) |

**Execution Patterns:**

| Pattern | Use Case | Configuration Source |
|---------|----------|---------------------|
| Direct Agent | Interactive, ad-hoc, experimentation | Call-time `ExecutionOptions` |
| Command | Reproducible CI, team standards, multi-agent | Persisted in command definition |
| Workflow | Multi-phase validation gates | Command configs + workflow aggregation |
| Pipeline | Complex multi-stage orchestration | Workflow/command configs + triggers |

**Definition Type Hierarchy:**

```
Pipeline (.pipeline.yaml)
    ├── references: Workflows, Commands
    └── cannot reference: Agents directly

Workflow (.workflow.yaml)
    ├── references: Commands
    └── cannot reference: Agents directly, Pipelines

Command (.command.yaml)
    ├── references: One or more Agents
    ├── validators only → aggregation required
    ├── executors only → sequential execution
    ├── mixed → pipeline config required
    └── cannot reference: Commands, Workflows, Pipelines

Agent (.agent.yaml)
    ├── atomic unit (validator or executor)
    └── cannot reference: anything
```

**Decision Domains:**

Different execution contexts use different decision vocabularies, each appropriate to their semantics:

| Context | Values | Description |
|---------|--------|-------------|
| **Validator Commands** | `PASS`, `WARN`, `FAIL` | Threshold-based validation outcomes |
| **Executor Commands** | `COMPLETE`, `PARTIAL`, `FAILED` | Task completion states |
| **Workflow Phases** | `passed`, `warned`, `blocked`, `skipped` | Phase execution outcomes (lowercase for JSON compatibility) |
| **Pipeline Stages** | `pending`, `running`, `passed`, `failed`, `skipped` | Stage lifecycle states |
| **Gates** | `PASS`, `WARN`, `BLOCK` | Gate threshold decisions |

This separation is intentional:
- **Commands** use uppercase for clear pass/fail semantics
- **Phases/Stages** use lowercase for JSON-friendly status tracking
- **Gates** use `BLOCK` instead of `FAIL` to indicate workflow stoppage rather than validation failure

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           @uluops/core v0.8.0                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         UluOpsClient                                  │  │
│  │                                                                       │  │
│  │   run(name, input) ────► RegistryClient ────► Router ────► Executor   │  │
│  │                               │                   │                   │  │
│  │                      ┌────────┴────────┐    ┌────┴────────────────┐   │  │
│  │                      │                 │    │  CommandExecutor    │   │  │
│  │                      ▼                 ▼    │  WorkflowExecutor   │   │  │
│  │                Remote API      Local Files  │  PipelineExecutor   │   │  │
│  │                                             └─────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │ CommandExecutor │  │WorkflowExecutor │  │PipelineExecutor │              │
│  │                 │  │                 │  │                 │              │
│  │ • Tool loop     │  │ • Phases        │  │ • Stages        │              │
│  │ • Scoring       │  │ • Gates         │  │ • Async exec    │              │
│  │ • Single run    │  │ • Aggregation   │  │ • State mgmt    │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              │
│           │                    │                    │                       │
│           │    ┌───────────────┴────────────────────┘                       │
│           │    │                                                            │
│           ▼    ▼                                                            │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         ToolHandler                                   │  │
│  │                                                                       │  │
│  │   read_file() ──► Local filesystem access within target               │  │
│  │   list_files() ──► Glob-based file discovery                          │  │
│  │   search_content() ──► Pattern matching across files                  │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    AIProvider + ToolAdapter                            │  │
│  │                                                                       │  │
│  │  • AI SDK generateText() with maxSteps for tool loops                 │  │
│  │  • ToolAdapter converts ToolHandler → AI SDK tool format              │  │
│  │  • Multi-provider support (Anthropic, OpenAI, Google)                 │  │
│  │  • Usage extraction and error mapping                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │ RegistryClient  │  │ ValidationClient   │  │ OutputExtractor │              │
│  │                 │  │                 │  │                 │              │
│  │ • Remote API    │  │ • Submit runs   │  │ • JSON parsing  │              │
│  │ • Local files   │  │ • Get dashboard │  │ • Score extract │              │
│  │ • Caching       │  │ • Query history │  │ • Issue flatten │              │
│  │ • Hash verify   │  │                 │  │                 │              │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Service Architecture

The SDK orchestrates two independent backend services:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              @uluops/core SDK                               │
│                            (Thin Execution Layer)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  UluOpsClient.run(name, input)                                              │
│       │                                                                     │
│       ├──► RegistryClient ──► Resolve definition + rendered runtime        │
│       │         │                                                           │
│       │         ├──► Local files (if configured)                            │
│       │         │      • .agent.yaml, .command.yaml                         │
│       │         │      • .workflow.yaml, .pipeline.yaml                     │
│       │         │                                                           │
│       │         └──► uluops-registry-api (remote)                           │
│       │               • GET /v1/definitions/{type}/{name}@{version}         │
│       │               • GET /v1/render/{type}/{name}@{version}              │
│       │               • Hash verification on response                       │
│       │                                                                     │
│       ├──► Executor (Command/Workflow/Pipeline)                             │
│       │         │                                                           │
│       │         ├──► AIProvider (AI SDK generateText with maxSteps)         │
│       │         ├──► ToolAdapter (converts to AI SDK tool format)           │
│       │         └──► ToolHandler (filesystem access)                        │
│       │                                                                     │
│       └──► ValidationClient ──► Submit results                                 │
│                 │                                                           │
│                 └──► uluops-validation-api                                  │
│                       • POST /v1/runs (submit results)                      │
│                       • Fingerprint generation (server-side)                │
│                       • Issue correlation (server-side)                     │
│                       • Regression detection (server-side)                  │
│                       • Returns dashboard URL                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Insight**: The SDK does NOT handle fingerprinting, issue correlation, or regression detection. These responsibilities belong to the `uluops-validation-api`, which receives raw results from the SDK.

---

## Package Structure

```
@uluops/core/
├── src/
│   ├── index.ts                    # Public exports
│   │
│   ├── client/
│   │   ├── UluOpsClient.ts         # Main client class
│   │   └── PipelineHandle.ts       # Async pipeline monitoring
│   │
│   ├── executor/
│   │   ├── AgentExecutor.ts        # Single-agent execution via AIProvider
│   │   ├── CommandExecutor.ts      # Single command execution
│   │   ├── WorkflowExecutor.ts     # Multi-command phase orchestration
│   │   ├── PipelineExecutor.ts     # Multi-workflow stage orchestration
│   │   ├── ToolHandler.ts          # Filesystem tool fulfillment
│   │   └── preflight.ts            # Preflight check handlers
│   │
│   ├── ai/                          # AI SDK integration (v0.9.0, replaces claude/)
│   │   ├── AIProvider.ts           # AI SDK wrapper with tool loop via maxSteps
│   │   ├── ToolAdapter.ts          # Converts ToolHandler tools to AI SDK format
│   │   └── index.ts                # AI module exports
│   │
│   ├── registry/
│   │   └── RegistryClient.ts       # Local resolution, remote fetch, hash verification
│   │
│   ├── validation/
│   │   └── ValidationClient.ts     # Core execution submission (submit, validate, getRun)
│   │
│   ├── parser/
│   │   └── OutputExtractor.ts      # JSON extraction from LLM responses
│   │
│   ├── errors/
│   │   ├── UluOpsError.ts          # Base error class
│   │   └── index.ts                # All error classes + re-exports from @uluops/sdk-core
│   │
│   └── types/
│       ├── index.ts                # Type exports
│       ├── config.ts               # Configuration types
│       ├── execution.ts            # Base execution types
│       ├── agent.ts                # Agent definition types
│       ├── command.ts              # Command-specific types
│       ├── workflow.ts             # Workflow-specific types
│       ├── pipeline.ts             # Pipeline-specific types
│       ├── ai.ts                   # AI SDK types (replaces claude.ts)
│       ├── registry.ts             # Registry client types
│       ├── validation.ts           # Validation client types
│       ├── parser.ts               # Parser types
│       └── tools.ts                # Tool definition types
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## Environment Variables

The SDK automatically reads from environment variables as fallbacks when config properties are not provided:

| Environment Variable | Config Property | Description |
|---------------------|-----------------|-------------|
| `ULUOPS_API_KEY` or `ULU_API_KEY` | `apiKey` | API key for authentication |
| `ULUOPS_REGISTRY_URL` | `registryUrl` | Registry API base URL |
| `ULUOPS_VALIDATION_URL` | `validationUrl` | Validation API base URL |
| `ULUOPS_DASHBOARD_URL` | `dashboardUrl` | Dashboard base URL for links |
| `ULUOPS_LOCAL_DEFINITIONS` | `localDefinitions` | Local definitions directory |
| `ULUOPS_TRACKING_ENABLED` | `trackingEnabled` | Set to "false" to disable |
| `ULUOPS_PROJECT` | `defaultProject` | Default project name |

**Priority:** Explicit config > Environment variable > Default value

---

## Core Types

### Configuration

```typescript
// src/types/config.ts

/**
 * SDK Configuration
 */
export interface UluOpsConfig {
  /** API key for authentication (used for both services). Falls back to ULUOPS_API_KEY or ULU_API_KEY env var. */
  apiKey?: string;

  /**
   * Base URL for uluops-registry-api
   * @default "https://registry.uluops.ai/api"
   */
  registryUrl?: string;

  /**
   * Base URL for uluops-validation-api
   * @default "https://ops.uluops.ai/api"
   */
  validationUrl?: string;

  /**
   * Base URL for dashboard links
   * @default "https://app.uluops.ai"
   */
  dashboardUrl?: string;

  /**
   * Local definitions directory for development
   * When set, SDK looks here first before remote registry
   * Supports: *.agent.yaml, *.command.yaml, *.workflow.yaml, *.pipeline.yaml
   */
  localDefinitions?: string;

  /**
   * Enable result submission to validation service
   * @default true
   */
  trackingEnabled?: boolean;

  /**
   * Enable hash verification for definitions
   * @default true
   */
  hashVerificationEnabled?: boolean;

  /** Request timeout in ms (default: 300000) */
  timeout?: number;

  /** Model override for all executions */
  modelOverride?: 'haiku' | 'sonnet' | 'opus';

  /** Default project name for validation service */
  defaultProject?: string;

}

/**
 * Validated configuration with defaults applied
 */
export interface ResolvedConfig {
  apiKey: string;
  registryUrl: string;
  validationUrl: string;
  dashboardUrl: string;
  localDefinitions?: string;
  trackingEnabled: boolean;
  hashVerificationEnabled: boolean;
  timeout: number;
  modelOverride?: 'haiku' | 'sonnet' | 'opus';
  defaultProject?: string;
}
```

### Base Execution Types

```typescript
// src/types/execution.ts

/**
 * Definition type discriminator
 */
export type DefinitionType = 'agent' | 'command' | 'workflow' | 'pipeline';

/**
 * Execution type discriminator (excludes agent - agents aren't directly executable)
 */
export type ExecutionType = 'command' | 'workflow' | 'pipeline';

/**
 * Domain classification for definitions
 */
export type Domain = 
  | 'software'    // Code, APIs, infrastructure, DevOps
  | 'legal'       // Contracts, compliance, regulations
  | 'medical'     // Clinical, diagnostic, pharmaceutical
  | 'financial'   // Portfolio, risk, trading, compliance
  | 'scientific'  // Research, data analysis, methodology
  | 'content'     // Writing, media, marketing, creative
  | 'general';    // Cross-domain, meta-level, utilities

/**
 * Agent type discriminator
 */
export type AgentType = 'validator' | 'executor';

/**
 * Base input for all execution types
 */
export interface ExecutionInput {
  /** Target path to analyze */
  target: string;
  
  /** Execution options */
  options?: Record<string, unknown>;
}

/**
 * Base result for all execution types
 */
export interface ExecutionResult {
  /** Execution type discriminator */
  type: ExecutionType;
  
  /** Name of executed definition */
  name: string;
  
  /** Version executed */
  version: string;
  
  /** Definition hash for audit trail */
  definitionHash: string;
  
  /** Final decision */
  decision: string;
  
  /** Aggregated score (0-100). Optional — not all execution types produce scores. */
  score?: number;
  
  /** Total execution duration */
  durationMs: number;
  
  /** Dashboard URL for this run (populated after validation service submission) */
  dashboardUrl?: string;
  
  /** All recommendations (flattened for workflows/pipelines) */
  recommendations: Recommendation[];
  
  /** Execution metrics */
  metrics: ExecutionMetrics;
}

/**
 * Base metrics collected for all executions
 */
export interface ExecutionMetrics {
  /** Total input tokens */
  inputTokens: number;
  
  /** Total output tokens */
  outputTokens: number;
  
  /** Cache creation tokens */
  cacheCreationTokens?: number;
  
  /** Cache read tokens */
  cacheReadTokens?: number;
  
  /** Total effective tokens (for cost) */
  totalEffectiveTokens: number;
  
  /** Execution duration in ms */
  durationMs: number;
  
  /** Model used (or primary model for workflows) */
  model: string;
  
  /** Estimated cost in USD */
  costUsd?: number;
}

/**
 * Call-time execution options for direct agent runs
 *
 * These options are provided at runtime via `runAgent()` and override
 * any defaults from the agent definition. For reproducible configurations,
 * use Commands instead.
 *
 * @example
 * ```typescript
 * await client.runAgent('code-validator', './src', {
 *   model: 'opus',
 *   timeoutMs: 300000,
 *   thresholds: { pass: 80, warn: 60 },
 * });
 * ```
 */
export interface ExecutionOptions {
  /** Model override: 'haiku' | 'sonnet' | 'opus' */
  model?: 'haiku' | 'sonnet' | 'opus';

  /** Maximum tokens for response */
  maxTokens?: number;

  /** Execution timeout in milliseconds */
  timeoutMs?: number;

  /** Threshold overrides for validators */
  thresholds?: {
    pass?: number;
    warn?: number;
  };

  /** Submit results to validation service (default: true) */
  trackResults?: boolean;

  /** Project name for result tracking */
  project?: string;
}

/**
 * Merged execution context from agent defaults + runtime options
 * Used internally by AgentExecutor
 */
export interface ResolvedExecutionContext {
  /** Resolved model (from options > agent defaults > config default) */
  model: 'haiku' | 'sonnet' | 'opus';

  /** Resolved max tokens */
  maxTokens: number;

  /** Resolved timeout in ms */
  timeoutMs: number;

  /** Resolved thresholds (for validators) */
  thresholds?: {
    pass: number;
    warn: number;
  };

  /** Whether to track results */
  trackResults: boolean;

  /** Project for tracking */
  project?: string;
}

/**
 * Individual recommendation/issue
 * Contains fields used by both SDK and Validation API
 */
export interface Recommendation {
  /**
   * Source validator name (preferred)
   * Use this for new code - aligns with Validation API
   */
  validator?: string;

  /** Issue title */
  title: string;

  /** Priority level */
  priority: 'critical' | 'suggested' | 'backlog';

  /** Severity level */
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';

  /** Failure taxonomy code (e.g., "SEM-INC/H") */
  failureCode?: string;

  /** Failure domain (STR=Structural, SEM=Semantic, PRA=Pragmatic, EPI=Epistemic) */
  failureDomain?: 'STR' | 'SEM' | 'PRA' | 'EPI';

  /** Failure mode code (e.g., "SYN", "VAL", "INC") */
  failureMode?: string;

  /** Issue category (e.g., "type-safety", "security") */
  category?: string;

  /** Type of Issue  (e.g. "feature", "bug", "docs", "config") **/
  type?: string;

  /** File path relative to target */
  filePath?: string;

  /** Line number in file */
  lineNumber?: number;

  /** Detailed description */
  description?: string;

  /** Classification confidence */
  classificationConfidence?: 'high' | 'medium' | 'low';

  /** Who classified this issue */
  classifiedBy?: 'validator' | 'classifier' | 'human';

  /** Secondary failure codes when multiple issues apply */
  secondaryFailureCodes?: string[];

  /** Version of failure taxonomy used */
  taxonomyVersion?: string;

  /** Fingerprint for correlation (populated by validation API) */
  fingerprint?: string;
}
```

### Agent Types

```typescript
// src/types/agent.ts

import { Domain, AgentType } from './execution';

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
  recommendations: import('./execution').Recommendation[];

  /** Total execution duration in ms */
  durationMs: number;

  /** Dashboard URL (populated after validation submission) */
  dashboardUrl?: string;

  /** Execution metrics */
  metrics: import('./execution').ExecutionMetrics;
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
    findings: import('./command').Finding[];
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
  artifacts?: import('./command').ArtifactResult[];
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
```

### Command Types

```typescript
// src/types/command.ts

import { ExecutionResult, ExecutionMetrics, Recommendation, Domain, AgentType } from './execution';

/**
 * Command definition - Agent(s) + execution context
 * Commands are the primary executable unit
 *
 * Commands can wrap one or more agents:
 * - Single validator: Simple validation command
 * - Multiple validators: Aggregated score (weighted average, min, max)
 * - Single executor: Simple execution command
 * - Multiple executors: Sequential execution pipeline
 * - Mixed (validators → executors): Validate-then-fix pattern
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

    /**
     * References to wrapped agent(s) as refs (name@version format)
     * Examples: ["code-validator@1.2.0", "type-safety-validator@latest"]
     * Agent types are resolved at runtime from the referenced agent definitions
     */
    agents: string[];

    /** Execution configuration */
    execution: {
      /** Model selection */
      model: {
        default: 'haiku' | 'sonnet' | 'opus';
        allowed?: Array<'haiku' | 'sonnet' | 'opus'>;
      };

      /** Timeout in ms */
      timeout?: number;

      /** Sequential execution for multiple agents (default: true) */
      sequential?: boolean;

      /** Preflight checks */
      preflight?: PreflightCheck[];

      /** Postflight actions */
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

    /** Pipeline config (for mixed validator → executor commands) */
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
 * Aligned with registry spec - uses type-specific fields instead of generic value
 */
export interface PreflightCheck {
  /** Check type (aligned with registry spec) */
  check: 'file_exists' | 'command' | 'env_var' | 'git_clean';

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
  
  /** Maximum points possible */
  maxPoints: number;
  
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
 * Individual issue (before flattening to Recommendation)
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
```

### Workflow Types

```typescript
// src/types/workflow.ts

import { ExecutionResult, ExecutionMetrics, Domain } from './execution';
import { CommandResult } from './command';

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
      on_failure: 'stop' | 'continue' | 'skip_dependents';
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

  /**
   * Phase type hint - indicates what kind of commands this phase contains
   * - validate: All commands run validators (scoring)
   * - execute: All commands run executors (tasks)
   * - mixed: Phase contains both validator and executor commands
   */
  type?: 'validate' | 'execute' | 'mixed';

  /** Commands to execute in this phase (refs in name@version format) */
  commands: string[];

  /** Execute commands in parallel */
  parallel?: boolean;

  /** Phase dependencies */
  depends_on?: string[];

  /** Input mappings from previous phases (e.g., { issues: "phases.audit.findings" }) */
  inputs?: Record<string, string>;

  /** Skip condition expression */
  skip_if?: string;

  /** Phase gate (validators only) */
  gate?: {
    threshold: number;
    aggregate: 'average' | 'min' | 'max';
    on_fail: 'block' | 'warn';
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
  decision: 'passed' | 'warned' | 'blocked' | 'skipped';
  
  /** Command results within phase */
  commands: CommandResult[];
  
  /** Gate threshold that was applied */
  gateThreshold: number;
  
  /** Aggregated phase score */
  score: number;
  
  /** Phase duration */
  durationMs: number;
}
```

### Pipeline Types

```typescript
// src/types/pipeline.ts

import { ExecutionResult, ExecutionMetrics, Domain } from './execution';
import { CommandResult } from './command';
import { WorkflowResult } from './workflow';

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

  /**
   * Explicit type of the referenced definition
   * Required - no runtime inference from ref name
   */
  type: 'workflow' | 'command';

  /** Reference to command or workflow (name@version format) */
  ref: string;

  /** Stage dependencies */
  depends_on?: string[];

  /** Execution condition (e.g., "pre-merge.decision == 'PASS'") */
  condition?: string;

  /** Skip condition (deprecated, use condition with negation) */
  skip_if?: string;

  /** Stage-specific options */
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
 * Used by PipelineExecutor to manage async execution
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
```

### Tool Types

```typescript
// src/types/tools.ts

/**
 * Tool definition for Claude API
 */
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool use request from Claude
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result to send back to Claude
 */
export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
```

### Claude Types

> **v0.9.0 Note:** `ClaudeRequest` and `ClaudeResponse` are superseded by AI SDK's `GenerateOptions` and `GenerateResult` from `src/ai/AIProvider.ts`. The `UsageMetrics` type is still used internally. `ToolUseBlock` and `ToolResultBlock` remain used by `ToolHandler`.

```typescript
// src/types/claude.ts

/**
 * Token usage metrics (used across providers)
 */
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

### Parser Types

```typescript
// src/types/parser.ts

import { CategoryResult, ArtifactResult, Issue } from './command';
import { AgentType } from './execution';

/**
 * Raw parsed output from Claude response
 *
 * The OutputExtractor parses Claude's final text response to extract
 * structured validation or execution results. The shape varies by agent type.
 */
export interface ParsedOutput {
  /**
   * Decision outcome from the agent
   * - Validators: 'PASS' | 'WARN' | 'FAIL'
   * - Executors: 'COMPLETE' | 'PARTIAL' | 'FAILED'
   */
  decision: string;

  /**
   * Numeric score (0-100 for validators, may be undefined for executors)
   */
  score?: number;

  /**
   * Maximum possible score (validators only)
   */
  maxScore?: number;

  /**
   * Category breakdown with findings (validators only)
   */
  categories?: ParsedCategory[];

  /**
   * Generated artifacts (executors only)
   */
  artifacts?: ArtifactResult[];

  /**
   * Raw JSON if extraction was from code fence
   */
  rawJson?: unknown;
}

/**
 * Parsed category from validator output
 */
export interface ParsedCategory {
  /** Category name */
  name: string;

  /** Points earned in this category */
  score: number;

  /** Maximum points possible */
  maxPoints: number;

  /** Findings within this category */
  findings: ParsedFinding[];
}

/**
 * Parsed finding within a category
 */
export interface ParsedFinding {
  /** Criterion being evaluated */
  criterion: string;

  /** Points earned */
  pointsEarned: number;

  /** Points possible */
  pointsPossible: number;

  /** Individual issues found */
  issues: Issue[];
}

/**
 * Extraction options
 */
export interface ExtractionOptions {
  /**
   * Whether to throw on parse failure
   * @default false
   */
  strict?: boolean;

  /**
   * Custom JSON code fence language identifier
   * @default 'json'
   */
  codeFenceLanguage?: string;
}

/**
 * Extraction result with metadata
 */
export interface ExtractionResult {
  /** Parsed output */
  output: ParsedOutput;

  /** Extraction method used */
  method: 'json_code_fence' | 'inline_json' | 'structured_text';

  /** Confidence in extraction (0-1) */
  confidence: number;

  /** Any warnings during extraction */
  warnings: string[];
}
```

### Registry Types

```typescript
// src/types/registry.ts

import { DefinitionType, ExecutionType, Domain, AgentType } from './execution';
import { AgentDefinition } from './agent';
import { CommandDefinition } from './command';
import { WorkflowDefinition } from './workflow';
import { PipelineDefinition } from './pipeline';

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
 * Contains scoring categories, thresholds, and prompt
 */
export interface ValidatorRuntime {
  /** Complete system prompt for Claude */
  prompt: string;

  /** Default execution settings */
  defaults: {
    model: 'haiku' | 'sonnet' | 'opus';
    timeout: number;
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
 * Contains tasks, inputs, outputs, and completion criteria
 */
export interface ExecutorRuntime {
  /** Complete system prompt for Claude */
  prompt: string;

  /** Default execution settings */
  defaults: {
    model: 'haiku' | 'sonnet' | 'opus';
    timeout: number;
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
  onFailure: 'stop' | 'continue' | 'skip_dependents';
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
  depends_on?: string[];
  gate?: { threshold: number; aggregate?: 'min' | 'max' | 'average'; on_fail?: 'block' | 'warn' };
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
  event?: string;   // Event name (for type: 'event')
  cron?: string;    // Cron expression (for type: 'schedule')
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
  status: 'draft' | 'published' | 'deprecated';
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
```

### Validation Types

> **Scope Note (v0.9.0):** This file contains only types needed by ValidationClient's 4 core methods (submit, validateRun, getHistory, getRun). Analytics, issue management, and project types are available in `@uluops/ops-sdk`.

```typescript
// src/types/validation.ts

import { ExecutionResult, Recommendation, ExecutionType } from './execution';

/**
 * Validator snapshot for API submission
 * Matches Validation API's validator object format
 */
export interface ValidatorSnapshot {
  /** Validator name */
  name: string;

  /** Score (0-100) */
  score: number;

  /** Maximum possible score */
  max_score?: number;

  /** Status (e.g., 'PASS', 'FAIL', 'WARN') */
  status: string;

  /** Model used */
  model?: string;

  /** Token usage metrics */
  tokens?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation?: number;
    cache_read?: number;
    total_effective?: number;
  };

  /** Execution duration in milliseconds */
  duration_ms?: number;
}

/**
 * Recommendation payload for API submission
 * Uses snake_case to match Validation API format
 */
export interface RecommendationPayload {
  /** Source validator */
  validator: string;

  /** Issue title */
  title: string;

  /** Priority level */
  priority: 'critical' | 'suggested' | 'backlog';

  /** Severity level */
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';

  /** Failure code (e.g., 'STR-SYN/C') */
  failure_code?: string;

  /** Failure domain */
  failure_domain?: 'STR' | 'SEM' | 'PRA' | 'EPI';

  /** Failure mode code */
  failure_mode?: string;

  /** Issue category */
  category?: string;

  /** File path */
  file_path?: string;

  /** Line number */
  line_number?: number;

  /** Detailed description */
  description?: string;

  /** Classification confidence */
  classification_confidence?: 'high' | 'medium' | 'low';

  /** Who classified this */
  classified_by?: 'validator' | 'classifier' | 'human';

  /** Secondary failure codes */
  secondary_failure_codes?: string[];

  /** Taxonomy version */
  taxonomy_version?: string;
}

/**
 * Run submission request to Validation API
 * This is the actual payload sent to POST /v1/runs
 */
export interface ValidationRunRequest {
  /** Project name */
  project: string;

  /** Workflow type (e.g., 'post-implementation', 'ship') */
  workflow_type: string;

  /** Idempotency key for duplicate prevention */
  idempotency_key?: string;

  /** Validator snapshots */
  validators: ValidatorSnapshot[];

  /** Recommendations/issues found */
  recommendations: RecommendationPayload[];

  /** Run timestamp */
  timestamp?: string;

  /** Raw markdown output */
  raw_markdown?: string;

  /** Summary statistics */
  summary?: {
    all_gates_passed: boolean;
    average_score: number;
  };
}

/**
 * Correlated issue from API response
 */
export interface CorrelatedIssue {
  /** Issue UUID */
  id: string;

  /** Issue title */
  title: string;

  /** SHA-256 fingerprint */
  fingerprint: string;

  /** Occurrence count (for recurring issues) */
  occurrenceCount?: number;

  /** Run ID where resolved (for regressions) */
  resolvedRunId?: string;
}

/**
 * Raw API response from POST /v1/runs
 */
export interface ValidationAPIRunResponse {
  data: {
    run: {
      id: string;
      projectId: string;
      runNumber: number;
      workflowType: string;
      timestamp: string;
      allGatesPassed: boolean;
      averageScore: number;
      idempotencyKey?: string;
    };
    validators: ValidatorSnapshot[];
    correlation: {
      new_issues: CorrelatedIssue[];
      recurring_issues: CorrelatedIssue[];
      regressions: CorrelatedIssue[];
    };
    deduplicated: boolean;
  };
}

/**
 * SDK's high-level run submission input
 * Combines execution context with result for submission
 */
export interface RunSubmission {
  /** Project name */
  project: string;

  /** Workflow/definition name */
  workflowType: string;

  /** Execution result to submit */
  result: ExecutionResult;

  /** Optional idempotency key */
  idempotencyKey?: string;

  /** Optional raw markdown output */
  rawMarkdown?: string;
}

/**
 * SDK's high-level response after submission
 * Transformed from ValidationAPIRunResponse
 */
export interface RunSubmissionResponse {
  /** Unique run identifier */
  runId: string;

  /** Run number within project */
  runNumber: number;

  /** Project ID */
  projectId: string;

  /** Dashboard URL for this run */
  dashboardUrl: string;

  /** Whether all validation gates passed */
  allGatesPassed: boolean;

  /** Average score across validators */
  averageScore: number;

  /** New issues found in this run */
  newIssues: CorrelatedIssue[];

  /** Recurring issues seen again */
  recurringIssues: CorrelatedIssue[];

  /** Regressions (previously resolved issues that reappeared) */
  regressions: CorrelatedIssue[];

  /** Whether this was a deduplicated response */
  deduplicated: boolean;
}

/**
 * Recommendation with fingerprint from validation service
 */
export interface FingerprintedRecommendation extends Recommendation {
  /** Stable fingerprint for correlation */
  fingerprint: string;
  
  /** First seen timestamp */
  firstSeen: string;
  
  /** Occurrence count across runs */
  occurrenceCount: number;
  
  /** Status */
  status: 'new' | 'recurring' | 'resolved';
}

/**
 * Regression information
 */
export interface RegressionInfo {
  /** Recommendation that regressed */
  recommendation: FingerprintedRecommendation;
  
  /** Previous run where it was resolved */
  previousRunId: string;
  
  /** How long it was resolved */
  resolvedDuration: string;
}

/**
 * Query options for validation service run history
 */
export interface ValidationQueryOptions {
  /** Filter by project (used as path parameter in getHistory) */
  project?: string;

  /** Filter by workflow type (e.g., 'post-implementation', 'ship') */
  workflowType?: string;

  /** Limit results (1-100) */
  limit?: number;
}

/**
 * Run history entry - matches Validation API Run model
 */
export interface RunHistoryEntry {
  /** Run UUID */
  id: string;

  /** Project UUID */
  projectId: string;

  /** Sequential run number within project */
  runNumber: number;

  /** Workflow type (e.g., 'post-implementation', 'ship') */
  workflowType: string;

  /** Run timestamp */
  timestamp: string;

  /** Whether all validation gates passed */
  allGatesPassed: boolean;

  /** Average score across validators (0-100) */
  averageScore: number;

  /** Raw markdown output (if stored) */
  rawMarkdown?: string;

  /** Archive timestamp (if archived) */
  archivedAt?: string;

  /** Archive reason (if archived) */
  archiveReason?: string;

  /** Idempotency key (if provided) */
  idempotencyKey?: string;

  /** Creation timestamp */
  createdAt: string;

  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Project info from list endpoint
 */
export interface Project {
  /** Project UUID */
  id: string;

  /** Project name */
  name: string;

  /** Creation timestamp */
  createdAt: string;

  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Project summary with statistics
 */
export interface ProjectSummary {
  /** Project info */
  project: Project;

  /** Aggregate statistics */
  stats: {
    /** Total number of runs */
    totalRuns: number;

    /** Total issues ever created */
    totalIssues: number;

    /** Currently open issues */
    openIssues: number;

    /** Critical open issues */
    criticalIssues: number;

    /** Latest run number */
    latestRunNumber: number;

    /** Latest run date */
    latestRunDate: string;
  };
}

/**
 * Single trend data point
 */
export interface TrendEntry {
  /** Date (YYYY-MM-DD) */
  date: string;

  /** Total issues on this date */
  total: number;

  /** Critical issues on this date */
  critical: number;

  /** New issues created on this date */
  new: number;

  /** Issues resolved on this date */
  resolved: number;
}

/**
 * Trend summary statistics
 */
export interface TrendSummary {
  /** Average new issues per day */
  averageNew: number;

  /** Average resolved issues per day */
  averageResolved: number;

  /** Net change over period */
  netChange: number;

  /** Trend direction */
  trendDirection: 'improving' | 'stable' | 'degrading';
}

/**
 * Aggregated metrics for CLI display
 * Returned by UluOpsClient.getMetricsSummary()
 */
export interface MetricsSummary {
  /** Total validation runs for the project */
  totalRuns: number;

  /** Average score across all runs */
  averageScore: number;

  /** Percentage of runs that passed threshold (0-100) */
  passRate: number;

  /** Total tokens consumed */
  totalTokens: number;

  /** Total cost in USD */
  totalCost: number;

  /** Average cost per run in USD */
  avgCostPerRun: number;

  /** Score trend direction */
  scoreTrend: 'improving' | 'stable' | 'degrading';

  /** Score change over period */
  scoreTrendDelta: number;
}

/**
 * Issue search result
 */
export interface IssueSearchResult {
  /** Issue UUID */
  id: string;

  /** Project name */
  projectName: string;

  /** Issue title */
  title: string;

  /** Issue status */
  status: 'open' | 'completed' | 'wontfix' | 'deferred' | 'merged';

  /** Priority */
  priority: 'critical' | 'suggested' | 'backlog';

  /** Validator that created this issue */
  validator: string;

  /** File path (if applicable) */
  filePath?: string;

  /** Search relevance score */
  relevance: number;
}

/**
 * Run diff/comparison result
 */
export interface RunDiffResult {
  /** Base run info */
  baseRun: RunHistoryEntry;

  /** Compare run info */
  compareRun: RunHistoryEntry;

  /** Issues fixed (in base but not compare) */
  fixed: CorrelatedIssue[];

  /** New issues (in compare but not base) */
  new: CorrelatedIssue[];

  /** Unchanged issues (in both) */
  unchanged: CorrelatedIssue[];

  /** Validator score changes */
  validatorChanges: {
    name: string;
    baseScore: number;
    compareScore: number;
    change: number;
  }[];
}

/**
 * Valid analytics metric types
 */
export type AnalyticsMetric =
  | 'validator_performance'
  | 'resolution_rates'
  | 'cross_project_patterns'
  | 'file_hotspots'
  | 'regression_analysis'
  | 'trend_summary'
  | 'cost_analysis'
  | 'taxonomy_distribution';

/**
 * Validator reliability metrics
 */
export interface ValidatorReliability {
  /** Validator name */
  name: string;

  /** Total issues found */
  totalIssues: number;

  /** False positive rate (percentage) */
  falsePositiveRate: number;

  /** Resolution rate (percentage) */
  resolutionRate: number;

  /** Reliability score (0-100) */
  reliabilityScore: number;
}

/**
 * Failure taxonomy schema
 */
export interface TaxonomySchema {
  /** Failure domains */
  failureDomains: {
    code: 'STR' | 'SEM' | 'PRA' | 'EPI';
    name: string;
    description: string;
  }[];

  /** Severity codes */
  severityCodes: {
    code: 'C' | 'H' | 'M' | 'L' | 'I';
    name: string;
    description: string;
  }[];

  /** Failure mode pattern (regex) */
  failureModePattern: string;

  /** Version of this taxonomy */
  version: string;
}
```

---

## Core Classes

### ToolHandler

Fulfills filesystem tool calls from Claude locally.

```typescript
// src/executor/ToolHandler.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import type { Tool, ToolUseBlock, ToolResult } from '../types';

/**
 * Handles filesystem tool calls, fulfilling them against the local target directory
 */
export class ToolHandler {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  /**
   * Get tool definitions for Claude API
   */
  getTools(): Tool[] {
    return [
      {
        name: 'read_file',
        description: 'Read the contents of a file. Returns the full file content.',
        input_schema: {
          type: 'object',
          properties: {
            path: { 
              type: 'string', 
              description: 'File path relative to target directory' 
            }
          },
          required: ['path']
        }
      },
      {
        name: 'list_files',
        description: 'List files in a directory. Supports glob patterns.',
        input_schema: {
          type: 'object',
          properties: {
            path: { 
              type: 'string', 
              description: 'Directory path relative to target' 
            },
            pattern: { 
              type: 'string', 
              description: 'Glob pattern (e.g., "**/*.ts"). Defaults to "*"' 
            }
          },
          required: ['path']
        }
      },
      {
        name: 'search_content',
        description: 'Search for a pattern across files. Returns matching lines with context.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { 
              type: 'string', 
              description: 'Search pattern (supports regex)' 
            },
            file_pattern: { 
              type: 'string', 
              description: 'Glob pattern for files to search (e.g., "**/*.ts")' 
            },
            max_results: { 
              type: 'integer', 
              description: 'Maximum matches to return. Default: 50' 
            }
          },
          required: ['pattern']
        }
      }
    ];
  }

  /**
   * Fulfill a tool call from Claude
   */
  async fulfill(toolUse: ToolUseBlock): Promise<ToolResult> {
    try {
      const relativePath = String(toolUse.input.path || '.');
      const fullPath = path.resolve(this.basePath, relativePath);
      
      if (!this.isPathSafe(fullPath)) {
        return {
          tool_use_id: toolUse.id,
          content: `Error: Path "${relativePath}" is outside the target directory`,
          is_error: true
        };
      }

      switch (toolUse.name) {
        case 'read_file':
          return this.readFile(toolUse.id, fullPath);
          
        case 'list_files':
          return this.listFiles(toolUse.id, fullPath, toolUse.input.pattern as string);
          
        case 'search_content':
          return this.searchContent(toolUse.id, {
            pattern: toolUse.input.pattern as string,
            filePattern: toolUse.input.file_pattern as string,
            maxResults: toolUse.input.max_results as number || 50
          });
          
        default:
          return {
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true
          };
      }
    } catch (error) {
      return {
        tool_use_id: toolUse.id,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
    }
  }

  /**
   * Check if resolved path is within base path (security)
   */
  private isPathSafe(fullPath: string): boolean {
    const resolved = path.resolve(fullPath);
    return resolved.startsWith(this.basePath);
  }

  private async readFile(id: string, filePath: string): Promise<ToolResult> {
    const content = await fs.readFile(filePath, 'utf-8');
    return { tool_use_id: id, content };
  }

  private async listFiles(id: string, dirPath: string, pattern?: string): Promise<ToolResult> {
    const files = await glob(pattern || '*', {
      cwd: dirPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
    });
    return { tool_use_id: id, content: files.join('\n') };
  }

  private async searchContent(
    id: string, 
    opts: { pattern: string; filePattern?: string; maxResults: number }
  ): Promise<ToolResult> {
    const files = await glob(opts.filePattern || '**/*', {
      cwd: this.basePath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**']
    });

    const regex = new RegExp(opts.pattern, 'gi');
    const results: Array<{ file: string; line: number; content: string }> = [];

    for (const file of files) {
      if (results.length >= opts.maxResults) break;
      
      try {
        const content = await fs.readFile(path.join(this.basePath, file), 'utf-8');
        const lines = content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({ file, line: i + 1, content: lines[i].trim() });
            if (results.length >= opts.maxResults) break;
          }
          regex.lastIndex = 0; // Reset regex state
        }
      } catch {
        // Skip files that can't be read (binary, etc.)
      }
    }

    return {
      tool_use_id: id,
      content: JSON.stringify(results, null, 2)
    };
  }
}
```

### AIProvider

**Replaces ClaudeAdapter (v0.9.0).** AI SDK-based provider for LLM interactions. Leverages Vercel AI SDK v6 for automatic tool loop management and built-in retry logic. Currently Anthropic-only; additional providers can be added in future versions.

> **Design Note (v0.9.0):** AIProvider replaces ClaudeAdapter, eliminating ~380 lines of custom retry/error/tool-loop code in favor of AI SDK's battle-tested implementation. The tool loop is now handled by AI SDK's `maxSteps` parameter, removing the need for manual iteration in AgentExecutor.

```typescript
// src/ai/AIProvider.ts

import { generateText, CoreTool, APICallError, RetryError } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type {
  ResolvedConfig,
  UsageMetrics,
} from '../types';
import {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
  TimeoutError,
} from '@uluops/sdk-core/errors';

/**
 * Model alias to provider-specific model ID
 */
export type ModelAlias = 'haiku' | 'sonnet' | 'opus';

/**
 * Result from AI provider generation
 */
export interface GenerateResult {
  /** Final text content after tool loop completion */
  text: string;

  /** Total usage across all steps */
  usage: UsageMetrics;

  /** Number of tool calls made */
  toolCallCount: number;

  /** Resolved model ID that was used */
  model: string;

  /** Number of steps (LLM calls) in the tool loop */
  steps: number;
}

/**
 * Options for generation
 */
export interface GenerateOptions {
  /** Model alias or full model ID */
  model: ModelAlias | string;

  /** System prompt */
  system: string;

  /** Initial user message */
  prompt: string;

  /** Available tools */
  tools: Record<string, CoreTool>;

  /** Maximum response tokens per step */
  maxTokens?: number;

  /** Maximum tool loop iterations */
  maxSteps?: number;

  /** Timeout in milliseconds */
  timeoutMs?: number;

  /** Temperature (0-1) */
  temperature?: number;
}

/**
 * AI SDK-based provider for LLM interactions
 *
 * AIProvider wraps Vercel AI SDK to provide:
 * - Model alias resolution (sonnet → claude-sonnet-4-5-20250929)
 * - Unified generation interface with automatic tool loops
 * - Error mapping to UluOps error types
 * - Usage metrics in UluOps format
 *
 * Replaces ClaudeAdapter with significantly less code by leveraging
 * AI SDK's built-in retry logic, tool loop management, and provider abstractions.
 *
 * @example
 * ```typescript
 * const provider = new AIProvider(config);
 *
 * const result = await provider.generate({
 *   model: 'sonnet',
 *   system: renderedPrompt,
 *   prompt: 'Analyze this codebase',
 *   tools: toolAdapter.getTools(),
 *   maxSteps: 50,
 * });
 *
 * console.log(result.text);          // Final response
 * console.log(result.toolCallCount); // Total tool calls
 * ```
 */
export class AIProvider {
  /** Model alias to full Anthropic model ID */
  private static readonly MODEL_MAP: Record<ModelAlias, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-5-20250929',
    opus: 'claude-opus-4-6',
  };

  constructor(private config: ResolvedConfig) {}

  /**
   * Generate text with automatic tool loop handling
   *
   * Uses AI SDK's `generateText` with `maxSteps` to handle the complete
   * tool loop automatically. No manual iteration required.
   *
   * @param options - Generation options
   * @returns Generation result with text, usage, and metrics
   * @throws {RateLimitError} If rate limited after retries
   * @throws {UnauthorizedError} If API key is invalid
   * @throws {SdkApiError} For other API errors
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const resolvedModel = this.resolveModel(options.model);

    try {
      const result = await generateText({
        model: this.getModel(resolvedModel),
        system: options.system,
        prompt: options.prompt,
        tools: options.tools,
        maxTokens: options.maxTokens ?? 8192,
        maxSteps: options.maxSteps ?? 50,
        temperature: options.temperature ?? 0,
        abortSignal: options.timeoutMs
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
      });

      // Count tool calls across all steps
      const toolCallCount = result.steps.reduce(
        (sum, step) => sum + (step.toolCalls?.length ?? 0),
        0
      );

      return {
        text: result.text,
        usage: this.mapUsage(result.usage, result.providerMetadata),
        toolCallCount,
        model: resolvedModel,
        steps: result.steps.length,
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * Resolve model alias to full model ID
   */
  resolveModel(alias: ModelAlias | string): string {
    return AIProvider.MODEL_MAP[alias as ModelAlias] ?? alias;
  }

  /**
   * Get AI SDK model instance for the resolved model ID
   * @internal
   */
  private getModel(modelId: string) {
    // Currently only Anthropic; future: switch on providerType
    return anthropic(modelId, {
      apiKey: this.config.apiKey,
    });
  }

  /**
   * Convert AI SDK usage to UluOps format
   * @internal
   */
  private mapUsage(
    usage: { promptTokens: number; completionTokens: number },
    providerMetadata?: unknown
  ): UsageMetrics {
    const base = {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
    };

    // Extract Anthropic-specific cache metrics
    const meta = providerMetadata as {
      anthropic?: {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    } | undefined;

    if (meta?.anthropic) {
      return {
        ...base,
        cache_creation_input_tokens: meta.anthropic.cacheCreationInputTokens,
        cache_read_input_tokens: meta.anthropic.cacheReadInputTokens,
      };
    }

    return base;
  }

  /**
   * Map AI SDK errors to sdk-core error types
   *
   * Uses @uluops/sdk-core error hierarchy for consistency across the SDK.
   * @internal
   */
  private mapError(error: unknown): SdkApiError {
    if (error instanceof APICallError) {
      const status = error.statusCode ?? 0;

      if (status === 429) {
        return new RateLimitError(`Rate limit exceeded: ${error.message}`, status);
      }

      if (status === 401) {
        return new UnauthorizedError(`Authentication failed: ${error.message}`, status);
      }

      if (status === 403) {
        return new ForbiddenError(`Forbidden: ${error.message}`, status);
      }

      if (status >= 500) {
        return new ServiceUnavailableError(`Server error: ${error.message}`, status);
      }

      return new SdkApiError(error.message, status);
    }

    if (error instanceof RetryError) {
      return new SdkApiError(`Retries exhausted: ${error.message}`, 0);
    }

    // Timeout errors
    if (error instanceof Error && error.name === 'AbortError') {
      return new TimeoutError('Request timeout exceeded');
    }

    return new SdkApiError(
      error instanceof Error ? error.message : String(error),
      0
    );
  }

  /**
   * Parse retry-after header from API error
   * @internal
   */
  private parseRetryAfter(error: { headers?: Record<string, string> }): number | undefined {
    const retryAfter = error.headers?.['retry-after'];
    if (retryAfter) {
      const value = parseInt(retryAfter, 10);
      return isNaN(value) ? undefined : value;
    }
    return undefined;
  }
}
```

### ToolAdapter

Converts UluOps `ToolHandler` tools to AI SDK v6 tool format using Zod schemas.

```typescript
// src/ai/ToolAdapter.ts

import { tool, CoreTool } from 'ai';
import { z } from 'zod';
import type { ToolHandler } from '../executor/ToolHandler';

/**
 * Converts UluOps ToolHandler to AI SDK tool format
 *
 * AI SDK v6 uses Zod schemas for input validation and type inference.
 * This adapter bridges the gap between ToolHandler's JSON Schema format
 * and AI SDK's Zod-based tool definitions.
 *
 * @example
 * ```typescript
 * const toolHandler = new ToolHandler(targetDir);
 * const toolAdapter = new ToolAdapter(toolHandler);
 * const tools = toolAdapter.getTools();
 * // Pass tools to AIProvider.generate()
 * ```
 */
export class ToolAdapter {
  constructor(private toolHandler: ToolHandler) {}

  /**
   * Get AI SDK compatible tools from ToolHandler
   */
  getTools(): Record<string, CoreTool> {
    return {
      read_file: tool({
        description: 'Read the contents of a file. Returns the full file content.',
        parameters: z.object({
          path: z.string().describe('File path relative to target directory'),
        }),
        execute: async ({ path }) => {
          const result = await this.toolHandler.fulfill({
            type: 'tool_use',
            id: crypto.randomUUID(),
            name: 'read_file',
            input: { path },
          });
          if (result.is_error) {
            throw new Error(result.content);
          }
          return result.content;
        },
      }),

      list_files: tool({
        description: 'List files in a directory. Supports glob patterns.',
        parameters: z.object({
          path: z.string().describe('Directory path relative to target'),
          pattern: z.string().optional().describe('Glob pattern (e.g., "**/*.ts")'),
        }),
        execute: async ({ path, pattern }) => {
          const result = await this.toolHandler.fulfill({
            type: 'tool_use',
            id: crypto.randomUUID(),
            name: 'list_files',
            input: { path, pattern },
          });
          if (result.is_error) {
            throw new Error(result.content);
          }
          return result.content;
        },
      }),

      search_content: tool({
        description: 'Search for a pattern across files. Returns matching lines.',
        parameters: z.object({
          pattern: z.string().describe('Search pattern (supports regex)'),
          file_pattern: z.string().optional().describe('Glob pattern for files'),
          max_results: z.number().optional().describe('Max matches (default: 50)'),
        }),
        execute: async ({ pattern, file_pattern, max_results }) => {
          const result = await this.toolHandler.fulfill({
            type: 'tool_use',
            id: crypto.randomUUID(),
            name: 'search_content',
            input: { pattern, file_pattern, max_results },
          });
          if (result.is_error) {
            throw new Error(result.content);
          }
          return result.content;
        },
      }),
    };
  }
}
```

### AgentExecutor

**Updated in v0.9.0.** Primary executor for single-agent runs. Handles prompt rendering, output parsing, and metrics. The tool loop is now delegated to AI SDK's `maxSteps` parameter via `AIProvider.generate()`, replacing ~90 lines of manual iteration code.

```typescript
// src/executor/AgentExecutor.ts

import { AIProvider, GenerateResult } from '../ai/AIProvider';
import { ToolHandler } from './ToolHandler';
import { ToolAdapter } from '../ai/ToolAdapter';
import { OutputExtractor } from '../parser/OutputExtractor';
import { RegistryClient } from '../registry/RegistryClient';
import type {
  ResolvedConfig,
  ResolvedDefinition,
  ExecutionInput,
  ExecutionOptions,
  ResolvedExecutionContext,
  AgentResult,
  ValidatorAgentResult,
  ExecutorAgentResult,
  Recommendation,
  ValidatorRuntime,
  ExecutorRuntime,
} from '../types';
import { ExecutionError } from '../errors';

/**
 * Primary executor for single-agent runs
 *
 * AgentExecutor orchestrates:
 * 1. Prompt rendering from agent definition
 * 2. Tool setup and adaptation for AI SDK
 * 3. LLM generation via AIProvider (tool loop handled by AI SDK)
 * 4. Output parsing and result construction
 *
 * The tool loop is delegated entirely to AI SDK's `maxSteps` parameter,
 * eliminating ~90 lines of manual iteration code.
 *
 * Used directly by `UluOpsClient.runAgent()` and delegated to by
 * `CommandExecutor` for single-agent commands.
 *
 * @example
 * ```typescript
 * const executor = new AgentExecutor(config, aiProvider, registry);
 *
 * // Direct agent execution with call-time options
 * const result = await executor.execute(
 *   resolvedAgent,
 *   { target: './src' },
 *   { model: 'opus', thresholds: { pass: 80 } }
 * );
 *
 * if (result.agentType === 'validator') {
 *   console.log(`Score: ${result.score}/${result.maxScore}`);
 * }
 * ```
 */
export class AgentExecutor {
  private outputExtractor = new OutputExtractor();

  constructor(
    private config: ResolvedConfig,
    private aiProvider: AIProvider,
    private registry: RegistryClient,
  ) {}

  /**
   * Execute an agent with optional runtime options
   *
   * @param resolved - Resolved agent definition from registry
   * @param input - Execution input (target path, options)
   * @param options - Optional runtime configuration (overrides agent defaults)
   * @returns Agent result (discriminated by agentType)
   */
  async execute(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    options?: ExecutionOptions
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const agentType = resolved.agentType || 'validator';

    // 1. Merge options with agent defaults
    const context = this.resolveContext(resolved, options);

    // 2. Setup tool handler and AI SDK tool adapter
    const toolHandler = new ToolHandler(input.target);
    const toolAdapter = new ToolAdapter(toolHandler);

    // 3. Render the agent prompt
    const runtime = resolved.runtime as ValidatorRuntime | ExecutorRuntime;
    const systemPrompt = runtime.prompt;

    // 4. Build initial context message
    const initialMessage = await this.buildInitialMessage(input, toolHandler);

    // 5. Execute via AI SDK (tool loop handled automatically by maxSteps)
    let result: GenerateResult;
    try {
      result = await this.aiProvider.generate({
        model: context.model,
        system: systemPrompt,
        prompt: initialMessage,
        tools: toolAdapter.getTools(),
        maxTokens: context.maxTokens,
        maxSteps: 50,
        timeoutMs: context.timeoutMs,
        temperature: 0,
      });
    } catch (error) {
      // AIProvider already maps errors to our error types
      throw error;
    }

    // 6. Parse structured output
    const parsed = this.outputExtractor.extract(result.text, agentType);

    // 7. Build recommendations
    const recommendations = this.flattenRecommendations(parsed, resolved.name);

    // 8. Compute metrics
    const durationMs = Date.now() - startTime;
    const metrics = {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheCreationTokens: result.usage.cache_creation_input_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens,
      totalEffectiveTokens: this.calculateEffectiveTokens(result.usage),
      durationMs,
      model: context.model,
      costUsd: this.calculateCost(result.usage, context.model),
      toolCalls: result.toolCallCount,
    };

    // 9. Return discriminated result
    if (agentType === 'validator') {
      return {
        type: 'agent',
        agentType: 'validator',
        name: resolved.name,
        version: resolved.version,
        definitionHash: resolved.hash,
        decision: parsed.decision as 'PASS' | 'WARN' | 'FAIL',
        score: parsed.score!,
        maxScore: parsed.maxScore || 100,
        threshold: context.thresholds?.pass,
        categories: parsed.categories,
        recommendations,
        durationMs,
        metrics,
      } as ValidatorAgentResult;
    } else {
      return {
        type: 'agent',
        agentType: 'executor',
        name: resolved.name,
        version: resolved.version,
        definitionHash: resolved.hash,
        decision: parsed.decision as 'COMPLETE' | 'PARTIAL' | 'FAILED',
        artifacts: parsed.artifacts,
        recommendations,
        durationMs,
        metrics,
      } as ExecutorAgentResult;
    }
  }

  /**
   * Merge agent defaults with runtime options
   */
  private resolveContext(
    resolved: ResolvedDefinition,
    options?: ExecutionOptions
  ): ResolvedExecutionContext {
    const runtime = resolved.runtime as ValidatorRuntime | ExecutorRuntime;
    const defaults = runtime?.defaults || {};

    return {
      model: options?.model || defaults.model || this.config.modelOverride || 'sonnet',
      maxTokens: options?.maxTokens || defaults.maxTokens || 8192,
      timeoutMs: options?.timeoutMs || defaults.timeout || this.config.timeout || 300000,
      thresholds: options?.thresholds || defaults.thresholds,
      trackResults: options?.trackResults ?? this.config.trackingEnabled,
      project: options?.project || this.config.defaultProject,
    };
  }

  private async buildInitialMessage(input: ExecutionInput, toolHandler: ToolHandler): Promise<string> {
    const stats = await this.scanProjectStructure(input.target, toolHandler);

    return `
Analyze the following project:

Target: ${input.target}

Project Structure:
${stats.tree}

Statistics:
- Files: ${stats.fileCount}
- Languages: ${stats.languages.join(', ')}

Options: ${JSON.stringify(input.options || {})}

Use the provided tools to read files and analyze the codebase.
Produce your assessment in the required JSON output format.
    `.trim();
  }

  private async scanProjectStructure(target: string, toolHandler: ToolHandler): Promise<{
    tree: string;
    fileCount: number;
    languages: string[];
  }> {
    const files = await toolHandler.fulfill({
      type: 'tool_use',
      id: 'init',
      name: 'list_files',
      input: { path: '.', pattern: '**/*' }
    });

    const fileList = files.content.split('\n').filter(Boolean);
    const languages = this.detectLanguages(fileList);
    const tree = this.buildTreePreview(fileList, 20);

    return { tree, fileCount: fileList.length, languages };
  }

  private detectLanguages(files: string[]): string[] {
    const langMap: Record<string, string> = {
      '.ts': 'TypeScript', '.tsx': 'TypeScript/React',
      '.js': 'JavaScript', '.jsx': 'JavaScript/React',
      '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
    };

    const detected = new Set<string>();
    for (const file of files) {
      const ext = file.substring(file.lastIndexOf('.'));
      if (langMap[ext]) detected.add(langMap[ext]);
    }

    return Array.from(detected);
  }

  private buildTreePreview(files: string[], maxFiles: number): string {
    const preview = files.slice(0, maxFiles);
    const remaining = files.length - maxFiles;

    let tree = preview.map(f => `  ${f}`).join('\n');
    if (remaining > 0) tree += `\n  ... and ${remaining} more files`;

    return tree;
  }

  private flattenRecommendations(parsed: any, agentName: string): Recommendation[] {
    const recommendations: Recommendation[] = [];

    for (const category of parsed.categories || []) {
      for (const finding of category.findings || []) {
        for (const issue of finding.issues || []) {
          recommendations.push({
            validator: agentName,
            title: issue.title,
            priority: issue.priority,
            severity: issue.severity,
            failureCode: issue.failureCode,
            filePath: issue.filePath,
            lineNumber: issue.lineNumber,
            description: issue.description,
          });
        }
      }
    }

    return recommendations;
  }

  private calculateEffectiveTokens(usage: any): number {
    return usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0);
  }

  private calculateCost(usage: any, model: string): number {
    const pricing: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
      'sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
      'haiku': { input: 0.80, output: 4, cacheWrite: 1, cacheRead: 0.08 },
      'opus': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
    };

    const p = pricing[model] || pricing['sonnet'];

    return (
      (usage.input_tokens * p.input) +
      (usage.output_tokens * p.output) +
      ((usage.cache_creation_input_tokens || 0) * p.cacheWrite) +
      ((usage.cache_read_input_tokens || 0) * p.cacheRead)
    ) / 1_000_000;
  }
}
```

### OutputExtractor

Parses and extracts structured data from Claude's final text response. Supports JSON code fences, inline JSON objects, and structured text patterns.

```typescript
// src/parser/OutputExtractor.ts

import type {
  ParsedOutput,
  ParsedCategory,
  ParsedFinding,
  ExtractionOptions,
  ExtractionResult
} from '../types/parser';
import type { AgentType } from '../types/execution';
import type { Issue, ArtifactResult } from '../types/command';
import { ParseError } from '../errors/ParseError';

/**
 * Extracts structured output from Claude responses
 *
 * Supports multiple extraction strategies:
 * 1. JSON code fence (```json ... ```) - highest confidence
 * 2. Inline JSON object detection - medium confidence
 * 3. Structured text parsing (score: X, decision: Y) - fallback
 *
 * @example
 * ```typescript
 * const extractor = new OutputExtractor();
 *
 * // Extract from validator response
 * const result = extractor.extract(claudeResponse, 'validator');
 * console.log(result.decision); // 'PASS' | 'WARN' | 'FAIL'
 * console.log(result.score);    // 85
 * console.log(result.categories); // CategoryResult[]
 *
 * // Extract with metadata
 * const { output, method, confidence } = extractor.extractWithMetadata(
 *   claudeResponse,
 *   'validator'
 * );
 * ```
 */
export class OutputExtractor {
  /** JSON code fence pattern */
  private static readonly JSON_FENCE_PATTERN = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

  /** Inline JSON object pattern (starts with { and ends with }) */
  private static readonly INLINE_JSON_PATTERN = /\{[\s\S]*?"decision"[\s\S]*?\}/;

  /** Structured text patterns */
  private static readonly STRUCTURED_PATTERNS = {
    decision: /(?:decision|status|result)\s*[:=]\s*["']?(\w+)["']?/i,
    score: /(?:score|points)\s*[:=]\s*(\d+(?:\.\d+)?)/i,
    maxScore: /(?:max(?:imum)?[\s_]?score|out[\s_]?of|total)\s*[:=]\s*(\d+)/i,
  };

  /**
   * Extract structured output from Claude response text
   *
   * @param content - Raw text content from Claude's final response
   * @param agentType - Type of agent ('validator' or 'executor')
   * @param options - Extraction options
   * @returns Parsed output structure
   * @throws {ParseError} If strict mode enabled and extraction fails
   */
  extract(
    content: string,
    agentType: AgentType,
    options: ExtractionOptions = {}
  ): ParsedOutput {
    const result = this.extractWithMetadata(content, agentType, options);
    return result.output;
  }

  /**
   * Extract with full metadata about extraction method and confidence
   *
   * @param content - Raw text content from Claude's final response
   * @param agentType - Type of agent ('validator' or 'executor')
   * @param options - Extraction options
   * @returns Extraction result with output, method, and confidence
   */
  extractWithMetadata(
    content: string,
    agentType: AgentType,
    options: ExtractionOptions = {}
  ): ExtractionResult {
    const warnings: string[] = [];

    // Strategy 1: Try JSON code fence (highest confidence)
    const fenceResult = this.extractFromCodeFence(content, options);
    if (fenceResult) {
      return {
        output: this.normalizeOutput(fenceResult, agentType),
        method: 'json_code_fence',
        confidence: 0.95,
        warnings,
      };
    }

    // Strategy 2: Try inline JSON detection
    const inlineResult = this.extractInlineJson(content);
    if (inlineResult) {
      warnings.push('Extracted from inline JSON - consider using code fence for reliability');
      return {
        output: this.normalizeOutput(inlineResult, agentType),
        method: 'inline_json',
        confidence: 0.75,
        warnings,
      };
    }

    // Strategy 3: Fall back to structured text parsing
    const textResult = this.extractFromStructuredText(content, agentType);
    if (textResult) {
      warnings.push('Extracted from structured text patterns - JSON output recommended');
      return {
        output: textResult,
        method: 'structured_text',
        confidence: 0.5,
        warnings,
      };
    }

    // Extraction failed
    if (options.strict) {
      throw new ParseError(
        'Failed to extract structured output from response',
        content.substring(0, 500)
      );
    }

    // Return empty result with error indication
    return {
      output: {
        decision: 'ERROR',
        score: 0,
      },
      method: 'structured_text',
      confidence: 0,
      warnings: ['Could not extract structured output from response'],
    };
  }

  /**
   * Extract JSON from code fence
   * @internal
   */
  private extractFromCodeFence(
    content: string,
    options: ExtractionOptions
  ): unknown | null {
    const lang = options.codeFenceLanguage || 'json';
    const pattern = new RegExp(`\`\`\`(?:${lang})?\\s*\\n([\\s\\S]*?)\\n\`\`\``, 'g');

    const matches = [...content.matchAll(pattern)];
    if (matches.length === 0) return null;

    // Use last JSON fence (final output)
    const lastMatch = matches[matches.length - 1];
    try {
      return JSON.parse(lastMatch[1].trim());
    } catch {
      return null;
    }
  }

  /**
   * Extract inline JSON object
   * @internal
   */
  private extractInlineJson(content: string): unknown | null {
    const match = content.match(OutputExtractor.INLINE_JSON_PATTERN);
    if (!match) return null;

    // Find the complete JSON object by matching braces
    const startIndex = content.indexOf(match[0]);
    const jsonStr = this.extractBalancedJson(content, startIndex);

    if (!jsonStr) return null;

    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * Extract balanced JSON object starting at index
   * @internal
   */
  private extractBalancedJson(content: string, startIndex: number): string | null {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < content.length; i++) {
      const char = content[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          return content.substring(startIndex, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Extract from structured text patterns (fallback)
   * @internal
   */
  private extractFromStructuredText(
    content: string,
    agentType: AgentType
  ): ParsedOutput | null {
    const patterns = OutputExtractor.STRUCTURED_PATTERNS;

    const decisionMatch = content.match(patterns.decision);
    const scoreMatch = content.match(patterns.score);

    if (!decisionMatch && !scoreMatch) {
      return null;
    }

    const output: ParsedOutput = {
      decision: decisionMatch
        ? this.normalizeDecision(decisionMatch[1], agentType)
        : 'UNKNOWN',
    };

    if (scoreMatch) {
      output.score = parseFloat(scoreMatch[1]);
    }

    if (agentType === 'validator') {
      const maxScoreMatch = content.match(patterns.maxScore);
      if (maxScoreMatch) {
        output.maxScore = parseInt(maxScoreMatch[1], 10);
      }
    }

    return output;
  }

  /**
   * Normalize raw JSON to ParsedOutput structure
   * @internal
   */
  private normalizeOutput(raw: unknown, agentType: AgentType): ParsedOutput {
    if (!raw || typeof raw !== 'object') {
      return { decision: 'ERROR' };
    }

    const obj = raw as Record<string, unknown>;
    const output: ParsedOutput = {
      decision: this.normalizeDecision(String(obj.decision || 'UNKNOWN'), agentType),
      rawJson: raw,
    };

    // Extract score
    if (typeof obj.score === 'number') {
      output.score = obj.score;
    } else if (typeof obj.score === 'string') {
      output.score = parseFloat(obj.score);
    }

    // Validator-specific fields
    if (agentType === 'validator') {
      if (typeof obj.maxScore === 'number' || typeof obj.max_score === 'number') {
        output.maxScore = (obj.maxScore ?? obj.max_score) as number;
      }

      if (Array.isArray(obj.categories)) {
        output.categories = this.parseCategories(obj.categories);
      }
    }

    // Executor-specific fields
    if (agentType === 'executor') {
      if (Array.isArray(obj.artifacts)) {
        output.artifacts = this.parseArtifacts(obj.artifacts);
      }
    }

    return output;
  }

  /**
   * Normalize decision string to standard format
   * @internal
   */
  private normalizeDecision(decision: string, agentType: AgentType): string {
    const upper = decision.toUpperCase().trim();

    if (agentType === 'validator') {
      // Map common variations
      if (['PASS', 'PASSED', 'OK', 'SUCCESS'].includes(upper)) return 'PASS';
      if (['WARN', 'WARNING', 'CAUTION'].includes(upper)) return 'WARN';
      if (['FAIL', 'FAILED', 'ERROR', 'REJECT'].includes(upper)) return 'FAIL';
    }

    if (agentType === 'executor') {
      if (['SUCCESS', 'COMPLETE', 'DONE', 'PASS'].includes(upper)) return 'COMPLETE';
      if (['PARTIAL', 'INCOMPLETE'].includes(upper)) return 'PARTIAL';
      if (['FAIL', 'FAILED', 'ERROR'].includes(upper)) return 'FAILED';
    }

    return upper;
  }

  /**
   * Parse categories array from raw JSON
   * @internal
   */
  private parseCategories(raw: unknown[]): ParsedCategory[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null
      )
      .map(item => ({
        name: String(item.name || item.category || 'Unknown'),
        score: Number(item.score ?? item.points ?? 0),
        maxPoints: Number(item.maxPoints ?? item.max_points ?? item.total ?? 100),
        findings: this.parseFindings(
          Array.isArray(item.findings) ? item.findings : []
        ),
      }));
  }

  /**
   * Parse findings array from raw JSON
   * @internal
   */
  private parseFindings(raw: unknown[]): ParsedFinding[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null
      )
      .map(item => ({
        criterion: String(item.criterion || item.name || 'Unknown'),
        pointsEarned: Number(item.pointsEarned ?? item.points_earned ?? item.score ?? 0),
        pointsPossible: Number(item.pointsPossible ?? item.points_possible ?? item.maxPoints ?? 0),
        issues: this.parseIssues(
          Array.isArray(item.issues) ? item.issues : []
        ),
      }));
  }

  /**
   * Parse issues array from raw JSON
   * @internal
   */
  private parseIssues(raw: unknown[]): Issue[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null
      )
      .map(item => ({
        title: String(item.title || 'Untitled Issue'),
        priority: this.normalizePriority(item.priority),
        severity: this.normalizeSeverity(item.severity),
        failureCode: item.failureCode as string | undefined,
        filePath: (item.filePath as string | undefined) ?? (item.file_path as string | undefined),
        lineNumber: typeof item.lineNumber === 'number'
          ? item.lineNumber
          : typeof item.line_number === 'number'
            ? item.line_number
            : undefined,
        description: String(item.description || ''),
      }));
  }

  /**
   * Parse artifacts array from raw JSON
   * @internal
   */
  private parseArtifacts(raw: unknown[]): ArtifactResult[] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null
      )
      .map(item => ({
        name: String(item.name || 'Untitled'),
        path: String(item.path || ''),
        size: typeof item.size === 'number' ? item.size : undefined,
        contentType: (item.contentType as string | undefined) ?? (item.content_type as string | undefined),
      }));
  }

  /**
   * Normalize priority value
   * @internal
   */
  private normalizePriority(value: unknown): 'critical' | 'suggested' | 'backlog' {
    const str = String(value || 'suggested').toLowerCase();
    if (['critical', 'high', 'p0'].includes(str)) return 'critical';
    if (['backlog', 'low', 'p2'].includes(str)) return 'backlog';
    return 'suggested';
  }

  /**
   * Normalize severity value
   * @internal
   */
  private normalizeSeverity(value: unknown): 'critical' | 'high' | 'medium' | 'low' | 'info' {
    const str = String(value || 'medium').toLowerCase();
    if (str === 'critical') return 'critical';
    if (str === 'high') return 'high';
    if (str === 'low') return 'low';
    if (['info', 'informational', 'note'].includes(str)) return 'info';
    return 'medium';
  }
}
```

### RegistryClient

Definition resolver with local development fallback and hash verification.

Uses `@uluops/registry-sdk` for remote API access (definition fetching, rendering)
and handles local file resolution directly.

```typescript
// src/registry/RegistryClient.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { RegistryClient as RegistrySdk } from '@uluops/registry-sdk';
import type {
  ResolvedConfig,
  DefinitionType,
  ResolvedDefinition,
  DefinitionSummary,
  AgentDefinition,
  CommandDefinition,
} from '../types';
import { HashVerificationError } from '../errors';

/**
 * Definition resolver with local development fallback and hash verification.
 *
 * Delegates remote API calls to @uluops/registry-sdk (which handles retry,
 * rate limiting, error mapping, auth). Local file resolution and hash
 * verification are handled in this class directly.
 */
export class RegistryClient {
  private cache = new Map<string, ResolvedDefinition>();
  private sdk: RegistrySdk;

  constructor(private config: ResolvedConfig) {
    this.sdk = new RegistrySdk({
      apiKey: config.apiKey,
      baseUrl: config.registryUrl,
      timeout: config.timeout,
    });
  }

  /**
   * Resolve a definition by name and optional type
   * Priority: local files → cache → remote API
   *
   * @param name - Definition name (e.g., "code-validator", "validate")
   * @param version - Optional version (defaults to "latest")
   * @param type - Optional type hint. If not provided, searches registry to determine type.
   * @returns Resolved definition with runtime prompt and metadata
   * @throws {NotFoundError} If definition not found or multiple matches without type hint
   */
  async resolve(
    name: string,
    version?: string,
    type?: DefinitionType
  ): Promise<ResolvedDefinition> {
    const cacheKey = `${type || 'any'}:${name}@${version || 'latest'}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Try local resolution if configured
    if (this.config.localDefinitions) {
      const local = await this.resolveLocal(name, type);
      if (local) {
        this.cache.set(cacheKey, local);
        return local;
      }
    }

    // Fall back to remote
    const remote = await this.resolveRemote(name, version, type);
    this.cache.set(cacheKey, remote);
    return remote;
  }

  /**
   * Resolve from local filesystem
   * @param name - Definition name
   * @param type - Optional type filter (only search for this type)
   */
  private async resolveLocal(
    name: string,
    type?: DefinitionType
  ): Promise<ResolvedDefinition | null> {
    const baseDir = this.config.localDefinitions!;

    // Build candidates list - filter by type if provided
    const allCandidates = [
      { path: path.join(baseDir, `${name}.agent.yaml`), type: 'agent' as DefinitionType },
      { path: path.join(baseDir, `${name}.command.yaml`), type: 'command' as DefinitionType },
      { path: path.join(baseDir, `${name}.workflow.yaml`), type: 'workflow' as DefinitionType },
      { path: path.join(baseDir, `${name}.pipeline.yaml`), type: 'pipeline' as DefinitionType },
      // Also check subdirectories
      { path: path.join(baseDir, 'agents', `${name}.agent.yaml`), type: 'agent' as DefinitionType },
      { path: path.join(baseDir, 'commands', `${name}.command.yaml`), type: 'command' as DefinitionType },
      { path: path.join(baseDir, 'workflows', `${name}.workflow.yaml`), type: 'workflow' as DefinitionType },
      { path: path.join(baseDir, 'pipelines', `${name}.pipeline.yaml`), type: 'pipeline' as DefinitionType },
    ];

    // Filter by type if specified
    const candidates = type
      ? allCandidates.filter(c => c.type === type)
      : allCandidates;

    for (const candidate of candidates) {
      try {
        const yamlContent = await fs.readFile(candidate.path, 'utf-8');
        const definition = yaml.parse(yamlContent);
        const hash = this.computeHash(yamlContent);

        return {
          type: candidate.type,
          name,
          version: this.extractVersion(definition, candidate.type),
          hash,
          yaml: yamlContent,
          definition,
          runtime: await this.renderLocally(definition, candidate.type),
          domain: this.extractDomain(definition, candidate.type),
          agentType: this.extractAgentType(definition, candidate.type),
        };
      } catch {
        // File doesn't exist, try next
      }
    }

    return null;
  }

  /**
   * Resolve from remote API via @uluops/registry-sdk
   * @param name - Definition name
   * @param version - Optional version (defaults to latest)
   * @param type - Definition type (required for registry SDK)
   */
  private async resolveRemote(
    name: string,
    version?: string,
    type?: DefinitionType
  ): Promise<ResolvedDefinition> {
    let resolvedType = type;

    // If type not provided, search registry to find it
    if (!resolvedType) {
      const searchResult = await this.sdk.definitions.list({
        search: name,
        limit: 10,
        status: 'published',
      });

      const matches = searchResult.items.filter(d => d.name === name);

      if (matches.length === 0) {
        throw new Error(`Definition "${name}" not found in registry`);
      }

      if (matches.length > 1) {
        const types = matches.map(d => d.type).join(', ');
        throw new Error(
          `Multiple definitions named "${name}" found (${types}). ` +
          `Specify type explicitly: resolve("${name}", version, "command")`
        );
      }

      resolvedType = matches[0].type as DefinitionType;
    }

    // Fetch definition with YAML and runtime via registry SDK
    const def = await this.sdk.definitions.get(resolvedType, name, version, {
      includeYaml: true,
      includeRuntime: true,
    });

    // Get rendered markdown
    const rendered = await this.sdk.render.get(resolvedType, name, def.version);

    // Verify hash if enabled
    if (this.config.hashVerificationEnabled && def.yaml && def.hash) {
      this.verifyHash(def.yaml, def.hash);
    }

    return {
      type: resolvedType,
      name: def.name,
      version: def.version,
      hash: def.hash,
      yaml: def.yaml ?? '',
      definition: def.yaml ? yaml.parse(def.yaml) : ({} as any),
      runtime: rendered as any,
      domain: def.domain as any,
      agentType: def.agentType as any,
    };
  }

  /**
   * Compute SHA-256 hash of YAML content
   */
  private computeHash(yamlContent: string): string {
    const normalized = this.normalizeYaml(yamlContent);
    return 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Normalize YAML for consistent hashing
   */
  private normalizeYaml(yamlContent: string): string {
    // Parse and re-stringify for consistent formatting
    const parsed = yaml.parse(yamlContent);
    return yaml.stringify(parsed, { sortMapEntries: true });
  }

  /**
   * Verify definition hash
   */
  private verifyHash(yamlContent: string, expectedHash: string): void {
    const actualHash = this.computeHash(yamlContent);
    if (actualHash !== expectedHash) {
      throw new HashVerificationError(
        `Hash mismatch: expected ${expectedHash}, got ${actualHash}`
      );
    }
  }

  /**
   * Render definition locally (for local dev)
   */
  private async renderLocally(
    definition: any, 
    type: DefinitionType
  ): Promise<string | Record<string, unknown>> {
    // Simplified local rendering - production uses registry API
    switch (type) {
      case 'agent':
        return this.renderAgentPrompt(definition);
      case 'command':
        return this.renderCommandPrompt(definition);
      case 'workflow':
        return definition; // Workflows return config, not prompt
      case 'pipeline':
        return definition; // Pipelines return config, not prompt
      default:
        return '';
    }
  }

  private renderAgentPrompt(def: AgentDefinition): string {
    const agent = def.agent;
    return `You are ${agent.behavior.role}

Your expertise includes: ${agent.behavior.expertise.join(', ')}

${agent.behavior.methodology || ''}

${agent.behavior.categories ? `Evaluate the following categories:
${agent.behavior.categories.map(c => `- ${c.name} (weight: ${c.weight}): ${c.criteria.join(', ')}`).join('\n')}` : ''}

Provide your assessment in ${agent.output.format} format.`;
  }

  private renderCommandPrompt(def: CommandDefinition): string {
    // For local dev, we'd need to also load the referenced agents
    // In production, the registry API handles this composition
    // agents is string[] (refs in name@version format)
    const agentRefs = def.command.agents.join(', ');
    return `[Command: ${def.command.interface.name}]
Agents: ${agentRefs}
Model: ${def.command.execution.model.default}
Threshold: ${def.command.execution.thresholds?.pass || 70}`;
  }

  /**
   * Extract version from definition
   */
  private extractVersion(def: any, type: DefinitionType): string {
    switch (type) {
      case 'agent': return def.agent?.interface?.version || 'unknown';
      case 'command': return def.command?.interface?.version || 'unknown';
      case 'workflow': return def.workflow?.interface?.version || 'unknown';
      case 'pipeline': return def.pipeline?.interface?.version || 'unknown';
      default: return 'unknown';
    }
  }

  /**
   * Extract domain from definition
   */
  private extractDomain(def: any, type: DefinitionType): string {
    switch (type) {
      case 'agent': return def.agent?.interface?.domain || 'general';
      case 'command': return def.command?.interface?.domain || 'general';
      case 'workflow': return def.workflow?.interface?.domain || 'general';
      case 'pipeline': return def.pipeline?.interface?.domain || 'general';
      default: return 'general';
    }
  }

  /**
   * Extract agent type from definition
   * Note: For commands, agent type is determined at runtime by resolving
   * the referenced agents (commands have agents: string[], not singular agent)
   */
  private extractAgentType(def: any, type: DefinitionType): 'validator' | 'executor' | undefined {
    switch (type) {
      case 'agent': return def.agent?.interface?.agentType;
      case 'command': return undefined; // Determined at runtime from referenced agents
      default: return undefined;
    }
  }

  /**
   * List available definitions
   */
  async list(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    const results: DefinitionSummary[] = [];

    // List local definitions if configured
    if (this.config.localDefinitions) {
      const local = await this.listLocal(filter);
      results.push(...local);
    }

    // List remote definitions
    const remote = await this.listRemote(filter);
    
    // Merge, preferring local versions
    const seen = new Set(results.map(r => r.name));
    for (const r of remote) {
      if (!seen.has(r.name)) {
        results.push(r);
      }
    }

    return results;
  }

  private async listLocal(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    const results: DefinitionSummary[] = [];
    const baseDir = this.config.localDefinitions!;
    
    const extensions: Record<DefinitionType, string> = {
      agent: '.agent.yaml',
      command: '.command.yaml',
      workflow: '.workflow.yaml',
      pipeline: '.pipeline.yaml',
    };

    for (const [type, ext] of Object.entries(extensions)) {
      if (filter?.type && filter.type !== type) continue;
      
      try {
        const files = await fs.readdir(baseDir);
        for (const file of files) {
          if (file.endsWith(ext)) {
            const content = await fs.readFile(path.join(baseDir, file), 'utf-8');
            const def = yaml.parse(content);
            const summary = this.extractSummary(def, type as DefinitionType, file.replace(ext, ''));
            
            if (!filter?.domain || summary.domain === filter.domain) {
              results.push(summary);
            }
          }
        }
      } catch {
        // Directory doesn't exist or isn't readable
      }
    }
    
    return results;
  }

  private async listRemote(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    const result = await this.sdk.definitions.list({
      status: 'published',
      type: filter?.type,
      domain: filter?.domain,
    });

    return result.items.map(d => ({
      type: d.type as DefinitionType,
      name: d.name,
      version: d.version,
      displayName: d.displayName,
      description: d.description,
      domain: d.domain as any,
      subdomain: d.subdomain ?? undefined,
      agentType: d.agentType as any,
      status: d.status as any,
      tags: d.tags ?? undefined,
    }));
  }

  private extractSummary(def: any, type: DefinitionType, name: string): DefinitionSummary {
    const iface = def[type]?.interface || {};
    return {
      type,
      name: iface.name || name,
      version: iface.version || 'unknown',
      displayName: iface.displayName || name,
      description: iface.description || '',
      domain: iface.domain || 'general',
      subdomain: iface.subdomain,
      agentType: type === 'agent' ? iface.agentType : undefined,
      status: 'draft', // Local files are always draft
      tags: iface.tags,
    };
  }

  /**
   * Clear the definition cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
```

### ValidationClient

Thin wrapper around `@uluops/ops-sdk` for execution result submission and run querying.

**Scope:** Core execution needs only — submit results, preview submissions, get run history, and fetch run details. Analytics, issue management, and advanced queries are available directly via `@uluops/ops-sdk`.

```typescript
// src/validation/ValidationClient.ts

import { OpsClient } from '@uluops/ops-sdk';
import type {
  ResolvedConfig,
  RunSubmission,
  RunSubmissionResponse,
  RunHistoryEntry,
  ValidationQueryOptions,
  ValidatorSnapshot,
  RecommendationPayload,
} from '../types';

/**
 * Thin wrapper around @uluops/ops-sdk for execution result submission.
 *
 * Delegates all API operations to OpsClient (which handles retry,
 * rate limiting, error mapping, auth). This class transforms
 * SDK ExecutionResult objects into the format expected by OpsClient.
 *
 * For full issue management, analytics, and taxonomy operations,
 * use `@uluops/ops-sdk` directly.
 */
export class ValidationClient {
  private ops: OpsClient;

  constructor(private config: ResolvedConfig) {
    this.ops = new OpsClient({
      apiKey: config.apiKey,
      baseUrl: config.validationUrl,
      timeout: config.timeout,
    });
  }

  /**
   * Submit execution results to validation service
   */
  async submit(submission: RunSubmission): Promise<RunSubmissionResponse> {
    if (!this.config.trackingEnabled) {
      return this.createLocalResponse(submission);
    }

    const input = this.transformToOpsInput(submission);
    const response = await this.ops.runs.save(input);

    return {
      runId: response.run.id,
      runNumber: response.run.runNumber,
      projectId: response.run.projectId,
      dashboardUrl: `${this.config.dashboardUrl}/runs/${response.run.id}`,
      allGatesPassed: response.run.allGatesPassed,
      averageScore: response.run.averageScore,
      newIssues: [],  // Mapped from correlation counts
      recurringIssues: [],
      regressions: [],
      deduplicated: response.deduplicated,
    };
  }

  /**
   * Preview what a submission would do without saving
   */
  async validateRun(submission: RunSubmission): Promise<{
    wouldCreate: string[];
    wouldUpdate: string[];
    wouldRegress: string[];
    validationErrors: string[];
  }> {
    const input = this.transformToOpsInput(submission);
    const result = await this.ops.runs.validate(input);

    return {
      wouldCreate: result.wouldCreate ?? [],
      wouldUpdate: result.wouldUpdate ?? [],
      wouldRegress: result.wouldRegress ?? [],
      validationErrors: result.validationErrors ?? [],
    };
  }

  /**
   * Get run history for a project
   */
  async getHistory(project: string, options?: Omit<ValidationQueryOptions, 'project'>): Promise<RunHistoryEntry[]> {
    const runs = await this.ops.runs.listByProject(project, {
      workflowType: options?.workflowType,
      limit: options?.limit,
    });

    return runs.map(r => ({
      id: r.id,
      projectId: r.projectId,
      runNumber: r.runNumber,
      workflowType: r.workflowType,
      timestamp: r.timestamp,
      allGatesPassed: r.allGatesPassed,
      averageScore: r.averageScore,
      rawMarkdown: r.rawMarkdown ?? undefined,
      archivedAt: r.archivedAt ?? undefined,
      archiveReason: r.archiveReason ?? undefined,
      idempotencyKey: r.idempotencyKey ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Get details for a specific run by ID
   */
  async getRun(runId: string): Promise<RunSubmissionResponse> {
    const run = await this.ops.runs.get(runId);
    return {
      runId: run.id,
      runNumber: run.runNumber,
      projectId: run.projectId,
      dashboardUrl: `${this.config.dashboardUrl}/runs/${run.id}`,
      allGatesPassed: run.allGatesPassed,
      averageScore: run.averageScore,
      newIssues: [],
      recurringIssues: [],
      regressions: [],
      deduplicated: false,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Transform SDK RunSubmission to OpsClient SaveFeaturesListInput format
   * @internal
   */
  private transformToOpsInput(submission: RunSubmission): Parameters<OpsClient['runs']['save']>[0] {
    const { result } = submission;

    return {
      project: submission.project,
      workflowType: submission.workflowType,
      idempotencyKey: submission.idempotencyKey,
      validators: [{
        name: result.name,
        score: result.score ?? 0,
        maxScore: 100,
        status: result.decision,
        model: result.metrics.model,
        tokens: {
          inputTokens: result.metrics.inputTokens,
          outputTokens: result.metrics.outputTokens,
          cacheCreation: result.metrics.cacheCreationTokens,
          cacheRead: result.metrics.cacheReadTokens,
          totalEffective: result.metrics.totalEffectiveTokens,
        },
        durationMs: result.metrics.durationMs,
      }],
      recommendations: result.recommendations.map(r => ({
        validator: r.validator ?? 'unknown',
        title: r.title,
        priority: r.priority,
        severity: r.severity,
        failureCode: r.failureCode,
        failureDomain: r.failureDomain,
        failureMode: r.failureMode,
        category: r.category,
        filePath: r.filePath,
        lineNumber: r.lineNumber,
        description: r.description,
        classificationConfidence: r.classificationConfidence,
        classifiedBy: r.classifiedBy,
        secondaryFailureCodes: r.secondaryFailureCodes,
        taxonomyVersion: r.taxonomyVersion,
      })),
      timestamp: new Date().toISOString(),
      rawMarkdown: submission.rawMarkdown,
      summary: {
        allGatesPassed: result.decision === 'PASS' || result.decision === 'SHIP',
        averageScore: result.score ?? 0,
      },
    };
  }

  /**
   * Create a local-only response when tracking is disabled
   * @internal
   */
  private createLocalResponse(submission: RunSubmission): RunSubmissionResponse {
    return {
      runId: 'local',
      runNumber: 0,
      projectId: 'local',
      dashboardUrl: '',
      allGatesPassed: submission.result.decision === 'PASS' || submission.result.decision === 'SHIP',
      averageScore: submission.result.score,
      newIssues: submission.result.recommendations.map((r, i) => ({
        id: `local-${i}`,
        title: r.title,
        fingerprint: 'local',
      })),
      recurringIssues: [],
      regressions: [],
      deduplicated: false,
    };
  }

  /**
   * Detect execution environment
   */
  private detectEnvironment(): string {
    if (process.env.CI) return 'ci';
    if (process.env.GITHUB_ACTIONS) return 'github-actions';
    if (process.env.GITLAB_CI) return 'gitlab-ci';
    if (process.env.JENKINS_URL) return 'jenkins';
    return 'local';
  }
}
```

### CommandExecutor

**Updated in v0.8.0.** Executes command definitions. Delegates single-agent commands to `AgentExecutor`; handles multi-agent aggregation locally.

```typescript
// src/executor/CommandExecutor.ts

import { AgentExecutor } from './AgentExecutor';
import { RegistryClient } from '../registry/RegistryClient';
import { runPreflightChecks } from './preflight';
import type {
  ResolvedConfig,
  ResolvedDefinition,
  CommandDefinition,
  ExecutionInput,
  CommandResult,
  AgentResult,
  ValidatorAgentResult,
  ExecutorAgentResult,
  Recommendation,
} from '../types';
import { ExecutionError } from '../errors';

/**
 * Executes command definitions
 *
 * **v0.8.0 Architecture:**
 * - Single-agent commands: Delegates to AgentExecutor
 * - Multi-agent commands: Runs agents in sequence/parallel, aggregates results
 *
 * CommandExecutor handles the "saved configuration" layer:
 * - Preflight checks (file existence, env vars)
 * - Model/threshold overrides from command definition
 * - Multi-agent aggregation (when commands reference multiple agents)
 *
 * @example
 * ```typescript
 * const executor = new CommandExecutor(config, agentExecutor, registry);
 * const result = await executor.execute(resolvedCommand, { target: './src' });
 * console.log(result.score, result.decision);
 * ```
 */
export class CommandExecutor {
  constructor(
    private config: ResolvedConfig,
    private agentExecutor: AgentExecutor,
    private registry: RegistryClient,
  ) {}

  /**
   * Execute a command definition
   *
   * The execution flow:
   * 1. Run preflight checks (file existence, env vars, etc.)
   * 2. Resolve referenced agent(s)
   * 3. For single-agent: delegate to AgentExecutor
   * 4. For multi-agent: execute each, aggregate results
   * 5. Apply command-level thresholds
   * 6. Return CommandResult with metrics
   *
   * @param resolved - Resolved command definition from registry
   * @param input - Execution input with target path and options
   * @returns Command result with score, decision, findings, and metrics
   *
   * @throws {PreflightError} If any preflight check fails
   * @throws {ExecutionError} If execution fails (includes partialResult)
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<CommandResult> {
    const startTime = Date.now();
    const def = resolved.definition as CommandDefinition;

    // 1. Run preflight checks
    if (def.command.execution.preflight) {
      await runPreflightChecks(def.command.execution.preflight, input);
    }

    // 2. Resolve referenced agents
    const agentRefs = def.command.agents; // string[] of "name@version" refs

    // 3. Single-agent: delegate to AgentExecutor
    if (agentRefs.length === 1) {
      const agentResolved = await this.registry.resolve(
        agentRefs[0].split('@')[0],
        agentRefs[0].split('@')[1],
        'agent'
      );

      const agentResult = await this.agentExecutor.execute(agentResolved, input, {
        model: def.command.execution.model.default,
        timeoutMs: def.command.execution.timeout,
        thresholds: def.command.execution.thresholds,
      });

      return this.wrapAgentResult(agentResult, def, resolved.hash, startTime);
    }

    // 4. Multi-agent: execute each and aggregate
    const agentResults: AgentResult[] = [];
    const aggregation = def.command.aggregation || { method: 'average' };

    for (const ref of agentRefs) {
      const agentResolved = await this.registry.resolve(
        ref.split('@')[0],
        ref.split('@')[1],
        'agent'
      );

      const result = await this.agentExecutor.execute(agentResolved, input, {
        model: def.command.execution.model.default,
        timeoutMs: def.command.execution.timeout,
      });

      agentResults.push(result);
    }

    return this.aggregateResults(agentResults, def, resolved.hash, startTime, aggregation);
  }

  /**
   * Wrap a single agent result as a CommandResult
   */
  private wrapAgentResult(
    agentResult: AgentResult,
    def: CommandDefinition,
    hash: string,
    startTime: number
  ): CommandResult {
    const durationMs = Date.now() - startTime;

    const base = {
      type: 'command' as const,
      name: def.command.interface.name,
      version: def.command.interface.version,
      definitionHash: hash,
      agentType: agentResult.agentType,
      decision: agentResult.decision,
      threshold: def.command.execution.thresholds?.pass,
      recommendations: agentResult.recommendations,
      durationMs,
      metrics: agentResult.metrics,
    };

    if (agentResult.agentType === 'validator') {
      return { ...base, score: agentResult.score, maxScore: agentResult.maxScore, categories: agentResult.categories };
    }
    return { ...base, artifacts: agentResult.artifacts };
  }

  /**
   * Aggregate multiple agent results into a single CommandResult
   */
  private aggregateResults(
    results: AgentResult[],
    def: CommandDefinition,
    hash: string,
    startTime: number,
    aggregation: { method: string; weights?: Record<string, number> }
  ): CommandResult {
    const durationMs = Date.now() - startTime;

    // Collect all recommendations
    const recommendations: Recommendation[] = results.flatMap(r => r.recommendations);

    // Aggregate scores (for validators)
    const validatorResults = results.filter(
      (r): r is ValidatorAgentResult => r.agentType === 'validator'
    );
    let score: number | undefined;
    let maxScore: number | undefined;

    if (validatorResults.length > 0) {
      const scores = validatorResults.map(r => r.score);

      switch (aggregation.method) {
        case 'min':
          score = Math.min(...scores);
          break;
        case 'max':
          score = Math.max(...scores);
          break;
        case 'weighted_average':
          const weights = aggregation.weights || {};
          let totalWeight = 0;
          let weightedSum = 0;
          validatorResults.forEach(r => {
            const w = weights[r.name] || 1;
            totalWeight += w;
            weightedSum += r.score * w;
          });
          score = totalWeight > 0 ? weightedSum / totalWeight : 0;
          break;
        case 'average':
        default:
          score = scores.reduce((a, b) => a + b, 0) / scores.length;
      }

      maxScore = Math.max(...validatorResults.map(r => r.maxScore || 100));
    }

    // Determine overall decision
    const threshold = def.command.execution.thresholds?.pass || 70;
    const warnThreshold = def.command.execution.thresholds?.warn || 50;
    let decision: string;

    if (score !== undefined) {
      if (score >= threshold) decision = 'PASS';
      else if (score >= warnThreshold) decision = 'WARN';
      else decision = 'FAIL';
    } else {
      // For executors, check if any failed
      const failed = results.some(r => r.decision === 'FAILED');
      const partial = results.some(r => r.decision === 'PARTIAL');
      decision = failed ? 'FAILED' : partial ? 'PARTIAL' : 'COMPLETE';
    }

    // Aggregate metrics
    const metrics = {
      inputTokens: results.reduce((sum, r) => sum + r.metrics.inputTokens, 0),
      outputTokens: results.reduce((sum, r) => sum + r.metrics.outputTokens, 0),
      cacheCreationTokens: results.reduce((sum, r) => sum + (r.metrics.cacheCreationTokens || 0), 0),
      cacheReadTokens: results.reduce((sum, r) => sum + (r.metrics.cacheReadTokens || 0), 0),
      totalEffectiveTokens: results.reduce((sum, r) => sum + r.metrics.totalEffectiveTokens, 0),
      durationMs,
      model: 'mixed',
      costUsd: results.reduce((sum, r) => sum + (r.metrics.costUsd || 0), 0),
      toolCalls: results.reduce((sum, r) => sum + (r.metrics.toolCalls || 0), 0),
      agentsExecuted: results.length,
    };

    return {
      type: 'command',
      name: def.command.interface.name,
      version: def.command.interface.version,
      definitionHash: hash,
      agentType: validatorResults.length > 0 ? 'validator' : 'executor',
      decision,
      score,
      maxScore,
      threshold,
      recommendations,
      durationMs,
      metrics,
    };
  }
}
```

### WorkflowExecutor

Multi-command orchestration with phases and gates.

```typescript
// src/executor/WorkflowExecutor.ts

import { CommandExecutor } from './CommandExecutor';
import { RegistryClient } from '../registry/RegistryClient';
import type {
  ResolvedConfig,
  ResolvedDefinition,
  WorkflowDefinition,
  ExecutionInput,
  WorkflowResult,
  PhaseResult,
  CommandResult,
  Recommendation,
} from '../types';
import { WorkflowError } from '../errors';

/**
 * Executes workflows with multi-phase orchestration
 *
 * WorkflowExecutor handles:
 * - Phase dependency resolution
 * - Gate threshold evaluation (pass/warn/block)
 * - Score aggregation across phases
 * - Recommendation deduplication
 * - Failure handling (stop vs continue)
 *
 * @example
 * ```typescript
 * const executor = new WorkflowExecutor(config, cmdExecutor, registry);
 * const result = await executor.execute(resolvedWorkflow, { target: './src' });
 * console.log(result.phases.map(p => `${p.name}: ${p.decision}`));
 * ```
 */
export class WorkflowExecutor {
  constructor(
    private config: ResolvedConfig,
    private commandExecutor: CommandExecutor,
    private registry: RegistryClient,
  ) {}

  /**
   * Execute a workflow with phase orchestration
   *
   * The execution flow:
   * 1. Iterate through phases in order (or by dependency)
   * 2. For each phase:
   *    - Check skip_if condition
   *    - Verify dependencies are met
   *    - Execute all commands in the phase
   *    - Evaluate gate threshold
   *    - Stop or continue based on on_failure config
   * 3. Aggregate scores across all phases
   * 4. Deduplicate recommendations
   *
   * @param resolved - Resolved workflow definition from registry
   * @param input - Execution input with target path
   * @returns Workflow result with phase results, aggregated score, and recommendations
   *
   * @throws {WorkflowError} If workflow fails (includes partialResult with completed phases)
   *
   * @example
   * ```typescript
   * const result = await executor.execute(workflow, { target: './project' });
   *
   * for (const phase of result.phases) {
   *   console.log(`${phase.name}: ${phase.score}/${phase.maxScore} - ${phase.decision}`);
   * }
   * console.log(`Overall: ${result.score} - ${result.decision}`);
   * ```
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<WorkflowResult> {
    const startTime = Date.now();
    const def = resolved.definition as WorkflowDefinition;
    const phaseResults: PhaseResult[] = [];
    const allRecommendations: Recommendation[] = [];
    let totalTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let totalCost = 0;

    try {
      for (const phase of def.workflow.orchestration.phases) {
        // Check skip condition
        if (phase.skip_if && this.evaluateCondition(phase.skip_if, input, phaseResults)) {
          phaseResults.push(this.createSkippedPhase(phase));
          continue;
        }

        // Check dependencies
        if (!this.checkDependencies(phase.depends_on, phaseResults)) {
          phaseResults.push(this.createSkippedPhase(phase));
          continue;
        }

        // Execute phase
        const phaseResult = await this.executePhase(phase, input);
        phaseResults.push(phaseResult);

        // Accumulate recommendations and metrics
        for (const cmd of phaseResult.commands) {
          allRecommendations.push(...cmd.recommendations);
          totalTokens.input += cmd.metrics.inputTokens;
          totalTokens.output += cmd.metrics.outputTokens;
          totalTokens.cacheCreation += cmd.metrics.cacheCreationTokens || 0;
          totalTokens.cacheRead += cmd.metrics.cacheReadTokens || 0;
          totalCost += cmd.metrics.costUsd || 0;
        }

        // Check gate
        if (
          phaseResult.decision === 'blocked' &&
          def.workflow.orchestration.on_failure === 'stop'
        ) {
          break;
        }
      }
    } catch (error) {
      throw new WorkflowError(
        `Workflow failed: ${error instanceof Error ? error.message : String(error)}`,
        { partialResult: this.buildPartialResult(def, phaseResults, allRecommendations, startTime, resolved.hash) }
      );
    }

    const aggregated = this.aggregate(def.workflow.aggregation, phaseResults);
    const durationMs = Date.now() - startTime;

    return {
      type: 'workflow',
      name: def.workflow.interface.name,
      version: def.workflow.interface.version,
      definitionHash: resolved.hash,
      decision: aggregated.decision,
      score: aggregated.score,
      phases: phaseResults,
      recommendations: this.deduplicateRecommendations(allRecommendations),
      durationMs,
      metrics: {
        inputTokens: totalTokens.input,
        outputTokens: totalTokens.output,
        cacheCreationTokens: totalTokens.cacheCreation,
        cacheReadTokens: totalTokens.cacheRead,
        totalEffectiveTokens: totalTokens.input + totalTokens.output + totalTokens.cacheCreation,
        durationMs,
        model: 'mixed',
        costUsd: totalCost,
        phasesExecuted: phaseResults.filter(p => p.decision !== 'skipped').length,
        phasesPassed: phaseResults.filter(p => p.decision === 'passed').length,
        phasesWarned: phaseResults.filter(p => p.decision === 'warned').length,
        phasesBlocked: phaseResults.filter(p => p.decision === 'blocked').length,
        phasesSkipped: phaseResults.filter(p => p.decision === 'skipped').length,
        commands: phaseResults.flatMap(p => 
          p.commands.map(c => ({
            name: c.name,
            score: c.score,
            decision: c.decision,
            inputTokens: c.metrics.inputTokens,
            outputTokens: c.metrics.outputTokens,
            durationMs: c.metrics.durationMs,
            costUsd: c.metrics.costUsd,
          }))
        ),
      },
    };
  }

  private async executePhase(phase: any, input: ExecutionInput): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const commandResults: CommandResult[] = [];

    if (phase.parallel) {
      const results = await Promise.all(
        phase.commands.map((cmdName: string) => this.executeCommand(cmdName, input))
      );
      commandResults.push(...results);
    } else {
      for (const cmdName of phase.commands) {
        const result = await this.executeCommand(cmdName, input);
        commandResults.push(result);
      }
    }

    const aggregateScore = this.aggregatePhaseScore(
      commandResults,
      phase.gate?.aggregate || 'average'
    );

    const decision = this.evaluateGate(aggregateScore, phase.gate);

    return {
      id: phase.id,
      name: phase.name,
      decision,
      commands: commandResults,
      gateThreshold: phase.gate?.threshold || 70,
      score: aggregateScore,
      durationMs: Date.now() - phaseStart,
    };
  }

  private async executeCommand(cmdName: string, input: ExecutionInput): Promise<CommandResult> {
    const resolved = await this.registry.resolve(cmdName);
    
    if (resolved.type !== 'command') {
      throw new Error(`Expected command, got ${resolved.type}: ${cmdName}`);
    }
    
    return this.commandExecutor.execute(resolved, input);
  }

  private aggregatePhaseScore(results: CommandResult[], method: string): number {
    if (results.length === 0) return 0;
    const scores = results.map(r => r.score);
    
    switch (method) {
      case 'min': return Math.min(...scores);
      case 'max': return Math.max(...scores);
      case 'average':
      default:
        return scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  private evaluateGate(score: number, gate: any): 'passed' | 'warned' | 'blocked' {
    if (!gate) return 'passed';
    if (score >= gate.threshold) return 'passed';
    if (gate.on_fail === 'warn') return 'warned';
    return 'blocked';
  }

  private aggregate(config: any, phases: PhaseResult[]): { decision: string; score: number } {
    const weights = config?.score?.weights || {};
    let totalWeight = 0;
    let weightedScore = 0;

    for (const phase of phases) {
      if (phase.decision === 'skipped') continue;
      const weight = weights[phase.id] || 1;
      totalWeight += weight;
      weightedScore += phase.score * weight;
    }

    const score = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;

    const hasBlocked = phases.some(p => p.decision === 'blocked');
    const hasWarned = phases.some(p => p.decision === 'warned');

    let decision: string;
    if (hasBlocked) {
      decision = config?.decision?.BLOCK || 'BLOCK';
    } else if (hasWarned) {
      decision = config?.decision?.HOLD || 'HOLD';
    } else {
      decision = config?.decision?.SHIP || 'SHIP';
    }

    return { decision, score };
  }

  private createSkippedPhase(phase: any): PhaseResult {
    return {
      id: phase.id,
      name: phase.name,
      decision: 'skipped',
      commands: [],
      gateThreshold: phase.gate?.threshold || 70,
      score: 0,
      durationMs: 0,
    };
  }

  private checkDependencies(dependsOn: string[] | undefined, completedPhases: PhaseResult[]): boolean {
    if (!dependsOn || dependsOn.length === 0) return true;
    return dependsOn.every(depId => {
      const dep = completedPhases.find(p => p.id === depId);
      return dep && dep.decision !== 'blocked';
    });
  }

  private evaluateCondition(condition: string, input: ExecutionInput, phases: PhaseResult[]): boolean {
    const match = condition.match(/\{\{\s*input\.(\w+)\s*\}\}/);
    if (match) return Boolean(input.options?.[match[1]]);
    return false;
  }

  private deduplicateRecommendations(recommendations: Recommendation[]): Recommendation[] {
    const seen = new Set<string>();
    return recommendations.filter(r => {
      const key = `${r.title}|${r.filePath}|${r.lineNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private buildPartialResult(
    def: WorkflowDefinition,
    phases: PhaseResult[],
    recommendations: Recommendation[],
    startTime: number,
    hash: string
  ): Partial<WorkflowResult> {
    return {
      type: 'workflow',
      name: def.workflow.interface.name,
      definitionHash: hash,
      phases,
      recommendations,
      durationMs: Date.now() - startTime,
    };
  }
}
```

### PipelineExecutor

Executes multi-stage pipelines with async support and state management.

```typescript
// src/executor/PipelineExecutor.ts

import type {
  ResolvedConfig,
  ResolvedDefinition,
  PipelineDefinition,
  ExecutionInput,
  PipelineResult,
  StageResult,
} from '../types';
import { CommandExecutor } from './CommandExecutor';
import { WorkflowExecutor } from './WorkflowExecutor';
import { RegistryClient } from '../registry/RegistryClient';

/**
 * Executes pipelines with multi-stage orchestration and async support
 *
 * PipelineExecutor handles:
 * - Stage dependency resolution
 * - Conditional stage execution
 * - Mix of workflow and command stages
 * - Async execution with status tracking
 * - State persistence between stages
 *
 * @example
 * ```typescript
 * const executor = new PipelineExecutor(config, workflowExec, cmdExec, registry);
 * const handle = await executor.start(resolvedPipeline, { target: './src' });
 * const result = await handle.waitForCompletion();
 * ```
 */
export class PipelineExecutor {
  /** Track running/completed pipelines by execution ID */
  private runningPipelines = new Map<string, PipelineState>();

  constructor(
    private config: ResolvedConfig,
    private workflowExecutor: WorkflowExecutor,
    private commandExecutor: CommandExecutor,
    private registry: RegistryClient,
  ) {}

  /**
   * Start pipeline execution asynchronously
   *
   * Returns a PipelineHandle for monitoring progress and retrieving results.
   * Pipelines run in the background, allowing:
   * - Status polling
   * - Progress monitoring
   * - Cancellation
   * - Result retrieval when complete
   *
   * @param resolved - Resolved pipeline definition from registry
   * @param input - Execution input with target path
   * @returns Pipeline handle for monitoring and control
   *
   * @example
   * ```typescript
   * const handle = await executor.start(pipeline, { target: './project' });
   *
   * // Poll for status
   * while (!handle.isComplete()) {
   *   const status = await handle.getStatus();
   *   console.log(`Stage: ${status.currentStage}, Progress: ${status.progress}%`);
   *   await sleep(1000);
   * }
   *
   * const result = await handle.getResult();
   * ```
   */
  async start(resolved: ResolvedDefinition, input: ExecutionInput): Promise<PipelineHandle> {
    const def = resolved.definition as PipelineDefinition;
    const pipelineId = this.generatePipelineId();

    // Initialize pipeline state
    const state: PipelineState = {
      pipelineId,
      status: 'running',
      currentStageIndex: 0,
      stageResults: [],
      startTime: Date.now(),
    };

    // Start execution in background
    this.executeAsync(resolved, input, state);

    return new PipelineHandle(pipelineId, state, this.config);
  }

  /**
   * Execute pipeline synchronously (blocking)
   *
   * For simpler use cases where async handling isn't needed.
   * Blocks until all stages complete or pipeline fails.
   *
   * @param resolved - Resolved pipeline definition from registry
   * @param input - Execution input with target path
   * @returns Complete pipeline result with all stage results
   *
   * @throws {PipelineError} If pipeline fails (includes partialResult)
   */
  async execute(resolved: ResolvedDefinition, input: ExecutionInput): Promise<PipelineResult> {
    const handle = await this.start(resolved, input);
    return handle.waitForCompletion();
  }

  private async executeAsync(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    state: PipelineState
  ): Promise<void> {
    const def = resolved.definition as PipelineDefinition;

    try {
      for (let i = 0; i < def.pipeline.stages.length; i++) {
        const stage = def.pipeline.stages[i];
        state.currentStageIndex = i;

        // Check dependencies
        if (!this.checkStageDependencies(stage.depends_on, state.stageResults)) {
          state.stageResults.push(this.createSkippedStage(stage, 'dependencies_not_met'));
          continue;
        }

        // Evaluate skip condition
        if (stage.skip_if && this.evaluateCondition(stage.skip_if, state.stageResults)) {
          state.stageResults.push(this.createSkippedStage(stage, 'skip_if_true'));
          continue;
        }

        // Execute stage
        const stageResult = await this.executeStage(stage, input);
        state.stageResults.push(stageResult);
      }

      state.status = 'completed';
    } catch (error) {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async executeStage(stage: StageDefinition, input: ExecutionInput): Promise<StageResult> {
    // Use explicit type from stage definition (no inference)
    const resolved = await this.registry.resolve(
      stage.ref.split('@')[0],
      stage.ref.split('@')[1],
      stage.type
    );

    const startTime = Date.now();

    if (stage.type === 'workflow') {
      const result = await this.workflowExecutor.execute(resolved, input);
      return {
        id: stage.id,
        name: stage.name,
        type: 'workflow',
        status: 'completed',
        result,
        durationMs: Date.now() - startTime,
      };
    } else {
      const result = await this.commandExecutor.execute(resolved, input);
      return {
        id: stage.id,
        name: stage.name,
        type: 'command',
        status: 'completed',
        result,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private generatePipelineId(): string {
    return `pipeline_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private checkStageDependencies(deps: string[] | undefined, results: StageResult[]): boolean {
    if (!deps || deps.length === 0) return true;
    return deps.every(dep =>
      results.some(r => r.id === dep && r.status === 'completed')
    );
  }

  /**
   * Safe condition evaluator for stage conditions
   *
   * Supports expressions like:
   *   "pre-merge.decision == 'PASS'"
   *   "validate.score >= 80"
   *   "lint.decision != 'FAIL'"
   *
   * @internal
   */
  private evaluateCondition(condition: string, results: StageResult[]): boolean {
    const context = Object.fromEntries(results.map(r => [r.id, r.result]));

    // Parse "path.field op value" expressions
    const match = condition.match(
      /^([\w-]+)\.([\w]+)\s*(==|!=|>=|<=|>|<)\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))$/
    );

    if (!match) return false;

    const [, stageId, field, op, strVal1, strVal2, numVal] = match;
    const stageResult = context[stageId];
    if (!stageResult || typeof stageResult !== 'object') return false;

    const actual = (stageResult as Record<string, unknown>)[field];
    const expected = numVal !== undefined ? Number(numVal) : (strVal1 ?? strVal2);

    switch (op) {
      case '==': return actual == expected;
      case '!=': return actual != expected;
      case '>=': return Number(actual) >= Number(expected);
      case '<=': return Number(actual) <= Number(expected);
      case '>':  return Number(actual) > Number(expected);
      case '<':  return Number(actual) < Number(expected);
      default:   return false;
    }
  }

  private createSkippedStage(stage: StageDefinition, reason: string): StageResult {
    return {
      id: stage.id,
      name: stage.name,
      type: stage.type,
      status: 'skipped',
      skipReason: reason,
      durationMs: 0,
    };
  }

  /**
   * Get status of a running or completed pipeline
   *
   * @param executionId - Pipeline execution ID from start() response
   * @returns Current pipeline status and results
   */
  async getStatus(executionId: string): Promise<PipelineResult> {
    const state = this.runningPipelines.get(executionId);
    if (!state) {
      throw new PipelineError(`Pipeline ${executionId} not found`);
    }
    return this.buildResult(state);
  }

  /**
   * Cancel a running pipeline
   *
   * @param executionId - Pipeline execution ID to cancel
   * @throws {PipelineError} If pipeline not found or already completed
   */
  async cancel(executionId: string): Promise<void> {
    const state = this.runningPipelines.get(executionId);
    if (!state) {
      throw new PipelineError(`Pipeline ${executionId} not found`);
    }
    if (state.status !== 'running') {
      throw new PipelineError(`Pipeline ${executionId} is not running (status: ${state.status})`);
    }
    state.status = 'cancelled';
    state.error = 'Pipeline cancelled by user';
  }

  private buildResult(state: PipelineState): PipelineResult {
    const durationMs = Date.now() - state.startTime;

    // Collect scores from stages with results
    const stageScores = state.stageResults
      .filter(s => s.result?.score !== undefined)
      .map(s => s.result!.score);

    // Calculate average score (0 if no scores)
    const score = stageScores.length > 0
      ? stageScores.reduce((a, b) => a + b, 0) / stageScores.length
      : 0;

    // Flatten recommendations from all stage results
    const recommendations = state.stageResults
      .filter(s => s.result?.recommendations)
      .flatMap(s => s.result!.recommendations);

    // Compute decision based on stage outcomes
    const decision = this.computePipelineDecision(state);

    return {
      type: 'pipeline',
      name: state.pipelineId,
      version: state.definitionVersion || '1.0.0',
      definitionHash: state.definitionHash || '',
      decision,
      score,
      durationMs,
      status: state.status === 'completed' ? 'complete' : state.status,
      stages: state.stageResults,
      recommendations,
      metrics: {
        durationMs,
        tokensUsed: state.stageResults.reduce((sum, s) => sum + (s.result?.metrics?.tokensUsed || 0), 0),
        stagesExecuted: state.stageResults.filter(s => s.status === 'completed').length,
        stagesPassed: state.stageResults.filter(s => s.result?.decision === 'PASS').length,
        stagesFailed: state.stageResults.filter(s => s.result?.decision === 'FAIL').length,
        stagesSkipped: state.stageResults.filter(s => s.status === 'skipped').length,
      },
    };
  }

  /**
   * Compute overall pipeline decision from stage results
   */
  private computePipelineDecision(state: PipelineState): string {
    if (state.status === 'cancelled') return 'CANCELLED';
    if (state.status === 'failed') return 'FAIL';

    const failedStages = state.stageResults.filter(
      s => s.result?.decision === 'FAIL' || s.result?.decision === 'FAILED'
    );
    if (failedStages.length > 0) return 'FAIL';

    const warnedStages = state.stageResults.filter(
      s => s.result?.decision === 'WARN'
    );
    if (warnedStages.length > 0) return 'WARN';

    return 'PASS';
  }
}

// PipelineState type defined in types/pipeline.ts (see Core Types > Pipeline Types section)
```

### PipelineHandle

Concrete implementation of the `PipelineHandle` interface for monitoring and controlling async pipeline execution.

```typescript
// src/client/PipelineHandle.ts

import type {
  PipelineHandle as IPipelineHandle,
  PipelineResult,
  PipelineState,
  ResolvedConfig,
} from '../types';
import { PipelineError } from '../errors';

/**
 * Handle for monitoring and controlling an async pipeline execution
 *
 * @example
 * ```typescript
 * const handle = await client.startPipeline('ship', { target: './src' });
 *
 * // Poll for status
 * while (!handle.isComplete()) {
 *   const status = await handle.status();
 *   console.log(`Stage: ${status.currentStage}`);
 *   await new Promise(r => setTimeout(r, 5000));
 * }
 *
 * // Get final result
 * const result = await handle.wait();
 * console.log(`Decision: ${result.decision}`);
 * ```
 */
export class PipelineHandle implements IPipelineHandle {
  readonly executionId: string;
  private state: PipelineState;
  private completionPromise: Promise<PipelineResult> | null = null;

  constructor(
    executionId: string,
    state: PipelineState,
    private config: ResolvedConfig,
  ) {
    this.executionId = executionId;
    this.state = state;
  }

  /**
   * Get current pipeline status
   */
  async status(): Promise<PipelineResult> {
    return this.buildResult();
  }

  /**
   * Check if pipeline has completed (successfully, failed, or cancelled)
   */
  isComplete(): boolean {
    return this.state.status !== 'running' && this.state.status !== 'pending';
  }

  /**
   * Wait for pipeline to complete, polling at the specified interval
   *
   * @param pollIntervalMs - Polling interval (default 5000ms)
   * @returns Final pipeline result
   * @throws {PipelineError} If pipeline fails or is cancelled
   */
  async wait(pollIntervalMs = 5000): Promise<PipelineResult> {
    while (!this.isComplete()) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    const result = await this.status();

    if (this.state.status === 'failed') {
      throw new PipelineError(
        `Pipeline ${this.executionId} failed: ${this.state.error || 'Unknown error'}`
      );
    }

    return result;
  }

  /**
   * Cancel the running pipeline
   */
  async cancel(): Promise<void> {
    if (this.isComplete()) {
      throw new PipelineError(
        `Pipeline ${this.executionId} is already complete (status: ${this.state.status})`
      );
    }
    this.state.status = 'cancelled';
    this.state.error = 'Pipeline cancelled by user';
  }

  private buildResult(): PipelineResult {
    const durationMs = Date.now() - this.state.startTime;
    const stageScores = this.state.stageResults
      .filter(s => s.result?.score !== undefined)
      .map(s => s.result!.score);
    const score = stageScores.length > 0
      ? stageScores.reduce((a, b) => a + b, 0) / stageScores.length
      : 0;
    const recommendations = this.state.stageResults
      .filter(s => s.result?.recommendations)
      .flatMap(s => s.result!.recommendations);

    return {
      type: 'pipeline',
      name: this.state.pipelineId,
      version: this.state.definitionVersion || '1.0.0',
      definitionHash: this.state.definitionHash || '',
      decision: this.state.status === 'completed' ? 'PASS' : this.state.status.toUpperCase(),
      score,
      durationMs,
      status: this.state.status,
      stages: this.state.stageResults,
      recommendations,
      metrics: {
        durationMs,
        tokensUsed: this.state.stageResults.reduce(
          (sum, s) => sum + (s.result?.metrics?.tokensUsed || 0), 0
        ),
        stagesExecuted: this.state.stageResults.filter(s => s.status === 'completed').length,
        stagesPassed: this.state.stageResults.filter(s => s.result?.decision === 'PASS').length,
        stagesFailed: this.state.stageResults.filter(s => s.result?.decision === 'FAIL').length,
        stagesSkipped: this.state.stageResults.filter(s => s.status === 'skipped').length,
      },
    };
  }
}
```

### UluOpsClient

**Updated in v0.8.0.** Unified client interface with explicit methods for each execution type.

```typescript
// src/client/UluOpsClient.ts

import { RegistryClient } from '../registry/RegistryClient';
import { ValidationClient } from '../validation/ValidationClient';
import { AIProvider } from '../ai/AIProvider';
import { AgentExecutor } from '../executor/AgentExecutor';
import { CommandExecutor } from '../executor/CommandExecutor';
import { WorkflowExecutor } from '../executor/WorkflowExecutor';
import { PipelineExecutor } from '../executor/PipelineExecutor';
import { PipelineHandle } from './PipelineHandle';
import type {
  UluOpsConfig,
  ResolvedConfig,
  ExecutionInput,
  ExecutionResult,
  ExecutionOptions,
  AgentResult,
  CommandResult,
  WorkflowResult,
  PipelineResult,
  DefinitionSummary,
  DefinitionType,
} from '../types';

/**
 * Unified UluOps SDK client
 *
 * **v0.8.0 Execution Methods:**
 * - `runAgent(name, target, options?)` - Direct agent execution with call-time options
 * - `runCommand(name, input)` - Command execution with saved configuration
 * - `runWorkflow(name, input)` - Workflow execution
 * - `run(name, input)` - Auto-detect and route (agents now directly executable)
 *
 * @example
 * ```typescript
 * const client = new UluOpsClient({ apiKey: process.env.ULUOPS_API_KEY });
 *
 * // Direct agent execution (new in v0.8.0)
 * const result = await client.runAgent('code-validator', './src', {
 *   model: 'opus',
 *   thresholds: { pass: 80 },
 * });
 *
 * // Command execution (uses saved config)
 * const cmdResult = await client.runCommand('validate', { target: './src' });
 *
 * // Auto-routing (now handles agents directly)
 * const autoResult = await client.run('code-validator', { target: './src' });
 * ```
 */
export class UluOpsClient {
  private registry: RegistryClient;
  private validation: ValidationClient;
  private agentExecutor: AgentExecutor;
  private commandExecutor: CommandExecutor;
  private workflowExecutor: WorkflowExecutor;
  private pipelineExecutor: PipelineExecutor;
  private config: ResolvedConfig;

  constructor(config: UluOpsConfig) {
    this.config = this.validateConfig(config);

    this.registry = new RegistryClient(this.config);
    this.validation = new ValidationClient(this.config);
    const aiProvider = new AIProvider(this.config);

    // AgentExecutor is the primary execution engine (v0.8.0)
    this.agentExecutor = new AgentExecutor(this.config, aiProvider, this.registry);

    // CommandExecutor delegates to AgentExecutor for single-agent commands
    this.commandExecutor = new CommandExecutor(this.config, this.agentExecutor, this.registry);

    this.workflowExecutor = new WorkflowExecutor(this.config, this.commandExecutor, this.registry);
    this.pipelineExecutor = new PipelineExecutor(this.config, this.workflowExecutor, this.commandExecutor, this.registry);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Primary Execution Methods (v0.8.0)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Direct agent execution with call-time options
   *
   * Use this for:
   * - Interactive/ad-hoc validation
   * - Experimentation with different models/thresholds
   * - Development and testing
   *
   * For reproducible CI runs, use `runCommand()` instead.
   *
   * @param name - Agent name with optional version (e.g., "code-validator@1.2.0")
   * @param target - Target directory to analyze
   * @param options - Runtime options (model, thresholds, etc.)
   * @returns Agent result (discriminated by agentType)
   *
   * @example
   * ```typescript
   * const result = await client.runAgent('code-validator', './src', {
   *   model: 'opus',
   *   thresholds: { pass: 80, warn: 60 },
   *   project: 'my-api',
   * });
   *
   * if (result.agentType === 'validator') {
   *   console.log(`Score: ${result.score}/${result.maxScore}`);
   * }
   * ```
   */
  async runAgent(
    name: string,
    target: string,
    options?: ExecutionOptions
  ): Promise<AgentResult> {
    const resolved = await this.registry.resolve(name, undefined, 'agent');

    if (resolved.type !== 'agent') {
      throw new Error(`${name} is not an agent (type: ${resolved.type}). Use runCommand() instead.`);
    }

    const result = await this.agentExecutor.execute(resolved, { target }, options);

    // Submit to validation service if tracking enabled
    if (options?.trackResults ?? this.config.trackingEnabled) {
      const validationResponse = await this.validation.submit({
        project: options?.project ?? this.config.defaultProject ?? resolved.name,
        workflowType: 'agent',
        result,
      });
      result.dashboardUrl = validationResponse.dashboardUrl;
    }

    return result;
  }

  /**
   * Execute a saved command configuration
   *
   * Use this for:
   * - CI/CD pipelines (reproducible configuration)
   * - Team-standardized validation runs
   * - Multi-agent commands with aggregation
   *
   * @param name - Command name with optional version
   * @param input - Execution input with target and options
   * @returns Command result
   */
  async runCommand(name: string, input: ExecutionInput): Promise<CommandResult> {
    const resolved = await this.registry.resolve(name, undefined, 'command');

    if (resolved.type !== 'command') {
      throw new Error(`${name} is not a command (type: ${resolved.type})`);
    }

    const result = await this.commandExecutor.execute(resolved, input);

    // Submit to validation service
    if (this.config.trackingEnabled) {
      const validationResponse = await this.validation.submit({
        project: this.config.defaultProject ?? resolved.name,
        workflowType: 'command',
        result,
      });
      result.dashboardUrl = validationResponse.dashboardUrl;
    }

    return result;
  }

  /**
   * Execute a workflow
   *
   * @param name - Workflow name with optional version
   * @param input - Execution input with target and options
   * @returns Workflow result with phase details
   */
  async runWorkflow(name: string, input: ExecutionInput): Promise<WorkflowResult> {
    const resolved = await this.registry.resolve(name, undefined, 'workflow');

    if (resolved.type !== 'workflow') {
      throw new Error(`${name} is not a workflow (type: ${resolved.type})`);
    }

    const result = await this.workflowExecutor.execute(resolved, input);

    if (this.config.trackingEnabled) {
      const validationResponse = await this.validation.submit({
        project: this.config.defaultProject ?? resolved.name,
        workflowType: 'workflow',
        result,
      });
      result.dashboardUrl = validationResponse.dashboardUrl;
    }

    return result;
  }

  /**
   * Universal execution - auto-routes based on definition type
   *
   * **v0.8.0 Change:** Now handles agents directly (no longer throws).
   * For agents, uses default options from agent definition.
   *
   * @param name - Definition name with optional version
   * @param input - Execution input with target and options
   * @returns Execution result (type-discriminated)
   */
  async run(name: string, input: ExecutionInput): Promise<ExecutionResult> {
    const resolved = await this.registry.resolve(name);
    let result: ExecutionResult;

    switch (resolved.type) {
      case 'agent':
        // v0.8.0: Direct agent execution is now supported
        result = await this.agentExecutor.execute(resolved, input);
        break;

      case 'command':
        result = await this.commandExecutor.execute(resolved, input);
        break;

      case 'workflow':
        result = await this.workflowExecutor.execute(resolved, input);
        break;

      case 'pipeline':
        result = await this.pipelineExecutor.execute(resolved, input);
        break;

      default:
        throw new Error(`Unknown execution type: ${resolved.type}`);
    }

    // Submit to validation service and get dashboard URL
    if (this.config.trackingEnabled) {
      const validationResponse = await this.validation.submit({
        project: this.config.defaultProject ?? resolved.name,
        workflowType: resolved.type,
        result,
      });
      result.dashboardUrl = validationResponse.dashboardUrl;
    }

    return result;
  }

  /**
   * Start async pipeline execution
   */
  async startPipeline(name: string, input: ExecutionInput): Promise<PipelineHandle> {
    const resolved = await this.registry.resolve(name);

    if (resolved.type !== 'pipeline') {
      throw new Error(`${name} is not a pipeline (type: ${resolved.type})`);
    }

    return this.pipelineExecutor.start(resolved, input);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Convenience methods (type-safe shortcuts)
  // ───────────────────────────────────────────────────────────────────────────

  async validate(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('validate', { target, options });
  }

  async security(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('security', { target, options });
  }

  async optimize(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('optimize', { target, options });
  }

  async ship(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('ship', { target, options });
  }

  async postImplementation(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('post-implementation', { target, options });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Discovery
  // ───────────────────────────────────────────────────────────────────────────

  async list(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    return this.registry.list(filter);
  }

  async describe(name: string): Promise<{
    type: DefinitionType;
    name: string;
    version: string;
    hash: string;
    interface: unknown;
  }> {
    const resolved = await this.registry.resolve(name);
    return {
      type: resolved.type,
      name: resolved.name,
      version: resolved.version,
      hash: resolved.hash,
      interface: this.extractInterface(resolved.definition),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Validation & Metrics (delegates to ValidationClient)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Get project summary with aggregated metrics
   */
  async getProjectSummary(project: string): Promise<ProjectSummary> {
    return this.validation.getProjectSummary(project);
  }

  /**
   * Get run history for a project
   */
  async getHistory(project: string, options?: { workflowType?: string; limit?: number }): Promise<RunHistoryEntry[]> {
    return this.validation.getHistory(project, options);
  }

  /**
   * Get issue trends over time
   */
  async getIssueTrends(project: string, days?: number): Promise<{
    trends: TrendEntry[];
    summary: TrendSummary;
  }> {
    return this.validation.getIssueTrends(project, days);
  }

  /**
   * Get aggregated metrics for CLI display
   */
  async getMetricsSummary(project: string, options?: { days?: number }): Promise<MetricsSummary> {
    const [summary, trends, analytics] = await Promise.all([
      this.validation.getProjectSummary(project),
      this.validation.getIssueTrends(project, options?.days || 30),
      this.validation.getAnalytics('cost_analysis', { project, days: options?.days || 30 }),
    ]);

    const costData = analytics as { totalCost: number; totalTokens: number; avgCostPerRun: number };

    return {
      totalRuns: summary.stats.totalRuns,
      averageScore: trends.summary.averageNew,
      passRate: this.calculatePassRate(summary),
      totalTokens: costData.totalTokens,
      totalCost: costData.totalCost,
      avgCostPerRun: costData.avgCostPerRun,
      scoreTrend: trends.summary.trendDirection,
      scoreTrendDelta: trends.summary.netChange,
    };
  }

  private calculatePassRate(summary: ProjectSummary): number {
    return summary.stats.totalRuns > 0
      ? ((summary.stats.totalRuns - summary.stats.criticalIssues) / summary.stats.totalRuns) * 100
      : 0;
  }

  /**
   * Search issues across projects
   */
  async searchIssues(query: string, options?: {
    projects?: string[];
    validators?: string[];
    status?: 'open' | 'completed' | 'all';
    limit?: number;
  }): Promise<IssueSearchResult[]> {
    return this.validation.searchIssues(query, options);
  }

  /**
   * Update issue status
   */
  async updateIssueStatus(
    project: string,
    fingerprint: string,
    status: 'open' | 'completed' | 'wontfix' | 'deferred',
    reason?: string
  ): Promise<{ id: string; previousStatus: string; newStatus: string }> {
    return this.validation.updateIssueStatus(project, fingerprint, status, reason);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pipeline monitoring (used by PipelineHandle)
  // ───────────────────────────────────────────────────────────────────────────

  async getPipelineStatus(executionId: string): Promise<PipelineResult> {
    return this.pipelineExecutor.getStatus(executionId);
  }

  async cancelPipeline(executionId: string): Promise<void> {
    return this.pipelineExecutor.cancel(executionId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  private validateConfig(config: UluOpsConfig): ResolvedConfig {
    const apiKey = config.apiKey || process.env.ULUOPS_API_KEY || process.env.ULU_API_KEY;

    if (!apiKey) {
      throw new Error(
        'UluOps API key is required. Provide via config.apiKey, ULUOPS_API_KEY, or ULU_API_KEY environment variable.'
      );
    }

    return {
      apiKey,
      registryUrl: config.registryUrl || process.env.ULUOPS_REGISTRY_URL || 'https://registry.uluops.ai/api',
      validationUrl: config.validationUrl || process.env.ULUOPS_VALIDATION_URL || 'https://ops.uluops.ai/api',
      dashboardUrl: config.dashboardUrl || process.env.ULUOPS_DASHBOARD_URL || 'https://app.uluops.ai',
      localDefinitions: config.localDefinitions || process.env.ULUOPS_LOCAL_DEFINITIONS,
      trackingEnabled: config.trackingEnabled ?? (process.env.ULUOPS_TRACKING_ENABLED !== 'false'),
      hashVerificationEnabled: config.hashVerificationEnabled ?? true,
      timeout: config.timeout || 300000,
      modelOverride: config.modelOverride,
      defaultProject: config.defaultProject || process.env.ULUOPS_PROJECT,
    };
  }

  private extractInterface(definition: any): unknown {
    if ('agent' in definition) return definition.agent.interface;
    if ('command' in definition) return definition.command.interface;
    if ('workflow' in definition) return definition.workflow.interface;
    if ('pipeline' in definition) return definition.pipeline.interface;
    return {};
  }
}
```

---

## Public Exports

```typescript
// src/index.ts

// Main client
export { UluOpsClient } from './client/UluOpsClient';
export { PipelineHandle } from './client/PipelineHandle';

// Executors (for advanced usage)
export { AgentExecutor } from './executor/AgentExecutor';  // New in v0.8.0
export { CommandExecutor } from './executor/CommandExecutor';
export { WorkflowExecutor } from './executor/WorkflowExecutor';
export { PipelineExecutor } from './executor/PipelineExecutor';
export { ToolHandler } from './executor/ToolHandler';

// Service Clients
export { RegistryClient } from './registry/RegistryClient';
export { ValidationClient } from './validation/ValidationClient';

// AI SDK Integration
export { AIProvider } from './ai/AIProvider';
export type { GenerateResult, GenerateOptions, ModelAlias } from './ai/AIProvider';
export { ToolAdapter } from './ai/ToolAdapter';

// Utilities
export { OutputExtractor } from './parser/OutputExtractor';

// Types - Config
export type { UluOpsConfig, ResolvedConfig } from './types/config';

// Types - Execution
export type {
  DefinitionType,
  ExecutionType,
  Domain,
  AgentType,
  ExecutionInput,
  ExecutionResult,
  ExecutionMetrics,
  ExecutionOptions,           // New in v0.8.0
  ResolvedExecutionContext,   // New in v0.8.0
  Recommendation,
} from './types/execution';

// Types - Agent
export type {
  AgentDefinition,
  AgentCategory,
  AgentTask,
  AgentResult,                // New in v0.8.0
  ValidatorAgentResult,       // New in v0.8.0
  ExecutorAgentResult,        // New in v0.8.0
} from './types/agent';

// Types - Claude (kept for backward compat reference, internal to AI SDK now)
// ClaudeRequest and ClaudeResponse replaced by AI SDK's generateText interface
// Use GenerateOptions and GenerateResult from './ai/AIProvider' instead

// Types - Command
export type {
  CommandDefinition,
  CommandResult,
  CommandMetrics,
  CategoryResult,
  Finding,
  Issue,
  ArtifactResult,
  PreflightCheck,
  PostflightAction,
} from './types/command';

// Types - Workflow
export type {
  WorkflowDefinition,
  WorkflowResult,
  WorkflowMetrics,
  PhaseDefinition,
  PhaseResult,
  CommandMetricsSummary,
} from './types/workflow';

// Types - Pipeline
export type {
  PipelineDefinition,
  PipelineResult,
  PipelineMetrics,
  StageDefinition,
  StageResult,
  TriggerDefinition,
  TriggerInfo,
  PipelineArtifact,
  PipelineHandle,
} from './types/pipeline';

// Types - Registry
export type {
  ResolvedDefinition,
  DefinitionSummary,
  Reference,
} from './types/registry';

// Types - Validation
export type {
  RunSubmission,
  RunSubmissionResponse,
  RunHistoryEntry,
  ValidationQueryOptions,
  FingerprintedRecommendation,
  RegressionInfo,
} from './types/validation';

// Types - Parser
export type {
  ParsedOutput,
  ParsedCategory,
  ParsedFinding,
  ExtractionOptions,
  ExtractionResult,
} from './types/parser';

// Types - Tools
export type { Tool, ToolUseBlock, ToolResult } from './types/tools';

// Errors - Core SDK
export {
  UluOpsError,
  ExecutionError,
  PreflightError,
  HashVerificationError,
  ValidationError,
  ValidationErrorCodes,
  WorkflowError,
  PipelineError,
  ParseError,
} from './errors';

// Errors - Re-exported from @uluops/sdk-core (HTTP errors)
export {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
} from './errors';
```

---

## Usage Examples

### Basic Validation

```typescript
import { UluOpsClient } from '@uluops/core';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
});

// Simple validation (runs a command)
const result = await client.validate('./src');

console.log(`Score: ${result.score}/${result.maxScore}`);
console.log(`Decision: ${result.decision}`);
console.log(`Issues: ${result.recommendations.length}`);
console.log(`Definition hash: ${result.definitionHash}`);

if (result.decision === 'FAIL') {
  process.exit(1);
}
```

### Direct Agent Execution (v0.8.0)

```typescript
import { UluOpsClient } from '@uluops/core';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
});

// Direct agent execution with call-time options
const result = await client.runAgent('code-validator', './src', {
  model: 'opus',                    // Override model
  thresholds: { pass: 80, warn: 60 }, // Override thresholds
  project: 'my-api',                // For tracking
});

// Result is discriminated by agentType
if (result.agentType === 'validator') {
  console.log(`Score: ${result.score}/${result.maxScore}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Categories: ${result.categories?.length}`);
}

// Compare: runCommand() uses saved configuration
const cmdResult = await client.runCommand('validate', { target: './src' });
// Uses model, thresholds from command definition
```

### Universal Run (Auto-Routing)

```typescript
// The run() method auto-detects the type and routes appropriately
const commandResult = await client.run('validate', { target: './src' });
const workflowResult = await client.run('ship', { target: './packages/api' });
const pipelineResult = await client.run('ci-validation', { target: '.' });

// Type narrows based on result.type
if (commandResult.type === 'command') {
  console.log(`Agent type: ${commandResult.agentType}`);
  if (commandResult.agentType === 'validator') {
    console.log(`Categories: ${commandResult.categories?.length}`);
  }
}

if (workflowResult.type === 'workflow') {
  console.log(`Phases: ${workflowResult.phases.length}`);
}

// v0.8.0: Agents are now directly executable via run()
const agentResult = await client.run('code-validator', { target: './src' });
if (agentResult.type === 'agent') {
  console.log(`Agent result: ${agentResult.decision}`);
}
```

### Workflow Execution

```typescript
const result = await client.ship('./packages/api', {
  skip_security: false,
});

console.log(`Ship decision: ${result.decision}`);
console.log(`Phases executed: ${result.metrics.phasesExecuted}`);

for (const phase of result.phases) {
  console.log(`  ${phase.name}: ${phase.decision} (${phase.score})`);
}

// Access consolidated recommendations with fingerprints
console.log(`\nTotal issues: ${result.recommendations.length}`);
for (const rec of result.recommendations.filter(r => r.priority === 'critical')) {
  console.log(`  [CRITICAL] ${rec.title} - ${rec.filePath}:${rec.lineNumber}`);
  console.log(`    Fingerprint: ${rec.fingerprint}`);
  console.log(`    Status: ${rec.status}`);
}
```

### Local Development (No Remote Registry)

```typescript
const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
  
  // Point to local definition files for development
  localDefinitions: './.uluops/',
});

// SDK will look for (in order):
//   ./.uluops/validate.command.yaml
//   ./.uluops/commands/validate.command.yaml
// before falling back to remote registry

const result = await client.validate('./src');
```

### Hash Verification

```typescript
const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
  hashVerificationEnabled: true, // Default: true
});

// SDK automatically verifies definition hashes
// If mismatch detected, throws HashVerificationError

try {
  const result = await client.validate('./src');
  console.log(`Verified definition hash: ${result.definitionHash}`);
} catch (error) {
  if (error instanceof HashVerificationError) {
    console.error('Definition integrity check failed!');
    console.error(error.message);
  }
}
```

### Error Handling with Partial Results

```typescript
import { UluOpsClient, WorkflowError, PreflightError, HashVerificationError } from '@uluops/core';

try {
  const result = await client.ship('./src');
} catch (error) {
  if (error instanceof PreflightError) {
    console.error(`Preflight failed: ${error.message}`);
    process.exit(error.exitCode);
  }

  if (error instanceof HashVerificationError) {
    console.error(`Definition integrity failed: ${error.message}`);
    process.exit(2);
  }

  if (error instanceof WorkflowError) {
    console.error(`Workflow failed: ${error.message}`);
    
    // Access partial results from completed phases
    const partial = error.context.partialResult;
    console.log(`Completed ${partial.phases?.length || 0} phases before failure`);
    
    for (const phase of partial.phases || []) {
      console.log(`  ${phase.name}: ${phase.decision}`);
    }
  }
}
```

### Filtering Definitions by Domain

```typescript
// List only software-domain validators
const validators = await client.list({ 
  type: 'command',
  domain: 'software' 
});

for (const v of validators) {
  console.log(`${v.name} (${v.agentType}): ${v.description}`);
}

// List financial domain definitions
const financial = await client.list({ domain: 'financial' });
```

### Querying Run History

```typescript
// Access validation service directly for history queries
import { ValidationClient } from '@uluops/core';

const validationClient = new ValidationClient({
  apiKey: process.env.ULUOPS_API_KEY!,
  validationUrl: 'https://ops.uluops.ai/api',
  trackingEnabled: true,
  hashVerificationEnabled: true,
  timeout: 300000,
});

// Get recent runs for a project
const history = await validationClient.getHistory({
  project: 'my-api',
  limit: 10,
});

for (const run of history) {
  console.log(`${run.createdAt}: ${run.definitionName} - ${run.decision} (${run.score})`);
}

// Get issue trends
const trends = await validationClient.getIssueTrends('my-api', 30);
for (const day of trends) {
  console.log(`${day.date}: ${day.total} issues (${day.new} new, ${day.resolved} resolved)`);
}
```

---

## Error Classes

```typescript
// src/errors/index.ts

export class UluOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UluOpsError';
  }
}

export class ExecutionError extends UluOpsError {
  constructor(
    message: string,
    public readonly partialResult?: unknown
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export class PreflightError extends UluOpsError {
  constructor(
    message: string,
    public readonly check: string,
    public readonly exitCode: number = 1
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

export class HashVerificationError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'HashVerificationError';
  }
}

/**
 * Error codes for validation service errors
 * These align with the Validation API's error response codes
 */
export const ValidationErrorCodes = {
  /** Generic validation error */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Resource not found */
  NOT_FOUND: 'NOT_FOUND',
  /** Duplicate/conflict error */
  CONFLICT: 'CONFLICT',
  /** Rate limit exceeded */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Request failed after retries */
  REQUEST_FAILED: 'REQUEST_FAILED',
  /** Submission to validation service failed */
  SUBMISSION_FAILED: 'SUBMISSION_FAILED',
  /** Authentication failed */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Forbidden action */
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type ValidationErrorCode = typeof ValidationErrorCodes[keyof typeof ValidationErrorCodes];

export class ValidationError extends UluOpsError {
  /** Error code for programmatic handling */
  public readonly code?: ValidationErrorCode;

  constructor(message: string, code?: ValidationErrorCode) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export class WorkflowError extends UluOpsError {
  constructor(
    message: string,
    public readonly context: { partialResult: unknown }
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export class PipelineError extends UluOpsError {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports from @uluops/sdk-core
// ─────────────────────────────────────────────────────────────────────────────
// HTTP errors (RateLimitError, UnauthorizedError, ServiceUnavailableError, etc.)
// are handled by sdk-core's HttpClient and re-exported from errors/index.ts.
// See @uluops/sdk-core for the full error hierarchy.

export {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
} from '@uluops/sdk-core/errors';

// ─────────────────────────────────────────────────────────────────────────────
// Parser Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse error - failed to extract structured output from response
 *
 * Thrown when OutputExtractor cannot parse Claude's response in strict mode.
 * Contains the raw content that failed to parse for debugging.
 *
 * @example
 * ```typescript
 * try {
 *   const parsed = extractor.extract(content, 'validator', { strict: true });
 * } catch (error) {
 *   if (error instanceof ParseError) {
 *     console.error('Failed to parse:', error.contentPreview);
 *   }
 * }
 * ```
 */
export class ParseError extends UluOpsError {
  /**
   * Preview of content that failed to parse (first 500 chars)
   */
  readonly contentPreview: string;

  constructor(message: string, contentPreview: string) {
    super(message);
    this.name = 'ParseError';
    this.contentPreview = contentPreview;
  }
}
```

---

## Configuration Reference

See [Core Types > Configuration](#configuration) for the complete `UluOpsConfig` and `ResolvedConfig` interface definitions.

**Quick Reference:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | API key for authentication |
| `registryUrl` | `string` | `"https://registry.uluops.ai/api"` | Registry API base URL |
| `validationUrl` | `string` | `"https://ops.uluops.ai/api"` | Validation API base URL |
| `localDefinitions` | `string` | - | Local definitions directory |
| `trackingEnabled` | `boolean` | `true` | Enable validation service submission |
| `hashVerificationEnabled` | `boolean` | `true` | Enable definition hash verification |
| `timeout` | `number` | `300000` | Request timeout in ms |
| `modelOverride` | `'haiku' \| 'sonnet' \| 'opus'` | - | Override model for all executions |
| `defaultProject` | `string` | - | Default project name |

---

## Security Considerations

### API Key Management

- **Never commit API keys** - Use environment variables or secure secret management
- **Rotate keys periodically** - Recommended rotation every 90 days
- **Use scoped keys** - When available, use keys with minimal required permissions
- **Audit key usage** - Monitor dashboard for unexpected usage patterns

```typescript
// ✅ Good: Environment variable
const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
});

// ❌ Bad: Hardcoded key
const client = new UluOpsClient({
  apiKey: 'sk-ulu-xxx...',  // Never do this
});
```

### Definition Integrity

The SDK verifies definition integrity using SHA-256 hashes:

- **Hash verification enabled by default** - Set `hashVerificationEnabled: false` to disable
- **Hashes computed server-side** - Registry API computes normalized YAML hash
- **Verification on every fetch** - SDK recomputes and compares on receipt
- **Audit trail** - Definition hashes stored with each run in validation service

### Filesystem Access Security

The SDK restricts all filesystem access to the target directory:

- **Path traversal prevention** - All paths are resolved and validated against base directory
- **Symlink handling** - Symlinks are followed but must resolve within target directory
- **No system access** - Cannot read `/etc/`, home directories, or other system paths

### Network Security

- **TLS required** - All API communication uses HTTPS
- **Certificate validation** - Standard certificate chain validation is enforced
- **Separate service URLs** - Registry and validation services can be on different infrastructure

### Input Validation

- **Definition validation** - All YAML is schema-validated before execution
- **User input sanitization** - File paths and patterns are sanitized before use
- **Injection prevention** - Tool inputs are validated to prevent command injection

---

## Deferred Features

The following features are planned but deferred to future versions:

| Feature | Description | Target Version |
|---------|-------------|----------------|
| Tool allowlist/blocklist | Config-based path restrictions beyond base directory | v0.9.0 |
| Parallel phases | DAG-based workflow execution with parallel phases | v0.9.0 |
| WebSocket subscriptions | Real-time pipeline status updates | v0.9.0 |
| Version ranges | Support `^1.0.0` style version specs in refs | v0.9.0 |
| Trigger handling | Webhook/schedule-based pipeline triggers | v0.9.0 |
| Checkpoint/resume | Resume failed pipelines from last checkpoint | v0.9.0 |
| Per-tool-call metrics | Detailed tool call breakdown (currently per-command) | v0.9.0 |
| Definition signing | Cryptographic authorship verification | v1.0.0 |

---

## Migration Guide: v0.8.x → v0.9.0

### Breaking Changes

1. **`ClaudeAdapter` removed** → Use `AIProvider` instead. The tool loop is now handled by AI SDK's `maxSteps` parameter.

2. **Dependencies changed**: Remove `@anthropic-ai/sdk`, add `ai` + `@ai-sdk/anthropic`.

3. **`ClaudeRequest`/`ClaudeResponse` types removed** → Use `GenerateOptions`/`GenerateResult` from `AIProvider`.

4. **`AgentExecutor` constructor** now takes `AIProvider` instead of `ClaudeAdapter`.

### Migration Steps

```bash
# Update dependencies
npm uninstall @anthropic-ai/sdk
npm install ai @ai-sdk/anthropic
```

```typescript
// Before (v0.8.x)
import { ClaudeAdapter } from '@uluops/core';
const claude = new ClaudeAdapter(config);
const response = await claude.send(request);

// After (v0.9.0)
import { AIProvider } from '@uluops/core';
const provider = new AIProvider(config);
const result = await provider.generate({
  model: 'sonnet',
  system: prompt,
  prompt: message,
  tools: toolAdapter.getTools(),
  maxSteps: 50,
});
```

### New Features

- **`AIProvider`**: AI SDK-based provider with automatic tool loops
- **`ToolAdapter`**: Converts ToolHandler tools to AI SDK Zod-based format
- **Multi-provider support**: `provider: 'anthropic' | 'openai' | 'google'`
- **`AgentResult` discriminated union**: `ValidatorAgentResult` | `ExecutorAgentResult`
- **`PipelineHandle` class**: Concrete implementation for async pipeline monitoring

---

## Migration Guide: v0.7.x → v0.8.0

### Breaking Changes

1. **`createMessage()` → `send()`**: ClaudeAdapter's method renamed and now takes `ClaudeRequest` instead of `CreateMessageParams`.

2. **`runAgent()` signature changed**: Now takes `(name, target, options?)` instead of `(name, input)`. The options parameter provides call-time configuration.

3. **`run()` no longer throws on agents**: Previously threw an error for agent definitions. Now executes them directly using defaults.

### Migration Steps

```typescript
// Before (v0.7.x)
const result = await client.runAgent('code-validator', { target: './src' });

// After (v0.8.0)
const result = await client.runAgent('code-validator', './src', {
  model: 'opus',  // optional runtime options
});
```

```typescript
// Before (v0.7.x) - would throw
await client.run('code-validator', { target: './src' });
// Error: Agents are not directly executable...

// After (v0.8.0) - works
const result = await client.run('code-validator', { target: './src' });
```

### New Features

- **`ExecutionOptions`**: Call-time configuration for agent runs (model, thresholds, timeout)
- **`AgentExecutor`**: New primary executor for single-agent runs
- **`runCommand()`**: Explicit method for command execution
- **`runWorkflow()`**: Explicit method for workflow execution

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 0.9.0 | 2026-02-08 | **AI SDK integration + architecture review**: **Breaking**: (1) Replaced `ClaudeAdapter` with `AIProvider` backed by Vercel AI SDK v6, (2) `AgentExecutor` constructor now takes `AIProvider` instead of `ClaudeAdapter`, (3) Removed `ClaudeRequest`/`ClaudeResponse` types (replaced by `GenerateOptions`/`GenerateResult`), (4) Dependencies changed: removed `@anthropic-ai/sdk`, added `ai` + `@ai-sdk/anthropic` + `@uluops/sdk-core`, (5) Removed `RegistryError`, `ClaudeAPIError`, `AuthenticationError`, `ServerError` (use `@uluops/sdk-core` errors), (6) Removed `provider`/`providerApiKey` config (Anthropic-only for v0.1.0). **New**: (1) `AIProvider` class with `generateText()` and automatic `maxSteps` tool loops, (2) `ToolAdapter` class converts `ToolHandler` tools to AI SDK Zod-based format, (3) `AgentResult` discriminated union types, (4) `PipelineHandle` class implementation. **Architecture Review**: (1) RegistryClient and ValidationClient now use `@uluops/sdk-core` HttpClient for HTTP infrastructure, (2) ValidationClient reduced from ~25 methods to 4 core execution methods, (3) AIProvider simplified to Anthropic-only, (4) CommandExecutor `any` casts replaced with type predicates, (5) Error hierarchy aligned with sdk-core. **Fixed**: (1-10) All 10 spec bugs from v0.8.0 audit. |
| 0.8.0 | 2026-01-11 | **Direct agent execution release**: Elevates direct agent execution to first-class status. **Major Changes**: (1) New `AgentExecutor` class - primary execution engine for single-agent runs, handles prompt rendering and tool loop orchestration; (2) `ClaudeAdapter` is now prompt-agnostic - receives pre-rendered `ClaudeRequest`, renamed `createMessage()` → `send()`; (3) `CommandExecutor` delegates single-agent commands to `AgentExecutor`, only handles multi-agent aggregation directly; (4) `UluOpsClient.runAgent()` signature changed to `(name, target, options?)` with call-time `ExecutionOptions`; (5) `UluOpsClient.run()` now handles agents directly (no longer throws); (6) Removed `createEphemeralCommand()` workaround. **New Types**: `ExecutionOptions`, `ResolvedExecutionContext`, `ClaudeRequest`, `ClaudeResponse`, `AgentResult`, `ValidatorAgentResult`, `ExecutorAgentResult`. **New Methods**: `runCommand()`, `runWorkflow()` for explicit type-safe execution. **Public Exports**: Added `AgentExecutor`, `ExecutionOptions`, `ClaudeRequest`, `ClaudeResponse`, `AgentResult`. **Updated Deferred Features**: Bumped remaining v0.8.0 targets to v0.9.0. **Documentation**: Added Migration Guide section. **P3 Audit Fix (cli-spec-audit.md)**: Fixed architecture diagram version v0.7.3 → v0.8.0. |
| 0.8.0 | 2026-01-11 | **Audit polish release**: **P1**: (1) Updated deferred features target versions from v0.7.0 to v0.8.0+ (all stale targets refreshed). **P2**: (1) Consolidated Configuration Reference section to reference Core Types instead of duplicating interface definition, (2) Verified `archiveRuns()`, `searchIssues()`, `addIssueNote()` implementations already present. **P3**: (1) Added `getAnalytics(metric, options)` for generic analytics queries, (2) Added `getValidatorReliability(options)` for validator effectiveness metrics, (3) Added `getTaxonomy()` for failure taxonomy schema. **New Types**: `AnalyticsMetric`, `ValidatorReliability`, `TaxonomySchema`. |
| 0.7.3 | 2026-01-11 | **Validation API full alignment audit fixes**: **P0**: (1) `RunSubmission` type now matches API expected format with `project`, `workflow_type`, `validators[]`, `recommendations[]`, (2) `RunSubmissionResponse` aligned with API response structure including `newIssues`, `recurringIssues`, `regressions`. **P1**: (1) `getIssueTrends()` now returns `{trends, summary}` instead of raw array, (2) Added idempotency key support to `submit()`, (3) `listProjects()` returns proper `Project[]` type with unwrapped response, (4) `getProjectSummary()` returns `ProjectSummary` with unwrapped response, (5) `RunHistoryEntry` expanded with all API fields (runNumber, projectId, workflowType, allGatesPassed, etc). **P2**: (1) Fixed health check name `validation-tracker-api` → `uluops-validation-api`, (2) Added SDK methods: `validateRun()`, `compareRuns()`, `archiveRuns()`, `searchIssues()`, `addIssueNote()`, (3) Documented case convention transformations (SDK camelCase ↔ API snake_case), (4) Added `'merged'` to `IssueStatus` enum. **P3**: (1) Added comprehensive JSDoc to all `ValidationClient` methods with examples, (2) Added `ValidationErrorCodes` constants, (3) Added `validator` field to `Recommendation` interface (deprecated `command`). **New Types**: `ValidatorSnapshot`, `RecommendationPayload`, `ValidationRunRequest`, `ValidationAPIRunResponse`, `CorrelatedIssue`, `Project`, `ProjectSummary`, `TrendEntry`, `TrendSummary`, `IssueSearchResult`, `RunDiffResult`. |
| 0.7.2 | 2026-01-11 | **Validation API cross-reference alignment**: (1) `getHistory()` now uses path-based routing `/v1/runs/project/{project}` to match API, (2) `updateIssueStatus()` uses fingerprint-based endpoint `/v1/issues/by-fingerprint/{fingerprint}/status?project={project}`, (3) Status enum changed: `'resolved'` → `'completed'` to match API, (4) `ValidationQueryOptions` updated with `workflowType` replacing deprecated `definition`/`since`/`until` fields. |
| 0.7.1 | 2026-01-11 | **Post-release audit fixes**: (P0-1) Updated architecture diagram version to v0.7.1, (P0-2) Updated SDK_VERSION constant to 0.7.1, (P1-1) Added `'event'` to TriggerConfig.type for registry alignment, (P1-2) Added `'skip_dependents'` to WorkflowRuntime.onFailure, (P1-3) Added `on_fail` to PhaseConfig.gate. |
| 0.7.0 | 2026-01-11 | **Minor version bump**: Cross-spec audit complete. All P0/P1/P2 issues resolved. SDK and Registry specs are fully aligned. |
| 0.6.2 | 2026-01-11 | **Cross-spec audit fixes (P0/P1/P2)**: **P0**: (1) PreflightCheck field `envVar` → `var` to match registry, (2) PreflightCheck check type `command_exists` → `command`, removed `custom` type, (3) Fixed executor decision normalization bug - now returns `COMPLETE` instead of `SUCCESS`, (5) Fixed `renderCommandPrompt` to use `agents.join()` instead of `agents.map(a => a.ref)`. **P1**: (12) Added missing `ValidatorRuntime`/`ExecutorRuntime` imports to CommandExecutor, (13) Fixed `extractAgentType` for commands - returns undefined since agent type is determined at runtime from resolved agents. **Naming consistency**: Renamed `trackerUrl` → `validationUrl` with default `https://ops.uluops.ai/api`, renamed `TrackerClient` → `ValidationClient`, renamed `TrackerError` → `ValidationError`, renamed `TrackerQueryOptions` → `ValidationQueryOptions`, renamed `tracker/` folder to `validation/`, renamed `types/tracker.ts` to `types/validation.ts`, updated all internal variable names and comments to use "validation" instead of "tracker". **P2**: (15) Renamed `DefinitionReference` → `Reference` to match Registry naming. |
| 0.6.1 | 2026-01-11 | **Cross-spec audit alignment**: **P0**: (1) Renamed `agent-registry-api` → `uluops-registry-api` and `validation-tracker-api` → `uluops-validation-api` for consistent branding, (2) Fixed registryUrl default missing `/api` suffix, (3) Changed `CommandDefinition.agents` from object array to simple string array to match registry CDL, (4) Aligned `PreflightCheck` schema: `type` → `check` with type-specific fields (`path`, `command`, `envVar`). **P1**: (5) Added explicit `type: 'workflow' \| 'command'` to `StageDefinition` (removed unreliable inference), (6) Updated executor decision values `SUCCESS` → `COMPLETE`, (7) Added `type?: 'validate' \| 'execute' \| 'mixed'` and `inputs` to `PhaseDefinition`, (8) Implemented `runAgent()` with `createEphemeralCommand()` for direct agent invocation, (9) Completed `buildResult()` with `definitionHash`, `score`, `recommendations`, and `computePipelineDecision()`. **P2**: (13) Updated deferred features target versions from v0.6.0 to v0.7.0+, (14) Consolidated `PipelineState` to single definition in types section. |
| 0.6.0 | 2026-01-11 | **P2 audit fixes (polish release)**: (21) Standardized timeout units to "ms" throughout, (22) Added JSDoc to all content block interfaces, (23) ExecutionError now passes partial results (finalContent, totalUsage, toolCallCount) when thrown, (24) Consolidated model resolution - CommandExecutor now uses ClaudeAdapter.resolveModel() instead of duplicate modelMap, (25) Added Decision Domains documentation explaining different decision vocabularies across contexts, (26) Added fetchWithRetry helper to RegistryClient and ValidationClient with exponential backoff for rate limits (429) and server errors (5xx). |
| 0.5.0 | 2026-01-11 | **Registry API alignment + P0/P1 audit fixes**: Fixed RegistryClient endpoint pattern to include `:type` in URL path per registry spec. Added type parameter to resolve(). Updated CommandDefinition to use `agents` array instead of single `agent` (supports multi-agent commands with aggregation). Added ValidatorRuntime, ExecutorRuntime, and 15+ supporting types for type-safe runtime access. Added comprehensive JSDoc to all executor classes. Added missing PipelineExecutor section with full implementation. Updated composition rules to match registry spec. **P0 Audit Fixes**: (1) Fixed version in architecture diagram, (2) Fixed ValidationClient SDK_VERSION, (3) Added thresholds to CommandDefinition.execution, (4) Fixed PipelineExecutor.executeSync → execute, (5) Fixed registryUrl default to include /api path, (6) Added PipelineExecutor.getStatus() and cancel() methods, (7) Aligned StageDefinition with types (skip_if, removed inline definition), (8) Fixed runtime type access via .prompt property, (9) Added ValidationClient.deleteRun/listProjects/getProjectSummary/updateIssueStatus, (10) Updated deferred features target versions. **P1 Audit Fixes**: (13) Aligned file extension convention with registry spec, (14) Added ClaudeAdapter class with Claude 4.5 model support, retry logic with exponential backoff, typed error handling (ClaudeAPIError, RateLimitError, AuthenticationError, ServerError), and model alias resolution, (15) Added OutputExtractor class with multi-strategy parsing (JSON code fence, inline JSON, structured text fallback), confidence scoring, and ParseError for strict mode, (16) Fixed PipelineHandle constructor - return executor result directly, (17) Added PipelineState to types section, (18-19) Standardized aggregation methods to `average\|weighted_average\|min\|max\|sum`, (20) Added type and skipReason fields to StageResult. |
| 0.4.0 | 2026-01-11 | **Major alignment update**: Introduced Agent/Command distinction matching registry spec. Agents are no longer directly executable - they must be wrapped in Commands. Updated file extensions (`.agent.yaml`, `.command.yaml`, etc.). Added ValidationClient implementation. Added hash verification. Added domain/agentType classification. Fixed config schema consistency. Aligned API endpoints with registry spec. Updated terminology throughout (AgentExecutor → CommandExecutor, etc.). Added comprehensive tracker types. |
| 0.3.0 | 2026-01-11 | Two-service architecture: SDK delegates to `uluops-registry-api` and `uluops-validation-api`. Removed fingerprint generation from SDK. |
| 0.2.0 | 2026-01-10 | Multi-type execution (agents, workflows, pipelines), tool loop architecture, local definitions support, partial results on error |
| 0.1.0 | 2026-01-10 | Initial SDK structure specification |
