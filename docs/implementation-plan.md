# @uluops/core SDK Implementation Plan

## Context

Build the `@uluops/core` SDK — the foundational execution engine that powers all UluOps execution contexts. This SDK orchestrates two backend services (registry API + validation API) and manages the LLM tool loop for agent-based code analysis via Vercel AI SDK v6.

The spec (`packages/uluops-core-sdk/docs/uluops-core-sdk-spec-v0_9_0.md`) defines ~28 source files covering types, errors, executors, service clients, and a unified facade. The directory currently has only `docs/` — no code, no package.json.

We follow existing monorepo conventions from `packages/ops-sdk`: ESM, strict TypeScript, vitest, nock, Zod where needed. We reuse `@uluops/sdk-core` for HTTP infrastructure (HttpClient, error classes, auth strategies) — the same pattern used by `ops-sdk` and `registry-sdk`.

---

## Spec Issues — All Fixed in Spec v0.9.0

All 10 spec bugs have been fixed directly in the spec document. No workarounds needed during implementation.

| # | Issue | Status | Location in Spec |
|---|-------|--------|-----------------|
| 1 | Duplicate `detectEnvironment()` | **Fixed** | ValidationClient — browser version removed |
| 2 | `submit()` call mismatch (positional args) | **Fixed** | UluOpsClient — uses `RunSubmission` objects |
| 3 | `runningPipelines` Map undefined | **Fixed** | PipelineExecutor — `private runningPipelines` added |
| 4 | `score` required in `ExecutionResult` | **Fixed** | `types/execution.ts` — made optional |
| 5 | Stale model IDs | **Fixed** | AIProvider — Claude 4.5/4.6 model IDs |
| 6 | `new Function()` eval (security) | **Fixed** | PipelineExecutor — safe regex-based condition evaluator |
| 7 | `transformToAPIRequest` accesses `result.validators` | **Fixed** | ValidationClient — builds validators from result |
| 8 | Operator precedence in `parseIssues` | **Fixed** | OutputExtractor — parentheses added |
| 9 | `AgentResult` types not defined | **Fixed** | `types/agent.ts` — discriminated union added |
| 10 | `PipelineHandle` class not implemented | **Fixed** | `client/PipelineHandle.ts` — class added |

---

## Phase 0: Scaffolding

Create package infrastructure.

### Files to create:
- `package.json` — name `@uluops/core`, deps: `@uluops/sdk-core`, `ai`, `@ai-sdk/anthropic`, `yaml`, `glob`, `zod`
- `tsconfig.json` — match `packages/ops-sdk/tsconfig.json`
- `vitest.config.ts` — standard vitest config
- `src/index.ts` — empty placeholder

### Verify:
```bash
cd packages/uluops-core-sdk && npm install && npx tsc --noEmit
```

---

## Phase 1: Types + Errors (~15 files)

All pure type definitions and error classes. Zero runtime dependencies between them.

### Type files (spec lines → file):
| # | File | Types | Notes |
|---|------|-------|-------|
| 1 | `src/types/config.ts` | `UluOpsConfig`, `ResolvedConfig` | Anthropic-only for v0.1.0 (no multi-provider) |
| 2 | `src/types/execution.ts` | `DefinitionType`, `ExecutionType`, `Domain`, `AgentType`, `ExecutionInput`, `ExecutionResult`, `ExecutionMetrics`, `ExecutionOptions`, `ResolvedExecutionContext`, `Recommendation` | `score` is optional |
| 3 | `src/types/agent.ts` | `AgentDefinition`, `AgentCategory`, `AgentTask`, `AgentResult`, `ValidatorAgentResult`, `ExecutorAgentResult` | Discriminated union on `agentType` |
| 4 | `src/types/command.ts` | `CommandDefinition`, `PreflightCheck`, `PostflightAction`, `CommandResult`, `CommandMetrics`, `CategoryResult`, `Finding`, `Issue`, `ArtifactResult` | |
| 5 | `src/types/workflow.ts` | `WorkflowDefinition`, `PhaseDefinition`, `WorkflowResult`, `WorkflowMetrics`, `PhaseResult`, `CommandMetricsSummary` | |
| 6 | `src/types/pipeline.ts` | `PipelineDefinition`, `StageDefinition`, `TriggerDefinition`, `PipelineResult`, `PipelineMetrics`, `StageResult`, `TriggerInfo`, `PipelineArtifact`, `PipelineState`, `PipelineHandle` interface | |
| 7 | `src/types/tools.ts` | `Tool`, `ToolUseBlock`, `ToolResult` | |
| 8 | `src/types/ai.ts` | `UsageMetrics`, `GenerateOptions`, `GenerateResult`, `ModelAlias` | Replaces old `claude.ts`; AI SDK-oriented types |
| 9 | `src/types/parser.ts` | `ParsedOutput`, `ParsedCategory`, `ParsedFinding`, `ExtractionOptions`, `ExtractionResult` | |
| 10 | `src/types/registry.ts` | `ResolvedDefinition`, `ValidatorRuntime`, `ExecutorRuntime`, `WorkflowRuntime`, `PipelineRuntime`, config subtypes, `DefinitionSummary`, `Reference` | |
| 11 | `src/types/validation.ts` | `ValidatorSnapshot`, `RecommendationPayload`, `ValidationRunRequest`, `ValidationAPIRunResponse`, `RunSubmission`, `RunSubmissionResponse`, `CorrelatedIssue`, `RunHistoryEntry`, `ValidationQueryOptions`, `FingerprintedRecommendation`, `RegressionInfo` | Reduced scope — analytics/issue types in ops-sdk |
| 12 | `src/types/index.ts` | barrel re-exports | |

### Error files:
| # | File | Classes |
|---|------|---------|
| 13 | `src/errors/UluOpsError.ts` | `UluOpsError` base class |
| 14 | `src/errors/index.ts` | `ExecutionError`, `PreflightError`, `HashVerificationError`, `ValidationError`, `ValidationErrorCodes`, `WorkflowError`, `PipelineError`, `ParseError` + re-exports from `@uluops/sdk-core/errors` |

### Verify:
```bash
npx tsc --noEmit  # All types compile
```

---

## Phase 2: Leaf Components (3 files + 3 test files)

Components with no internal SDK dependencies (only types/errors).

### Source files:
| # | File | Description |
|---|------|-------------|
| 1 | `src/executor/ToolHandler.ts` | Filesystem tool fulfillment with path sandboxing |
| 2 | `src/parser/OutputExtractor.ts` | 3-strategy JSON extraction from LLM responses |
| 3 | `src/executor/preflight.ts` | Preflight check runner (file_exists, command, env_var, git_clean) |

### Test files:
| # | File | Coverage |
|---|------|----------|
| 1 | `test/executor/ToolHandler.test.ts` | Path safety, read_file, list_files, search_content |
| 2 | `test/parser/OutputExtractor.test.ts` | JSON fence, inline JSON, structured text, edge cases |
| 3 | `test/executor/preflight.test.ts` | Each check type, failure scenarios |

### Implementation notes:
- **ToolHandler**: use `node:fs/promises`, `node:path`, `glob` package
- **OutputExtractor**: operator precedence already fixed in spec
- **Preflight**: use `node:child_process` for command checks, `node:fs` for file_exists

### Verify:
```bash
npx vitest run && npx tsc --noEmit
```

---

## Phase 3: Service Clients (5 files + 4 test files)

AI SDK wrapper, Registry API client, and Validation API client.

### Source files:
| # | File | Description |
|---|------|-------------|
| 1 | `src/ai/AIProvider.ts` | Vercel AI SDK v6 wrapper — `generateText()` with `maxSteps`, model alias resolution (Anthropic-only), error mapping to sdk-core errors |
| 2 | `src/ai/ToolAdapter.ts` | Converts ToolHandler's JSON Schema tools to AI SDK's Zod-based `tool()` format |
| 3 | `src/ai/index.ts` | Barrel re-exports for `ai/` module |
| 4 | `src/registry/RegistryClient.ts` | Local + remote definition resolution with SHA-256 hash verification. Delegates remote calls to `@uluops/registry-sdk` |
| 5 | `src/validation/ValidationClient.ts` | Core execution submission (submit, validateRun, getHistory, getRun). Delegates to `@uluops/ops-sdk` |

### Test files:
| # | File | Coverage |
|---|------|----------|
| 1 | `test/ai/AIProvider.test.ts` | Model alias resolution, retry logic, error mapping, usage metrics (mock AI SDK) |
| 2 | `test/ai/ToolAdapter.test.ts` | Tool schema conversion, Zod schema generation, tool execution delegation |
| 3 | `test/registry/RegistryClient.test.ts` | Local resolution, remote resolution, hash verification, caching (nock) |
| 4 | `test/validation/ValidationClient.test.ts` | Submit, validateRun, getHistory, getRun, transformations (nock) |

### Dependencies:
- **AIProvider**: `ai` (generateText, tool), `@ai-sdk/anthropic` (anthropic provider), `@uluops/sdk-core/errors` (error mapping)
- **ToolAdapter**: `ai` (tool, CoreTool), `zod` (schema conversion)
- **RegistryClient**: `@uluops/registry-sdk` (RegistryClient), `yaml` package, `node:crypto` for local hash verification
- **ValidationClient**: `@uluops/ops-sdk` (OpsClient), transforms ExecutionResult → SaveFeaturesListInput

### Verify:
```bash
npx vitest run && npx tsc --noEmit
```

---

## Phase 4: Core Executors (2 files + 2 test files)

The execution engine that ties together AIProvider, ToolHandler/ToolAdapter, and OutputExtractor.

### Source files:
| # | File | Description |
|---|------|-------------|
| 1 | `src/executor/AgentExecutor.ts` | Primary single-agent executor: prompt rendering, delegates tool loop to `AIProvider.generate()` with `maxSteps: 50`, output parsing, metrics. Returns `AgentResult` discriminated union. |
| 2 | `src/executor/CommandExecutor.ts` | Command executor: preflight checks, single-agent delegation to AgentExecutor, multi-agent aggregation |

### Test files:
| # | File | Coverage |
|---|------|----------|
| 1 | `test/executor/AgentExecutor.test.ts` | Tool loop execution via AIProvider, timeout, metrics (mock AIProvider + ToolHandler) |
| 2 | `test/executor/CommandExecutor.test.ts` | Single-agent delegation, multi-agent aggregation, preflight |

### Key design:
- AgentExecutor creates a `ToolAdapter` from `ToolHandler`, passes tools to `AIProvider.generate()`
- AI SDK's `maxSteps` manages the tool loop automatically — no manual `executeToolLoop()` needed
- After generation, `OutputExtractor` parses structured output from the final text response

### Verify:
```bash
npx vitest run && npx tsc --noEmit
```

---

## Phase 5: Orchestration + Facade (5 files + 3 test files)

Higher-level orchestration and the unified client.

### Source files:
| # | File | Description |
|---|------|-------------|
| 1 | `src/executor/WorkflowExecutor.ts` | Multi-phase orchestration with gates, dependencies, failure handling |
| 2 | `src/executor/PipelineExecutor.ts` | Multi-stage pipeline with async support, state management, safe condition evaluation |
| 3 | `src/client/PipelineHandle.ts` | Async pipeline monitoring class (status, wait, cancel) |
| 4 | `src/client/UluOpsClient.ts` | Unified facade: config validation, wires AIProvider + executors, execution routing, validation submission via `RunSubmission` objects |
| 5 | `src/index.ts` | Complete public exports |

### Test files:
| # | File | Coverage |
|---|------|----------|
| 1 | `test/executor/WorkflowExecutor.test.ts` | Phase execution, gates, skip conditions, dependencies, aggregation |
| 2 | `test/executor/PipelineExecutor.test.ts` | Stage execution, conditions, async handling |
| 3 | `test/client/UluOpsClient.test.ts` | Config validation, execution routing, convenience methods |

### Verify:
```bash
npm run build && npm run typecheck && npx vitest run
```

---

## Phase 6: Final Integration

1. Build and link: `npm run build && npm link`
2. Verify exports: import `@uluops/core` in a test script, check all public types available
3. Run full test suite with coverage: `npx vitest run --coverage`
4. **Integration test strategy**: Create `test/integration/` with tests that exercise the full execution path (UluOpsClient → AgentExecutor → AIProvider → ToolHandler) using mock AI SDK responses. Verify RegistryClient ↔ HttpClient and ValidationClient ↔ HttpClient integration with nock-intercepted HTTP.

---

## Dependencies

```json
{
  "dependencies": {
    "@uluops/sdk-core": "file:../sdk-core",
    "@uluops/ops-sdk": "file:../ops-sdk",
    "@uluops/registry-sdk": "file:../registry-sdk",
    "ai": "^6.0.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "glob": "^11.0.0",
    "yaml": "^2.7.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.12.0",
    "nock": "^14.0.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

---

## Complete File Manifest

### Source Files (28 files)
```
src/
  index.ts
  types/
    index.ts
    config.ts
    execution.ts
    agent.ts
    command.ts
    workflow.ts
    pipeline.ts
    tools.ts
    ai.ts
    parser.ts
    registry.ts
    validation.ts
  errors/
    UluOpsError.ts
    index.ts
  executor/
    ToolHandler.ts
    AgentExecutor.ts
    CommandExecutor.ts
    WorkflowExecutor.ts
    PipelineExecutor.ts
    preflight.ts
  ai/
    AIProvider.ts
    ToolAdapter.ts
    index.ts
  parser/
    OutputExtractor.ts
  registry/
    RegistryClient.ts
  validation/
    ValidationClient.ts
  client/
    UluOpsClient.ts
    PipelineHandle.ts
```

### Test Files (12 files)
```
test/
  executor/
    ToolHandler.test.ts
    AgentExecutor.test.ts
    CommandExecutor.test.ts
    WorkflowExecutor.test.ts
    PipelineExecutor.test.ts
    preflight.test.ts
  ai/
    AIProvider.test.ts
    ToolAdapter.test.ts
  parser/
    OutputExtractor.test.ts
  registry/
    RegistryClient.test.ts
  validation/
    ValidationClient.test.ts
  client/
    UluOpsClient.test.ts
```

### Config Files (3 files)
```
package.json
tsconfig.json
vitest.config.ts
```

**Total: 43 files (28 source + 12 test + 3 config)**
