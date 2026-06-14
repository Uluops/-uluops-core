# Execution Trace & Telemetry Design

## Context

The core SDK's `AgentExecutor` now has rich instrumentation points across the tool loop: per-step token usage, tool call arguments and result sizes, budget tracking events, context management metadata, and project structure profiling. This document maps out all collectible data, derived metrics, and the proposed `ExecutionTrace` structure.

---

## Data Sources

### Layer 1: Per-Step Telemetry

The `onStepFinish` callback fires after every AI SDK step. Available fields:

| Field | Type | Description |
|-------|------|-------------|
| `step.usage.inputTokens` | `number` | Total input tokens the model saw this step |
| `step.usage.outputTokens` | `number` | Tokens the model generated this step |
| `step.toolCalls[].toolName` | `string` | Which tools were called |
| `step.toolCalls[].args` | `object` | Tool arguments (file paths, patterns, modes, line ranges) |
| `step.toolResults[].result` | `string` | Raw tool output (measurable by `.length`) |
| `step.finishReason` | `string` | `'tool-calls'`, `'stop'`, `'length'` |
| `stepNumber` | `number` | Position in the tool loop (1-indexed) |

Example trace:

```
Step 1:  list_files(".", "**/*.ts")       -> 4.2KB result  |  32K in / 800 out
Step 2:  get_file_info("src/cli.ts")      -> 180B result   |  33K in / 200 out
Step 3:  read_file("src/cli.ts", 1, 50)   -> 2.1KB result  |  34K in / 400 out
Step 4:  search_content("auth", files)     -> 320B result   |  36K in / 300 out
Step 5:  read_file("src/auth.ts")          -> 19KB result   |  55K in / 600 out
...
Step 12: get_token_budget()                -> 200B result   |  145K in / 100 out
Step 13: (forced wrap-up)                  -> final output  |  165K in / 4K out
```

### Layer 2: Budget & Context Management Events

| Event | Data Available | When |
|-------|---------------|------|
| **Context management applied** | `providerMetadata.anthropic.contextManagement.appliedEdits` — includes `clearedToolUses` count, edit type | When Anthropic API auto-clears old tool uses (at 100K input tokens) |
| **Budget threshold crossed** | `usedTokens`, `budget`, step number, `percentUsed` | When cumulative input tokens reach 80% of `contextBudget` |
| **Wrap-up forced** | Step number, tokens consumed, steps remaining out of maxSteps | Same moment as threshold crossing — `prepareStep` returns `toolChoice: 'none'` |
| **Natural completion** | Final step's `finishReason: 'stop'` | Agent finished without being forced |
| **Step limit hit** | `finishReason: 'length'` after `maxSteps` | Agent used all 50 steps without completing |

### Layer 3: Tool Usage Patterns

Aggregated from tool calls across all steps:

| Metric | Derivation |
|--------|-----------|
| **Tool call distribution** | Count per tool name. e.g. `{ read_file: 12, search_content: 4, get_symbols: 2, get_file_info: 6 }` |
| **Files read (unique)** | Deduplicated list of file paths from `read_file` calls |
| **Partial reads** | `read_file` calls that included `start_line` or `end_line` |
| **Full reads** | `read_file` calls without line range params |
| **Total bytes read** | Sum of tool result `.length` for `read_file` calls |
| **Search modes used** | Count of `matches` vs `files` vs `count` mode calls |
| **Reconnaissance calls** | Count of `get_file_info` + `get_directory_tree` + `get_symbols` calls |
| **Budget checks** | Count of `get_token_budget` calls, and at which steps |

### Layer 4: Project Characteristics

From the initial `scanProjectStructure()` and tool call metadata:

| Metric | Source |
|--------|--------|
| **Total file count** | From bounded `list_files` result (includes count from truncation message) |
| **Languages detected** | From file extension analysis in `detectLanguages()` |
| **File sizes and line counts** | From metadata suffix in `list_files` output |
| **Project surface area** | Sum of all file sizes from metadata |
| **Largest files** | Top N files by size from metadata |
| **File type distribution** | Extension counts: `.ts: 45, .json: 12, .md: 8` |

---

## Derived Efficiency Metrics

Computed at the end of execution by combining raw data:

| Metric | Formula | Meaning |
|--------|---------|---------|
| **Tokens per file** | `totalInputTokens / uniqueFilesRead` | Average cost to examine one file |
| **Context utilization** | `finalUsedTokens / contextBudget` | What fraction of the budget was consumed |
| **Reconnaissance ratio** | `(get_file_info + get_directory_tree + get_symbols) / totalToolCalls` | How much the agent scouts before reading |
| **Surgical read ratio** | `partialReads / totalReads` | How often the agent uses line ranges vs full reads |
| **Search efficiency** | `filesModeCalls / totalSearchCalls` | How often the agent uses lightweight search modes |
| **Wasted tokens** | Tokens in tool results cleared by context management | Work that was thrown away to fit in context |
| **Forced completion** | `boolean` | Did `prepareStep` trigger budget wrap-up |
| **Steps-to-completion** | `actualSteps / maxSteps` | Step budget utilization |
| **Coverage** | `uniqueFilesRead / totalProjectFiles` | What fraction of the codebase was examined |
| **Score vs coverage** | Correlation | Does reading more files improve validator quality |
| **Cost per recommendation** | `totalEffectiveTokens / recommendations.length` | Token cost per finding generated |
| **Cache hit rate** | `cacheReadTokens / (cacheReadTokens + inputTokens)` | Effectiveness of system prompt caching |

---

## Proposed Data Structure

```typescript
/**
 * Detailed execution trace collected during an agent run.
 * Attached to AgentResult as an optional field for telemetry and analysis.
 */
interface ExecutionTrace {
  /** Per-step breakdown of the tool loop */
  steps: StepTrace[];

  /** Aggregated tool usage across all steps */
  toolSummary: ToolCallSummary;

  /** Budget and context management events */
  budgetEvents: BudgetEvent[];

  /** Project characteristics from initial scan */
  projectProfile: ProjectProfile;

  /** Computed efficiency metrics */
  efficiency: EfficiencyMetrics;
}

interface StepTrace {
  /** Step number (1-indexed) */
  step: number;

  /** Tools called in this step */
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    resultBytes: number;
  }>;

  /** Token usage for this step */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };

  /** Cumulative input tokens after this step */
  cumulativeInputTokens: number;

  /** How the step ended */
  finishReason: string;
}

interface ToolCallSummary {
  /** Call count per tool */
  callCounts: Record<string, number>;

  /** Total result bytes per tool */
  resultBytes: Record<string, number>;

  /** Unique files read */
  filesRead: string[];

  /** Files read with line ranges */
  partialReads: Array<{ path: string; startLine: number; endLine: number }>;

  /** Search modes used */
  searchModes: { matches: number; files: number; count: number };

  /** Total tool calls */
  totalCalls: number;
}

interface BudgetEvent {
  type: 'context_management_applied' | 'budget_threshold_crossed' | 'wrap_up_forced';
  step: number;
  tokensUsed: number;
  tokensBudget: number;
  percentUsed: number;

  /** For context_management_applied: how many tool uses were cleared */
  clearedToolUses?: number;
}

interface ProjectProfile {
  /** Total file count (including beyond max_results cap) */
  totalFiles: number;

  /** Detected programming languages */
  languages: string[];

  /** Total bytes across all files (from metadata) */
  totalBytes: number;

  /** File type distribution */
  extensionCounts: Record<string, number>;

  /** Top 10 largest files */
  largestFiles: Array<{ path: string; bytes: number; lines?: number }>;
}

interface EfficiencyMetrics {
  /** totalInputTokens / uniqueFilesRead */
  tokensPerFile: number;

  /** finalUsedTokens / contextBudget */
  contextUtilization: number;

  /** (recon tool calls) / totalToolCalls */
  reconnaissanceRatio: number;

  /** partialReads / totalReads */
  surgicalReadRatio: number;

  /** files mode calls / total search calls */
  searchEfficiency: number;

  /** Did prepareStep force wrap-up */
  forcedCompletion: boolean;

  /** actualSteps / maxSteps */
  stepUtilization: number;

  /** uniqueFilesRead / totalProjectFiles */
  coverageRatio: number;

  /** totalEffectiveTokens / recommendations.length (Infinity if 0 recs) */
  tokensPerRecommendation: number;

  /** cacheReadTokens / totalInputTokens */
  cacheHitRate: number;
}
```

---

## Analytics Use Cases

### 1. Agent Behavior Optimization

**Question**: Which agents use tools efficiently vs. wastefully?

**Data needed**: `toolSummary.callCounts`, `efficiency.surgicalReadRatio`, `efficiency.reconnaissanceRatio`

**Signal**: An agent with `surgicalReadRatio: 0` never uses line ranges — its prompt may need guidance on reading large files incrementally. An agent with `reconnaissanceRatio: 0` never uses `get_file_info` — it reads files blindly without checking size first.

### 2. Token Cost Modeling

**Question**: Given a project with N files and M total KB, how many tokens will an agent consume?

**Data needed**: `projectProfile.totalFiles`, `projectProfile.totalBytes`, `steps[].usage`, final `tokensPerFile`

**Signal**: Build regression model: `predictedTokens = f(fileCount, totalBytes, agentName)`. Use historical traces to calibrate.

### 3. Failure Mode Detection

**Question**: Did the agent produce a complete or partial assessment?

**Data needed**: `efficiency.forcedCompletion`, `finishReason`, `efficiency.contextUtilization`, `efficiency.stepUtilization`

**Signal**: If `forcedCompletion: true` and `contextUtilization > 0.95`, the agent was forced to stop early. If `stepUtilization > 0.95`, it ran out of steps. Either may indicate incomplete analysis — flag for review or re-run with higher budget.

### 4. Tool Effectiveness

**Question**: Are the new tools being used? Are they saving tokens?

**Data needed**: `toolSummary.searchModes`, `toolSummary.callCounts`, comparison with pre-change traces

**Signal**: If `search_content(mode: "files")` is called frequently, the agent has learned to use lightweight search. Compare `tokensPerFile` across runs with and without the new tools.

### 5. Context Management Tuning

**Question**: Is the 100K trigger threshold optimal?

**Data needed**: `budgetEvents` of type `context_management_applied`, `clearedToolUses`, subsequent step quality

**Signal**: If context management fires very early and clears tool uses that the agent immediately re-requests, the threshold is too low. If it never fires and agents crash at the limit, it's too high. Per-agent or per-project-size tuning may be needed.

### 6. Project Sizing & Pre-flight Estimation

**Question**: Is this project too large for a single agent pass?

**Data needed**: `projectProfile.totalFiles`, `projectProfile.totalBytes`, historical `contextUtilization` for similar projects

**Signal**: If projects with >200 files and >500KB consistently hit `forcedCompletion`, recommend splitting the target directory or increasing `contextBudget`.

---

## Integration Points

### Where the trace would be collected

`AgentExecutor.execute()` — the `onStepFinish` callback and tool adapter already have all the data. A `TraceCollector` class would accumulate `StepTrace` entries during the run, then compute `ToolCallSummary`, `BudgetEvent`, and `EfficiencyMetrics` at the end.

### Where the trace would be stored

**Option A**: On `AgentResult.trace` (optional field) — consumers can inspect it programmatically.

**Option B**: Submitted to the validation tracker alongside recommendations — a new `trace` field on `RunSubmission` that the API stores and exposes via analytics endpoints.

**Option C**: Both — local on the result object for immediate inspection, and submitted for longitudinal analytics.

### Where the trace would be consumed

1. **CLI `--debug` output** — human-readable step trace with token counts
2. **Validation tracker API** — stored per-run for cross-project analytics
3. **Dashboard** — visualize tool usage patterns, budget utilization over time, efficiency trends
4. **Agent prompt tuning** — identify agents that don't use efficient tool patterns, update their prompts

---

## Current Defaults Reference

| Setting | Default | Where Set |
|---------|---------|-----------|
| `contextBudget` | `200,000` tokens | `UluOpsClient.resolveConfig()` |
| `defaultThinkingBudget` | `10,000` tokens | `UluOpsClient.resolveConfig()` |
| Context management trigger | `100,000` input tokens | `AIProvider.buildProviderOptions()` |
| Context management keep | `5` most recent tool uses | `AIProvider.buildProviderOptions()` |
| Budget wrap-up threshold | `80%` of contextBudget (160K) | `AIProvider.buildBudgetPrepareStep()` |
| Initial scan file cap | `100` files | `AgentExecutor.scanProjectStructure()` |
| Initial tree preview | `20` files shown | `AgentExecutor.buildTreePreview()` |
| `list_files` default cap | `200` files | `ToolHandler` constant |
| `search_content` default max | `50` matches | `ToolHandler` dispatch |
| `get_directory_tree` max depth | `3` levels | `ToolHandler` dispatch |
| `get_directory_tree` files per dir | `50` cap | `ToolHandler` constant |
| File line counting threshold | `100 KB` max | `ToolHandler` constant |
| File read truncation | `1 MB` max | `ToolHandler` constant |
| `maxSteps` | `50` | `AgentExecutor.resolveContext()` |
| `maxTokens` (per-step output) | `8,192` | `AgentExecutor.resolveContext()` |
| `temperature` | `0` | `AgentExecutor.resolveContext()` |
| `timeoutMs` | `300,000` (5 min) | `AgentExecutor.resolveContext()` |
