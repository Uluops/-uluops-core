# @uluops/core — Execution Architecture

This document traces the complete execution chain from definition resolution through LLM generation to result persistence. Each chain is numbered hop-by-hop with boundary crossings marked.

## Table of Contents

- [Definition Resolution](#definition-resolution)
- [Chain 1: Agent Run](#chain-1-agent-run)
- [Chain 2: Command Run](#chain-2-command-run)
- [Chain 3: Workflow Run](#chain-3-workflow-run)
- [Chain 4: Pipeline Run](#chain-4-pipeline-run)
- [Auto-Routing](#auto-routing)
- [Result Naming](#result-naming)
- [Tracking and Persistence](#tracking-and-persistence)
- [Boundary Crossings](#boundary-crossings)

---

## Definition Resolution

Every chain starts with `UluOpsClient.resolveByRef()`. This sub-chain is shared.

```
1. parseRef(name)
   Splits "code-validator@1.2.0" → [name, version]

2. RegistryClient.resolve(name, version?, type?)
   Builds cache key: "${type ?? 'any'}:${name}@${version ?? 'latest'}"

3. Resolution path (first match wins):
   a. CACHE HIT → return immediately
   b. LOCAL (if localDefinitions configured):
      - Tries up to 8 candidate paths (name.type.yaml × flat + subdirectory)
      - fs.readFile → yaml.parse → castDefinition (structural validation)
      - tryRenderViaAPI (registry render.preview) or raw YAML fallback
      - hash = '' (no server-side computation for local)
   c. REMOTE:
      - sdk.definitions.get(type, name, version, { includeYaml, includeRuntime })
      - sdk.render.get(type, name, version) → rendered markdown prompt
      - hash = def.hash (SHA-256 from registry)

4. Cache the result (in-memory Map)

5. Return ResolvedDefinition { type, name, version, hash, yaml, definition, runtime, domain, agentType }
```

**Boundary crossings:** filesystem I/O (local), HTTP to registry API (remote), HTTP to render API (both paths)

---

## Chain 1: Agent Run

**Entry:** `UluOpsClient.runAgent(name, target, options?)`

```
 1. Resolve definition (type='agent')                    → Definition Resolution
 2. AgentExecutor.execute(resolved, input, options)
 3. resolveContext() — merge options > agent defaults > config defaults
 4. assertAgentRuntime() — type guard ensuring resolved.type is 'agent'
 5. [if agent has 'bash' tool] Resolve model → create provider shell tool
 6. Create ToolHandler + TokenBudgetTracker + ToolAdapter
 7. buildInitialMessage() — scan project structure via list_files tool
 8. Universal agentOutputSchema (Zod) — categories + artifacts, both nullable.
      All 6 agent types use the same schema. No type-specific routing.
 9. AIProvider.generate():
10.   ModelCatalog.resolve() — alias → registry API → ResolvedModel
11.   ensureProvider() — bundled or dynamic import('@ai-sdk/<name>')
12.   buildProviderOptions() — thinking budgets, reasoning effort, context management
13.   buildSystemMessage() — Anthropic: cache control wrapper; others: plain string
14.   generateText() — Vercel AI SDK v6 tool loop
        LLM generates → tool calls → ToolHandler.fulfill() → filesystem I/O
        onStepFinish: update TokenBudgetTracker
        prepareStep: force toolChoice:'none' at 80% budget
15. [BRANCH] Extract output:
      a. Structured output present → mapStructuredOutput() (confidence: 1.0)
      b. Fallback → OutputExtractor.extractWithMetadata():
         JSON code fence (0.95) > inline JSON (0.7) > regex patterns (0.5)
      Categories + artifacts extracted for all agent types (no type gating).
16. flattenRecommendations() — categories → findings → issues → Recommendation[]
17. classifyAgentDecision() — vocabulary map from definition → DecisionCategory
18. calculateEffectiveTokens() — input + output + cache_creation + thinking
19. Construct AgentResult — universal type, decision passes through as-is
20. trackIfEnabled() → submit to tracker + record in registry
21. Return AgentResult (with dashboardUrl attached)
```

---

## Chain 2: Command Run

**Entry:** `UluOpsClient.runCommand(name, input)`

```
 1. Resolve definition (type='command')                  → Definition Resolution
 2. CommandExecutor.execute(resolved, input)
 3. [if preflight defined] Run checks:
      file_exists: fs.access + realpath symlink check
      command: sh -c with security filter (metachar + interpreter rejection)
      env_var: process.env lookup
      git_clean: git status --porcelain
 4. Resolve agent ref(s) from command definition
 5. [BRANCH on agent count]:
      a. Single agent:
         → registry.resolve(agentRef, 'agent')
         → AgentExecutor.execute()                       → Chain 1 (hops 2-18)
         → wrapAgentResult() — maps AgentResult to CommandResult
      b. Multi-agent:
         [sequential (default) or parallel via Promise.allSettled]
         → each: registry.resolve → AgentExecutor.execute → collect results
         → aggregateResults():
           Score aggregation (all scored agents): average | min | max | weighted_average
           Decision: score present → score >= pass → PASS; score >= warn → WARN; else FAIL
           No scores → any FAILED → FAILED; any PARTIAL → PARTIAL; else COMPLETE
 6. trackIfEnabled()
 7. Return CommandResult
```

---

## Chain 3: Workflow Run

**Entry:** `UluOpsClient.runWorkflow(name, input)`

```
 1. Resolve definition (type='workflow')                 → Definition Resolution
 2. WorkflowExecutor.execute(resolved, input)
 3. topoGroupLevels(phases) — topological sort into execution levels
 4. LOOP over levels:
 5.   [if stopped/aborted] → skipLevel() — mark all as 'skipped'
 6.   filterEligible():
        skip_if evaluation ({{ input.field }} template matching)
        dependency check (all deps must be passed/warned, not blocked/aborted)
 7.   executePhasesParallel():
        1 phase → direct call
        maxParallel set → semaphore-limited workers
        unlimited → Promise.allSettled
 8.   Per phase:
        [parallel flag] → Promise.allSettled on commands
        [sequential]    → for loop on commands
        Per command: registry.resolve → CommandExecutor.execute → Chain 2
 9.   aggregatePhaseScore(commands, method) — average | min | max
10.   evaluateGate(score, gate):
        no gate → 'passed'
        score >= threshold → 'passed'
        on_fail === 'warn' → 'warned'
        else → 'blocked'
11.   processLevelResults() — apply failure behavior:
        stop: finish level, skip subsequent
        abort: skip all remaining
        warn: downgrade blocked → warned
        continue: proceed past failure
12. aggregate() — weighted score across phases:
      blocked/aborted → BLOCK
      warned → HOLD
      all passed → SHIP
13. deduplicateRecommendations() — by title + filePath + lineNumber
14. Construct WorkflowResult with phase-level metrics
15. trackIfEnabled()
16. Return WorkflowResult
```

---

## Chain 4: Pipeline Run

**Entry:** `UluOpsClient.startPipeline(name, input)`

```
 1. Resolve definition (type='pipeline')                 → Definition Resolution
 2. PipelineExecutor.start(resolved, input)
 3. Generate pipelineId: "pipeline_${Date.now()}_${random7chars}"
 4. Create PipelineState { pipelineId, status: 'running', stageResults: [] }
 5. Launch executeAsync() in background (fire-and-forget)
 6. Return PipelineHandle immediately (caller can poll/wait/cancel)

--- Background execution ---
 7. LOOP over stages:
 8.   [if cancelled] → break
 9.   Check stage dependencies (all deps must have status='completed')
10.   [if skip_if] → evaluate condition against prior stage results
11.   executeStage():
        parseRef(stage.ref) → registry.resolve(name, version, stage.type)
        [workflow] → WorkflowExecutor.execute()           → Chain 3
        [command]  → CommandExecutor.execute()             → Chain 2
12.   Accumulate stageResult into state

--- PipelineHandle.wait() ---
13. Await execution promise
14. buildResult():
      score = average of stage scores
      decision: any FAIL/BLOCK → FAIL; any WARN/HOLD → WARN; else PASS
15. Return PipelineResult

NOTE: startPipeline() does NOT call trackIfEnabled().
      Use UluOpsClient.run() for tracked pipeline execution.
```

---

## Auto-Routing

**Entry:** `UluOpsClient.run(name, input)`

```
1. Resolve definition (no type hint — searches all types)
   Local: tries all 8 candidate paths
   Remote: sdk.definitions.list({ search: name }) — must match exactly one

2. Switch on resolved.type:
   'agent'    → AgentExecutor.execute()    → Chain 1
   'command'  → CommandExecutor.execute()   → Chain 2
   'workflow' → WorkflowExecutor.execute()  → Chain 3
   'pipeline' → PipelineExecutor.execute()  → Chain 4 (sync, includes wait)

3. trackIfEnabled() — called for ALL types including pipeline
4. Return ExecutionResult | AgentResult
```

---

## Result Naming

How the `name` and `version` fields on each result type are sourced:

| Result Type | `name` Source | `version` Source |
|-------------|--------------|-----------------|
| `AgentResult` | `ResolvedDefinition.name` (registry name or filename) | `definition.agent.interface.version` or `'unknown'`. Universal type — all 6 agent types use the same result shape with score, categories, artifacts. |
| `CommandResult` | `def.command.interface.name` (from YAML) | `def.command.interface.version` (from YAML) |
| `WorkflowResult` | `def.workflow.interface.name` (from YAML) | `def.workflow.interface.version` (from YAML) |
| `PipelineResult` | Generated `pipelineId` (`pipeline_<timestamp>_<random>`) | `def.pipeline.interface.version` (from YAML) |

**Notable:** Pipeline result `name` is a generated ID, not the definition name. All other result types use the definition's declared name.

---

## Tracking and Persistence

When `trackResults` is enabled (default: `config.trackingEnabled`), two API calls are made after execution:

### 1. Tracker Submission (ValidationClient)

```
UluOpsClient.trackIfEnabled()
  → ValidationClient.submit({ project, workflowType, result })
    → transformToOpsInput():
        project = options.project ?? config.defaultProject ?? resolved.name
        workflowType = 'agent' | 'command' | 'workflow' | 'pipeline'
        agents = [{ name, score, maxScore, decision, model, tokens, durationMs }]
        recommendations = result.recommendations.map(r → {
          agent, validator, title, priority, severity, failureCode,
          failureDomain, failureMode, filePath, lineNumber, description
        })
        summary = { allGatesPassed, averageScore }
        definitionType, definitionName, definitionVersion, definitionHash
    → OpsClient.runs.save(input)
        HTTP POST to tracker API
    → Response: { run: { id, runNumber }, correlation: { newIssues, recurring, regressions } }
    → Attaches dashboardUrl to result object
```

### 2. Registry Execution Recording

```
UluOpsClient.trackIfEnabled()
  → [if resolved.version !== 'unknown']
    registrySdk.executions.record(type, name, version, { source: 'core-sdk', runId })
    HTTP POST to registry API
    Non-fatal — failures logged as warning, never thrown
```

### Tracking gaps

- `startPipeline()` does **not** call `trackIfEnabled()`. Use `run()` for tracked pipelines.
- Local definitions with no version field → `version = 'unknown'` → registry recording skipped.
- Local definitions → `hash = ''` → empty hash in tracker payload.

---

## Boundary Crossings

All external boundaries the execution chain crosses:

| Boundary | Location | Type |
|----------|----------|------|
| Filesystem read (local definitions) | RegistryClient.resolveLocal | I/O |
| Registry API (definition fetch) | RegistryClient.resolveRemote | Network + Auth |
| Registry API (render) | RegistryClient.tryRenderViaAPI | Network + Auth |
| Registry API (model resolution) | ModelCatalog.resolve | Network + Auth |
| LLM Provider API (generation) | AIProvider.generate → generateText | Network + Auth |
| Filesystem (tool fulfillment) | ToolHandler.fulfill per step | I/O |
| Shell subprocess (bash/shell tool) | ShellExecutor | Process |
| Shell subprocess (preflight commands) | preflight.checkCommand (cwd=target) | Process (read-only allowlist, supply-chain trust) |
| Tracker API (result submission) | ValidationClient → OpsClient | Network + Auth |
| Registry API (execution recording) | registrySdk.executions.record | Network + Auth |
