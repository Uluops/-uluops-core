# @uluops/core AI SDK Integration Specification

**Version:** 0.1.0  
**Status:** Draft  
**Created:** 2026-01-30  
**Parent Spec:** uluops-core-sdk-spec-v0.8.0  
**Dependency:** Vercel AI SDK v6.x

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Motivation](#motivation)
- [Architecture Changes](#architecture-changes)
  - [Before/After Comparison](#beforeafter-comparison)
  - [What Gets Replaced](#what-gets-replaced)
  - [What Stays the Same](#what-stays-the-same)
- [Dependencies](#dependencies)
- [Type Mappings](#type-mappings)
  - [Tool Definition Conversion](#tool-definition-conversion)
  - [Message Format Conversion](#message-format-conversion)
  - [Error Mapping](#error-mapping)
  - [Usage Metrics Mapping](#usage-metrics-mapping)
- [Implementation](#implementation)
  - [AIProvider Class](#aiprovider-class)
  - [ToolAdapter Class](#tooladapter-class)
  - [AgentExecutor Refactoring](#agentexecutor-refactoring)
- [Configuration Changes](#configuration-changes)
- [Migration Guide](#migration-guide)
- [Future Considerations](#future-considerations)
- [Revision History](#revision-history)

---

## Executive Summary

This specification defines the integration of Vercel AI SDK v6.x into `@uluops/core` to replace the custom `ClaudeAdapter` implementation. The integration leverages AI SDK's battle-tested LLM communication layer while preserving UluOps's unique validation infrastructure (Registry, Validation tracking, definition hierarchy, quality gates).

**Key Benefits:**
- Delete ~500 lines of retry/error/streaming code
- Gain multi-provider support (Claude, GPT, Gemini, etc.)
- Built-in tool loop management (`maxSteps`)
- Better TypeScript types from a mature library
- Future access to UI hooks, streaming, and DevTools
- Protection against Claude API changes

**Non-Goals:**
- Replace UluOps orchestration (Command/Workflow/Pipeline executors)
- Replace ToolHandler filesystem sandboxing
- Replace OutputExtractor parsing logic
- Replace Registry or Validation clients

---

## Motivation

### Current State (ClaudeAdapter)

The existing `ClaudeAdapter` class (~200 lines) handles:
- Model alias resolution (`sonnet` → `claude-sonnet-4-20250514`)
- API request/response cycle via `@anthropic-ai/sdk`
- Retry logic with exponential backoff
- Error classification and mapping

The `AgentExecutor` separately manages:
- Tool loop orchestration (manual 50-iteration loop)
- Usage accumulation across turns
- Timeout handling

### Pain Points

1. **Duplicate infrastructure** — Vercel AI SDK solves the same problems better
2. **Claude-only** — No path to multi-provider without rewriting
3. **Manual tool loop** — ~90 lines of iteration logic that AI SDK handles natively
4. **Untested edge cases** — Our code has 0 production hours; AI SDK has 20M+ monthly downloads

### Why AI SDK v6?

- **ToolLoopAgent** — Native multi-step tool execution with `maxSteps`
- **Unified provider interface** — Switch models by changing one string
- **MCP alignment** — Tool schemas now use `inputSchema` matching MCP spec
- **Stable structured outputs** — Unified `generateText` with tool calling
- **Active development** — Vercel core team + large community

---

## Architecture Changes

### Before/After Comparison

```
BEFORE (Current v0.8.0)
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│                           @uluops/core                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  AgentExecutor                                                          │
│  ├── Prompt rendering                                                   │
│  ├── Manual tool loop (50 iterations)  ◄── REPLACED                    │
│  ├── Usage accumulation                ◄── REPLACED                    │
│  └── Output parsing                                                     │
│                                                                         │
│  ClaudeAdapter                          ◄── DELETED                    │
│  ├── @anthropic-ai/sdk                  ◄── DELETED                    │
│  ├── Model alias resolution             ◄── REPLACED                    │
│  ├── Retry logic                        ◄── DELETED                    │
│  └── Error mapping                      ◄── REPLACED                    │
│                                                                         │
│  ToolHandler                                                            │
│  ├── Tool definitions (Anthropic format)◄── CONVERTED                  │
│  └── Filesystem operations              (unchanged)                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘


AFTER (v0.9.0 with AI SDK)
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│                           @uluops/core                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  AgentExecutor                                                          │
│  ├── Prompt rendering                   (unchanged)                     │
│  ├── AIProvider.generate()              ◄── NEW (delegates to AI SDK)  │
│  └── Output parsing                     (unchanged)                     │
│                                                                         │
│  AIProvider                             ◄── NEW (~100 lines)           │
│  ├── Provider selection (anthropic/openai/google)                       │
│  ├── Model resolution                                                   │
│  └── generateText() wrapper                                             │
│                                                                         │
│  ToolAdapter                            ◄── NEW (~50 lines)            │
│  └── Convert ToolHandler → AI SDK tools                                 │
│                                                                         │
│  ToolHandler                                                            │
│  ├── Tool definitions (unchanged internally)                            │
│  └── Filesystem operations              (unchanged)                     │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Vercel AI SDK v6                               │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │  │
│  │  │  generateText() │  │  @ai-sdk/       │  │  Tool loop      │   │  │
│  │  │  with maxSteps  │  │  anthropic      │  │  orchestration  │   │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### What Gets Replaced

| Component | Lines | Replacement |
|-----------|-------|-------------|
| `ClaudeAdapter` | ~200 | `AIProvider` (~100 lines) |
| `ClaudeAdapter.withRetry()` | ~50 | AI SDK built-in retry |
| `ClaudeAdapter.mapError()` | ~40 | `AIProvider.mapError()` (~20 lines) |
| `AgentExecutor.executeToolLoop()` | ~90 | AI SDK `maxSteps` parameter |
| Tool type conversion | 0 | `ToolAdapter` (~50 lines) |
| **Total removed** | **~380** | **~170 new** |

**Net reduction: ~210 lines of custom code**

### What Stays the Same

| Component | Reason |
|-----------|--------|
| `RegistryClient` | UluOps-specific definition storage |
| `ValidationClient` | UluOps-specific result tracking |
| `ToolHandler` | Validation-specific sandboxing |
| `OutputExtractor` | UluOps output format parsing |
| `CommandExecutor` | Multi-agent aggregation logic |
| `WorkflowExecutor` | Phase/gate orchestration |
| `PipelineExecutor` | Stage management |
| All definition types | ADL/CDL/WDL/PDL unchanged |

---

## Dependencies

### New Dependencies

```json
{
  "dependencies": {
    "ai": "^6.0.0",
    "@ai-sdk/anthropic": "^1.0.0"
  }
}
```

### Optional Provider Dependencies

```json
{
  "optionalDependencies": {
    "@ai-sdk/openai": "^1.0.0",
    "@ai-sdk/google": "^1.0.0"
  }
}
```

### Removed Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.x.x"  // REMOVED
  }
}
```

---

## Type Mappings

### Tool Definition Conversion

**Current UluOps Tool Format (Anthropic-native):**

```typescript
// src/types/tools.ts (current)
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
```

**AI SDK Tool Format:**

```typescript
// AI SDK v6 tool format
import { tool } from 'ai';
import { z } from 'zod';

const readFileTool = tool({
  description: 'Read the contents of a file',
  parameters: z.object({
    path: z.string().describe('File path relative to target directory'),
  }),
  execute: async ({ path }) => {
    // Implementation
  },
});
```

**ToolAdapter Conversion:**

```typescript
// src/ai/ToolAdapter.ts

import { tool, CoreTool } from 'ai';
import { z } from 'zod';
import type { ToolHandler, ToolResult } from '../types';

/**
 * Converts UluOps ToolHandler to AI SDK tool format
 * 
 * AI SDK v6 uses Zod schemas for input validation and type inference.
 * This adapter bridges the gap between ToolHandler's JSON Schema format
 * and AI SDK's Zod-based tool definitions.
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

### Message Format Conversion

**Current UluOps Format:**

```typescript
interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}
```

**AI SDK Format:**

```typescript
import type { CoreMessage } from 'ai';

// AI SDK uses CoreMessage which is compatible
type CoreMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | Array<TextPart | ToolCallPart | ToolResultPart>;
};
```

**Conversion is minimal** — AI SDK's message format is a superset. The `AIProvider` wrapper handles any necessary transformations.

### Error Mapping

**Current UluOps Errors:**

```typescript
// Current error hierarchy
ClaudeAPIError          // Base class
├── RateLimitError      // 429, retryable
├── AuthenticationError // 401, not retryable
└── ServerError         // 5xx, retryable
```

**AI SDK Errors:**

```typescript
// AI SDK error types (from ai package)
import { APICallError, RetryError } from 'ai';
```

**Mapping Implementation:**

```typescript
// src/ai/AIProvider.ts

import { APICallError, RetryError } from 'ai';
import {
  ClaudeAPIError,
  RateLimitError,
  AuthenticationError,
  ServerError,
} from '../errors';

/**
 * Map AI SDK errors to UluOps error types
 * 
 * Preserves existing error contract for consumers while
 * delegating to AI SDK's error handling internally.
 */
private mapError(error: unknown): ClaudeAPIError {
  // AI SDK wraps provider errors
  if (error instanceof APICallError) {
    const status = error.statusCode ?? 0;
    
    if (status === 429) {
      // Extract retry-after from headers if available
      const retryAfter = this.parseRetryAfter(error);
      return new RateLimitError(
        `Rate limit exceeded: ${error.message}`,
        retryAfter,
        error
      );
    }
    
    if (status === 401 || status === 403) {
      return new AuthenticationError(
        `Authentication failed: ${error.message}`,
        error
      );
    }
    
    if (status >= 500) {
      return new ServerError(
        `Server error: ${error.message}`,
        status,
        error
      );
    }
    
    return new ClaudeAPIError(
      error.message,
      status,
      false,
      error
    );
  }
  
  // AI SDK retry exhaustion
  if (error instanceof RetryError) {
    return new ClaudeAPIError(
      `Retries exhausted: ${error.message}`,
      0,
      false,
      error
    );
  }
  
  // Unknown error
  return new ClaudeAPIError(
    error instanceof Error ? error.message : String(error),
    0,
    false
  );
}
```

### Usage Metrics Mapping

**Current UluOps Format:**

```typescript
interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

**AI SDK Format:**

```typescript
// AI SDK usage from generateText result
interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Provider-specific usage (Anthropic)
interface AnthropicUsage extends Usage {
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}
```

**Mapping:**

```typescript
/**
 * Convert AI SDK usage to UluOps format
 */
private mapUsage(usage: Usage, providerMetadata?: unknown): UsageMetrics {
  const base = {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
  };

  // Extract Anthropic-specific cache metrics if available
  const anthropicMeta = providerMetadata as {
    anthropic?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
  };

  if (anthropicMeta?.anthropic) {
    return {
      ...base,
      cache_creation_input_tokens: anthropicMeta.anthropic.cacheCreationInputTokens,
      cache_read_input_tokens: anthropicMeta.anthropic.cacheReadInputTokens,
    };
  }

  return base;
}
```

---

## Implementation

### AIProvider Class

Replaces `ClaudeAdapter` with AI SDK integration.

```typescript
// src/ai/AIProvider.ts

import { generateText, CoreTool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type {
  ResolvedConfig,
  UsageMetrics,
} from '../types';
import {
  ClaudeAPIError,
  RateLimitError,
  AuthenticationError,
  ServerError,
} from '../errors';

/**
 * Provider configuration for model selection
 */
export type ProviderType = 'anthropic' | 'openai' | 'google';

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
 * - Model alias resolution (sonnet → claude-sonnet-4-20250514)
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
 * console.log(result.text);       // Final response
 * console.log(result.toolCallCount); // Total tool calls
 * ```
 */
export class AIProvider {
  private providerType: ProviderType = 'anthropic';

  /** Model alias to full ID mapping */
  private static readonly MODEL_MAP: Record<ProviderType, Record<ModelAlias, string>> = {
    anthropic: {
      haiku: 'claude-haiku-4-20250514',
      sonnet: 'claude-sonnet-4-20250514',
      opus: 'claude-opus-4-20250514',
    },
    openai: {
      haiku: 'gpt-4o-mini',      // Approximate mapping
      sonnet: 'gpt-4o',
      opus: 'gpt-4-turbo',
    },
    google: {
      haiku: 'gemini-1.5-flash',
      sonnet: 'gemini-1.5-pro',
      opus: 'gemini-1.5-pro',   // No direct equivalent
    },
  };

  constructor(private config: ResolvedConfig) {
    // Provider type could be configurable in future
    this.providerType = 'anthropic';
  }

  /**
   * Generate text with automatic tool loop handling
   *
   * Uses AI SDK's `generateText` with `maxSteps` to handle the complete
   * tool loop automatically. No manual iteration required.
   *
   * @param options - Generation options
   * @returns Generation result with text, usage, and metrics
   * @throws {RateLimitError} If rate limited after retries
   * @throws {AuthenticationError} If API key is invalid
   * @throws {ClaudeAPIError} For other API errors
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
    const modelMap = AIProvider.MODEL_MAP[this.providerType];
    return modelMap[alias as ModelAlias] ?? alias;
  }

  /**
   * Get AI SDK model instance for the resolved model ID
   */
  private getModel(modelId: string) {
    // Currently only Anthropic supported
    // Future: switch based on providerType
    return anthropic(modelId, {
      // Pass API key from config
      apiKey: this.config.apiKey,
    });
  }

  /**
   * Convert AI SDK usage to UluOps format
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
   * Map AI SDK errors to UluOps error types
   */
  private mapError(error: unknown): ClaudeAPIError {
    // Import error types from AI SDK
    const { APICallError, RetryError } = require('ai');

    if (error instanceof APICallError) {
      const status = error.statusCode ?? 0;

      if (status === 429) {
        const retryAfter = this.parseRetryAfter(error);
        return new RateLimitError(
          `Rate limit exceeded: ${error.message}`,
          retryAfter,
          error
        );
      }

      if (status === 401 || status === 403) {
        return new AuthenticationError(
          `Authentication failed: ${error.message}`,
          error
        );
      }

      if (status >= 500) {
        return new ServerError(
          `Server error: ${error.message}`,
          status,
          error
        );
      }

      return new ClaudeAPIError(error.message, status, false, error);
    }

    if (error instanceof RetryError) {
      return new ClaudeAPIError(
        `Retries exhausted: ${error.message}`,
        0,
        false,
        error
      );
    }

    // Timeout errors
    if (error instanceof Error && error.name === 'AbortError') {
      return new ClaudeAPIError(
        'Request timeout exceeded',
        0,
        true,
        error
      );
    }

    return new ClaudeAPIError(
      error instanceof Error ? error.message : String(error),
      0,
      false
    );
  }

  /**
   * Parse retry-after header from API error
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

### ToolAdapter Class

Already shown above in [Tool Definition Conversion](#tool-definition-conversion).

### AgentExecutor Refactoring

The `AgentExecutor` becomes significantly simpler:

```typescript
// src/executor/AgentExecutor.ts (refactored)

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
 * The tool loop is now delegated entirely to AI SDK's `maxSteps` parameter,
 * eliminating ~90 lines of manual iteration code.
 */
export class AgentExecutor {
  private outputExtractor = new OutputExtractor();

  constructor(
    private config: ResolvedConfig,
    private aiProvider: AIProvider,  // Changed from ClaudeAdapter
    private registry: RegistryClient,
  ) {}

  /**
   * Execute an agent with optional runtime options
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

    // 2. Setup tool handler and adapter
    const toolHandler = new ToolHandler(input.target);
    const toolAdapter = new ToolAdapter(toolHandler);

    // 3. Render the agent prompt
    const runtime = resolved.runtime as ValidatorRuntime | ExecutorRuntime;
    const systemPrompt = runtime.prompt;

    // 4. Build initial context message
    const initialMessage = await this.buildInitialMessage(input, toolHandler);

    // 5. Execute via AI SDK (tool loop handled automatically!)
    let result: GenerateResult;
    try {
      result = await this.aiProvider.generate({
        model: context.model,
        system: systemPrompt,
        prompt: initialMessage,
        tools: toolAdapter.getTools(),
        maxTokens: context.maxTokens,
        maxSteps: 50,  // AI SDK handles the loop
        timeoutMs: context.timeoutMs,
        temperature: 0,
      });
    } catch (error) {
      // AIProvider already maps to our error types
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
      toolCalls: result.toolCallCount,  // From AI SDK
    };

    // 9. Return discriminated result (unchanged)
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

  // ... rest of methods unchanged (resolveContext, buildInitialMessage, etc.)
}
```

**Lines removed from AgentExecutor:**
- `executeToolLoop()` method (~90 lines) — replaced by `aiProvider.generate()` with `maxSteps`
- Manual message array management
- Usage accumulation loop
- Tool result formatting

---

## Configuration Changes

### UluOpsConfig Updates

```typescript
// src/types/config.ts

export interface UluOpsConfig {
  // ... existing fields ...

  /**
   * AI provider to use for LLM interactions
   * @default 'anthropic'
   */
  provider?: 'anthropic' | 'openai' | 'google';

  /**
   * Provider-specific API key (if different from main apiKey)
   * Falls back to OPENAI_API_KEY, GOOGLE_API_KEY, etc.
   */
  providerApiKey?: string;
}
```

### Environment Variables

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | anthropic | Anthropic API key (AI SDK default) |
| `OPENAI_API_KEY` | openai | OpenAI API key |
| `GOOGLE_API_KEY` | google | Google AI API key |

**Note:** AI SDK automatically reads these environment variables. The `apiKey` in `UluOpsConfig` is passed explicitly for Anthropic to maintain backward compatibility.

---

## Migration Guide

### Step 1: Update Dependencies

```bash
# Remove old dependency
npm uninstall @anthropic-ai/sdk

# Add AI SDK
npm install ai @ai-sdk/anthropic

# Optional: Additional providers
npm install @ai-sdk/openai @ai-sdk/google
```

### Step 2: Add New Files

Create the following new files:
- `src/ai/AIProvider.ts`
- `src/ai/ToolAdapter.ts`
- `src/ai/index.ts`

### Step 3: Update AgentExecutor

Replace `ClaudeAdapter` injection with `AIProvider`:

```typescript
// Before
constructor(
  private config: ResolvedConfig,
  private claude: ClaudeAdapter,
  private registry: RegistryClient,
) {}

// After
constructor(
  private config: ResolvedConfig,
  private aiProvider: AIProvider,
  private registry: RegistryClient,
) {}
```

### Step 4: Update UluOpsClient

```typescript
// src/UluOpsClient.ts

// Before
import { ClaudeAdapter } from './claude/ClaudeAdapter';

// After
import { AIProvider } from './ai/AIProvider';
import { ToolAdapter } from './ai/ToolAdapter';

export class UluOpsClient {
  private aiProvider: AIProvider;  // Renamed from claude
  
  constructor(config: UluOpsConfig) {
    // ...
    this.aiProvider = new AIProvider(this.resolvedConfig);
    this.agentExecutor = new AgentExecutor(
      this.resolvedConfig,
      this.aiProvider,  // Changed
      this.registry,
    );
  }
}
```

### Step 5: Delete Removed Files

```bash
rm src/claude/ClaudeAdapter.ts
rm -rf src/claude/  # If empty
```

### Step 6: Update Public Exports

```typescript
// src/index.ts

// Remove
export { ClaudeAdapter } from './claude/ClaudeAdapter';

// Add
export { AIProvider, GenerateResult, GenerateOptions } from './ai/AIProvider';
export { ToolAdapter } from './ai/ToolAdapter';
```

### Breaking Changes

| Change | Migration |
|--------|-----------|
| `ClaudeAdapter` removed | Use `AIProvider` instead |
| `ClaudeAdapter.send()` | Use `AIProvider.generate()` |
| `ClaudeAdapter.resolveModel()` | Use `AIProvider.resolveModel()` |
| `ClaudeRequest` type | Not needed (AI SDK handles internally) |
| `ClaudeResponse` type | Use `GenerateResult` instead |

---

## Future Considerations

### Multi-Provider Support (v0.10.0)

The architecture enables easy provider switching:

```typescript
const client = new UluOpsClient({
  provider: 'openai',  // Switch to GPT
  apiKey: process.env.OPENAI_API_KEY,
});

// Same API, different model
const result = await client.runAgent('code-validator', './src', {
  model: 'sonnet',  // Maps to gpt-4o for OpenAI provider
});
```

### Streaming Support (v0.10.0)

AI SDK's `streamText` enables real-time output:

```typescript
// Future API
const stream = await client.streamAgent('code-validator', './src');

for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}

const result = await stream.finalResult;
```

### AI SDK DevTools Integration (v0.11.0)

Enable debugging for multi-step agent flows:

```typescript
import { devtools } from 'ai/devtools';

const client = new UluOpsClient({
  devtools: true,  // Enable AI SDK DevTools
});
```

### ToolLoopAgent Abstraction (v1.0.0)

Consider wrapping agents as `ToolLoopAgent` instances:

```typescript
import { ToolLoopAgent } from 'ai';

const validatorAgent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4'),
  system: agentDefinition.runtime.prompt,
  tools: toolAdapter.getTools(),
});

// Reusable across contexts
await validatorAgent.generate({ prompt: '...' });
```

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-01-30 | Initial specification for AI SDK integration |
