# @uluops/core SDK — Implementation Task List

**Total: 16 tasks | 43 files (28 source + 12 test + 3 config)**

---

## Dependency Graph

```
Phase 0 ──┬── Phase 1a (types) ──┬── Phase 2a (ToolHandler) ────────┐
           │                      │                                   │
           └── Phase 1b (errors) ─┼── Phase 2b (OutputExtractor) ────┤
                                  │                                   │
                                  ├── Phase 2c (preflight) ──────────┤
                                  │                                   │
                                  ├── Phase 3a (AIProvider+ToolAdapter)┤
                                  │                                   │
                                  ├── Phase 3b (RegistryClient) ─────┤
                                  │                                   │
                                  └── Phase 3c (ValidationClient)    │
                                                                      │
                                  Phase 4a (AgentExecutor) ◄──────────┘
                                    depends on: ToolHandler, OutputExtractor,
                                    AIProvider, ToolAdapter, RegistryClient
                                        │
                                  Phase 4b (CommandExecutor) ◄── preflight, RegistryClient
                                        │
                                  Phase 5a (WorkflowExecutor)
                                        │
                                  Phase 5b (PipelineExecutor) ◄── WorkflowExecutor
                                        │
                                  Phase 5c (UluOpsClient) ◄── all executors
                                        │
                                  Phase 5d (public exports)
                                        │
                                  Phase 6 (integration)
```

---

## Task Details

### Phase 0: Scaffolding

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 1 | Scaffold package infrastructure | pending | — | `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts` |

---

### Phase 1: Types + Errors

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 2 | Create type definitions (12 files) | pending | #1 | `src/types/{index,config,execution,agent,command,workflow,pipeline,tools,ai,parser,registry,validation}.ts` |
| 3 | Create error classes (2 files) | pending | #1 | `src/errors/{UluOpsError,index}.ts` |

**Notes:**
- `types/ai.ts` replaces old `types/claude.ts` — contains `UsageMetrics`, `GenerateOptions`, `GenerateResult`, `ModelAlias`
- `types/config.ts` — Anthropic-only for v0.1.0 (no `provider`/`providerApiKey` fields)
- `types/agent.ts` includes `AgentResult` discriminated union (`ValidatorAgentResult | ExecutorAgentResult`)
- `types/execution.ts` has `score` as optional
- `types/validation.ts` — reduced scope: only core execution types (no analytics/issue/project types)
- `errors/index.ts` — re-exports HTTP errors from `@uluops/sdk-core/errors`

---

### Phase 2: Leaf Components

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 4 | Implement ToolHandler | pending | #2, #3 | `src/executor/ToolHandler.ts`, `test/executor/ToolHandler.test.ts` |
| 5 | Implement OutputExtractor | pending | #2, #3 | `src/parser/OutputExtractor.ts`, `test/parser/OutputExtractor.test.ts` |
| 6 | Implement preflight checks | pending | #2, #3 | `src/executor/preflight.ts`, `test/executor/preflight.test.ts` |

---

### Phase 3: Service Clients

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 7 | Implement AIProvider + ToolAdapter | pending | #2, #3 | `src/ai/{AIProvider,ToolAdapter,index}.ts`, `test/ai/{AIProvider,ToolAdapter}.test.ts` |
| 8 | Implement RegistryClient | pending | #2, #3 | `src/registry/RegistryClient.ts`, `test/registry/RegistryClient.test.ts` |
| 9 | Implement ValidationClient | pending | #2, #3 | `src/validation/ValidationClient.ts`, `test/validation/ValidationClient.test.ts` |

**Notes:**
- AIProvider wraps Vercel AI SDK v6 `generateText()` with `maxSteps` for automatic tool loop
- ToolAdapter converts ToolHandler's JSON Schema tools to AI SDK's Zod-based `tool()` format
- AIProvider is Anthropic-only for v0.1.0; maps errors to sdk-core error classes
- RegistryClient and ValidationClient use `@uluops/sdk-core` HttpClient for HTTP infrastructure

---

### Phase 4: Core Executors

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 10 | Implement AgentExecutor | pending | #4, #5, #7, #8 | `src/executor/AgentExecutor.ts`, `test/executor/AgentExecutor.test.ts` |
| 11 | Implement CommandExecutor | pending | #6, #8, #10 | `src/executor/CommandExecutor.ts`, `test/executor/CommandExecutor.test.ts` |

**Notes:**
- AgentExecutor delegates tool loop to `AIProvider.generate()` with `maxSteps: 50`
- Creates `ToolAdapter` from `ToolHandler`, passes Zod-based tools to AIProvider
- Returns `AgentResult` discriminated union type

---

### Phase 5: Orchestration + Facade

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 12 | Implement WorkflowExecutor | pending | #11 | `src/executor/WorkflowExecutor.ts`, `test/executor/WorkflowExecutor.test.ts` |
| 13 | Implement PipelineExecutor | pending | #11, #12 | `src/executor/PipelineExecutor.ts`, `src/client/PipelineHandle.ts`, `test/executor/PipelineExecutor.test.ts` |
| 14 | Implement UluOpsClient facade | pending | #10, #11, #12, #13 | `src/client/UluOpsClient.ts`, `test/client/UluOpsClient.test.ts` |
| 15 | Wire up public exports | pending | #14 | `src/index.ts` |

**Notes:**
- PipelineExecutor uses safe regex-based condition evaluator (no `new Function()`)
- PipelineHandle class provides async monitoring (status, wait, cancel)
- UluOpsClient wires AIProvider, constructs `RunSubmission` objects for validation

---

### Phase 6: Integration

| # | Task | Status | Blocked By | Files |
|---|------|--------|------------|-------|
| 16 | Final integration, build, and link | pending | #15 | — |

---

## Spec Issue Tracker — All Fixed

All 10 spec issues have been fixed in the spec document (v0.9.0). No implementation workarounds needed.

| # | Issue | Status |
|---|-------|--------|
| 1 | Duplicate `detectEnvironment()` | **Fixed in spec** |
| 2 | `submit()` call mismatch (positional args) | **Fixed in spec** |
| 3 | `runningPipelines` Map undefined | **Fixed in spec** |
| 4 | `score` required in `ExecutionResult` | **Fixed in spec** |
| 5 | Stale model IDs | **Fixed in spec** |
| 6 | `new Function()` eval (security) | **Fixed in spec** |
| 7 | `transformToAPIRequest` accesses `result.validators` | **Fixed in spec** |
| 8 | Operator precedence in `parseIssues` | **Fixed in spec** |
| 9 | `AgentResult` types not defined | **Fixed in spec** |
| 10 | `PipelineHandle` class not implemented | **Fixed in spec** |

---

## Summary Statistics

- **Source files**: 28
- **Test files**: 12
- **Config files**: 3
- **Type definitions**: ~100+ interfaces/types across 12 files
- **Error classes**: 8 core + re-exports from @uluops/sdk-core
- **Core classes**: 12 (ToolHandler, OutputExtractor, AIProvider, ToolAdapter, RegistryClient, ValidationClient, AgentExecutor, CommandExecutor, WorkflowExecutor, PipelineExecutor, UluOpsClient, PipelineHandle)
- **Dependencies**: @uluops/sdk-core, ai, @ai-sdk/anthropic, yaml, glob, zod
- **Dev dependencies**: @types/node, nock, typescript, vitest
