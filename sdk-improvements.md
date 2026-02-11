# Core SDK Improvements

## Problem: Context Window Exhaustion

The `AgentExecutor` uses Vercel AI SDK's `generateText()` with `maxSteps` for automatic tool looping. Every tool result stays in the conversation at full size — there is no compression, truncation, or summarization. After ~15 reads of large source files, the agent hits the 200K token limit and fails with `prompt is too long`.

Claude Code avoids this through **conversation compression** (summarizing old messages as context grows) and **surgical tools** (read specific line ranges, search returning only matching lines, glob returning only paths).

---

## Phase 1: Tool Improvements (Quick Wins)

### 1.1 Add `offset`/`limit` to `read_file`

Current: always reads entire file (up to 1MB).
Proposed: add optional `start_line` and `end_line` parameters.

```typescript
{
  name: 'read_file',
  input_schema: {
    properties: {
      path: { type: 'string' },
      start_line: { type: 'integer', description: 'First line to read (1-indexed). Default: 1' },
      end_line: { type: 'integer', description: 'Last line to read. Default: end of file' },
    }
  }
}
```

**Impact**: Agent can read function definitions (20 lines) instead of entire files (500+ lines). ~25x token savings per targeted read.

### 1.2 Add file sizes to `list_files` output

Current: returns bare file paths (`src/cli.ts`).
Proposed: return paths with line counts and byte sizes.

```
src/cli.ts (120 lines, 3.8KB)
src/context.ts (473 lines, 14.0KB)
src/utils.ts (200 lines, 6.3KB)
```

**Impact**: Agent can prioritize small files and avoid reading giant files whole. Enables informed decisions about what to read.

### 1.3 Add `max_results` to `list_files`

Current: returns ALL matching files (can be thousands in large projects).
Proposed: add `max_results` parameter with sensible default (100).

### 1.4 Improve `search_content` output modes

Current: returns matching lines with file/line/content.
Proposed: add `mode` parameter:

- `"matches"` (default) — current behavior, matching lines with context
- `"files"` — return only file paths that contain matches (like `grep -l`)
- `"count"` — return match counts per file (like `grep -c`)

**Impact**: Agent can quickly survey "which files mention X?" without getting full content back.

### 1.5 Add context lines to `search_content`

Add `context_lines` parameter (like `grep -C`). Default: 0. Allows agent to see surrounding code without reading the whole file.

---

## Phase 2: New Tools

### 2.1 `get_file_info` — Metadata without content

Returns file metadata without reading content. Token-free reconnaissance.

```typescript
{
  name: 'get_file_info',
  description: 'Get file metadata without reading content. Returns size, line count, language, and last modified time.',
  input_schema: {
    properties: {
      path: { type: 'string', description: 'File path relative to target' },
    }
  }
}
```

Response:
```json
{ "path": "src/context.ts", "size": 13960, "lines": 473, "language": "TypeScript", "modified": "2026-02-10T..." }
```

**Impact**: Agent can assess files before deciding to read them. Zero content tokens.

### 2.2 `get_directory_tree` — Structured overview

Returns a hierarchical tree view with depth control — more informative than flat `list_files`.

```typescript
{
  name: 'get_directory_tree',
  description: 'Get directory structure as a tree with file counts and sizes per directory.',
  input_schema: {
    properties: {
      path: { type: 'string', description: 'Directory path relative to target' },
      max_depth: { type: 'integer', description: 'Maximum depth to traverse. Default: 3' },
      show_files: { type: 'boolean', description: 'Include individual files or just directories. Default: true' },
    }
  }
}
```

Response:
```
src/ (25 files, 98KB)
  cli.ts (120 lines)
  context.ts (473 lines)
  utils.ts (200 lines)
  commands/ (12 files, 62KB)
    auth.ts (580 lines)
    runs.ts (420 lines)
    ...
  formatters/ (3 files, 8KB)
test/ (26 files, 85KB)
  commands/ (18 files, 65KB)
  helpers/ (2 files, 3KB)
```

**Impact**: Agent gets structural understanding in one call instead of recursive `list_files`. Enables "I should focus on `src/commands/`" decisions.

### 2.3 `get_symbols` — Function/class index

Returns exported symbols (functions, classes, interfaces, types) from a file without returning the full file content. Like a lightweight LSP.

```typescript
{
  name: 'get_symbols',
  description: 'List exported functions, classes, and types from a file with line numbers.',
  input_schema: {
    properties: {
      path: { type: 'string' },
      include_private: { type: 'boolean', description: 'Include non-exported symbols. Default: false' },
    }
  }
}
```

Response:
```
Exports from src/context.ts:
  interface GlobalOptions (line 28)
  interface OpsCliContext (line 41)
  interface RegistryCliContext (line 51)
  interface CoreExecOptions (line 61)
  interface CoreCliContext (line 71)
  function createOpsContext(options: GlobalOptions): OpsCliContext (line 120)
  function createRegistryContext(options: GlobalOptions): RegistryCliContext (line 163)
  function createUnauthenticatedContext(options: GlobalOptions) (line 215)
  function createCoreContext(options: GlobalOptions & CoreExecOptions): CoreCliContext (line 233)
  function handleOpsError(error: unknown, ctx): never (line 336)
  function handleRegistryError(error: unknown, ctx): never (line 348)
  function handleCoreError(error: unknown, ctx): never (line 364)
```

**Impact**: Agent can understand file structure without reading it. Can then use `read_file` with line ranges to read specific functions. Dramatically reduces tokens for large files.

**Implementation**: Parse with regex for TypeScript/JavaScript (look for `export function`, `export class`, `export interface`, `export type`, `export const`). No AST parser needed — regex is sufficient for symbol discovery.

### 2.4 `get_dependencies` — Package analysis

Returns dependency information from package.json/requirements.txt/go.mod without reading the full file.

```typescript
{
  name: 'get_dependencies',
  description: 'List project dependencies, devDependencies, and scripts from package manifest.',
  input_schema: {
    properties: {
      path: { type: 'string', description: 'Path to package.json, requirements.txt, etc. Default: "package.json"' },
    }
  }
}
```

**Impact**: Common validation task (checking for outdated deps, missing deps, security) gets a dedicated efficient tool.

### 2.5 `run_command` — Controlled shell execution

Executes a whitelisted shell command and returns output. More controlled than the current bash tool (which is Anthropic's provider-defined tool).

```typescript
{
  name: 'run_command',
  description: 'Run a command in the target directory. Allowed: tsc --noEmit, npm test, npm run lint, git diff, git log.',
  input_schema: {
    properties: {
      command: { type: 'string', description: 'Command to execute (must be in allowlist)' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds. Default: 30000' },
    }
  }
}
```

Allowlist (configurable per agent):
- `tsc --noEmit` — type checking
- `npm test` / `npx vitest run` — test execution
- `npm run lint` — linting
- `git diff --stat` — change summary
- `git log --oneline -20` — recent history

**Impact**: Agents can verify their findings with actual tool output (does the code compile? do tests pass?) rather than guessing from source alone.

### 2.6 `get_token_budget` — Self-regulation

Returns remaining token budget so the agent can decide when to stop reading and start producing output.

```typescript
{
  name: 'get_token_budget',
  description: 'Get approximate remaining context budget. Use this to decide whether to read more files or produce output.',
  input_schema: { properties: {} }
}
```

Response:
```json
{ "used_tokens": 125000, "max_tokens": 200000, "remaining_tokens": 75000, "utilization_pct": 62.5, "warning": null }
```

At 80% utilization, return a warning: `"warning": "Approaching context limit. Consider producing output soon."`

**Impact**: Agent learns to self-regulate instead of blindly reading until it crashes. Requires tracking approximate token usage in the tool loop (estimate from character count or use usage from `onStepFinish`).

---

## Phase 3: Context Management

### 3.1 Manual Tool Loop with Context Budgeting

Replace AI SDK's automatic `maxSteps` with a manual loop that tracks token usage.

```typescript
// Pseudocode
let messages = [{ role: 'user', content: initialMessage }];
let totalInputTokens = 0;

for (let step = 0; step < maxSteps; step++) {
  const result = await generateText({ system, messages, tools, maxSteps: 1 });
  totalInputTokens += result.usage.inputTokens;

  if (result.finishReason === 'stop') break;

  // Check budget
  if (totalInputTokens > TOKEN_BUDGET * 0.85) {
    // Inject a "wrap up" message
    messages.push({
      role: 'user',
      content: 'Context budget is at 85%. Please produce your final assessment now with the information gathered so far.'
    });
    continue;
  }

  // Add tool results to messages
  messages.push(...toolResults);
}
```

**Impact**: Agent gracefully degrades instead of crashing. Produces partial-but-useful output when context fills up.

### 3.2 Tool Result Truncation

After each step, check if any previous tool result exceeds a threshold (e.g., 4000 chars). If so, truncate to a summary:

```typescript
// After step N, truncate old tool results
for (const msg of messages.slice(0, -4)) {  // Keep last 4 messages intact
  if (msg.role === 'tool' && msg.content.length > 4000) {
    msg.content = msg.content.slice(0, 2000) + '\n\n[Truncated: originally ' + msg.content.length + ' chars]';
  }
}
```

**Impact**: Prevents any single large file read from permanently consuming context. The agent already processed the full content in an earlier step — the summary is sufficient for future reference.

### 3.3 Progressive Summarization (Advanced)

After every N steps, use a fast/cheap model (haiku) to summarize all tool results so far into a compact "findings so far" message, then replace old tool results with the summary.

This is what Claude Code does under the hood. It's the most effective approach but adds complexity (second model call, latency).

---

## Phase 4: Prompt Engineering

### 4.1 Context-Aware System Prompt Additions

Add guidance to the agent's system prompt about context management:

```
## Context Management

You have a limited context window (~200K tokens). Be strategic:

1. Use get_directory_tree first to understand project structure
2. Use get_symbols to understand file contents before reading
3. Use search_content in "files" mode to find relevant files
4. Read specific line ranges with read_file(start_line, end_line) instead of whole files
5. Check get_token_budget periodically — wrap up at 80%
6. Focus on the most impactful files first (entry points, main modules)
7. Skip node_modules, dist, build, and generated files
```

### 4.2 Tiered Analysis Strategy

Teach the agent a three-pass strategy:

```
## Analysis Strategy

Pass 1 - Survey (low tokens): get_directory_tree, get_dependencies, list file types
Pass 2 - Target (medium tokens): get_symbols on key files, search_content for patterns
Pass 3 - Deep dive (high tokens): read_file on specific functions/sections that need detailed review
```

---

## Implementation Priority

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | 1.1 `read_file` offset/limit | Small | High — immediate token savings |
| P0 | 3.1 Manual tool loop with budget | Medium | High — prevents crashes |
| P1 | 2.1 `get_file_info` | Small | Medium — free reconnaissance |
| P1 | 2.2 `get_directory_tree` | Small | Medium — structural overview |
| P1 | 2.6 `get_token_budget` | Small | Medium — self-regulation |
| P1 | 1.2 File sizes in `list_files` | Small | Medium — informed decisions |
| P2 | 2.3 `get_symbols` | Medium | High — huge token savings for large files |
| P2 | 1.4 `search_content` output modes | Small | Medium — targeted searching |
| P2 | 4.1 Context-aware prompt additions | Small | Medium — better agent behavior |
| P2 | 3.2 Tool result truncation | Medium | Medium — prevents single-file blowup |
| P3 | 2.5 `run_command` | Medium | Medium — verification capability |
| P3 | 2.4 `get_dependencies` | Small | Low — convenience |
| P3 | 3.3 Progressive summarization | High | High — closest to Claude Code's behavior |
| P3 | 1.5 `search_content` context lines | Small | Low — nice-to-have |
