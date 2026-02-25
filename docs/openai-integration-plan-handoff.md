# OpenAI Provider Integration — Implementation Plan

**Date**: 2026-02-25
**Status**: Ready for implementation
**Version**: v0.2.0 (multi-provider)
**Scope**: Add OpenAI as the second AI provider to `@uluops/core`

---

## 1. Architecture Summary

The core-sdk was designed for multi-provider support from day one. The v0.1.0 release intentionally
shipped Anthropic-only to reduce initial complexity. The architecture has 7 provider-agnostic layers
that require zero changes for OpenAI:

| Layer | Status | Why |
|-------|--------|-----|
| `ensureProvider()` dynamic import | Works | Already calls `createOpenAI({ apiKey })` via `@ai-sdk/${providerName}` convention |
| `ModelCatalog` alias resolution | Works | OpenAI aliases (gpt4, gpt4-mini, o1, o3) already in registry DB |
| `UluOpsConfig.ai.providers` | Works | Provider-agnostic `Record<string, { apiKey }>` |
| `resolveAIConfig()` env fallback | Works | Convention `${PROVIDER}_API_KEY` resolves `OPENAI_API_KEY` |
| `TokenBudgetTracker` | Works | Tracks input/output tokens, provider-agnostic |
| `prepareStep` budget wrap-up | Works | 80% threshold is provider-agnostic |
| `ToolHandler` / `ToolAdapter` | Works | Standard AI SDK `ToolSet` format |
| Error mapping (`mapError`) | Works | HTTP-status-based. AI SDK normalizes all provider errors to `APICallError` with `statusCode` — verified for both `@ai-sdk/anthropic` and `@ai-sdk/openai` (both use `ai` core's retry/error layer). Our `isAPICallError()` guard checks for `statusCode in error`, which works for any AI SDK provider. |

**What needs work**: 5 targeted changes in `AIProvider.ts` + 1 dependency + tests + auto-detection + docs.

**Alternative rejected**: Keep `@ai-sdk/openai` as a dynamic-only peer dependency,
relying on `ensureProvider()` for lazy import. Rejected because: (1) Anthropic is already
a hard dep — asymmetric treatment is confusing for consumers, (2) provider-defined tools
(`shell`, `webSearch`) require eager instance access, which means static import anyway,
(3) `npm install` friction for a 50KB tree-shakeable package is not worth the tradeoff.

---

## 2. Implementation Tasks

### Phase 1: Dependency & Initialization

#### Task 1.1 — Add `@ai-sdk/openai` dependency
**File**: `packages/uluops-core-sdk/package.json`
**Change**: Add to `dependencies` (not optional — OpenAI is a first-class provider)
```jsonc
"@ai-sdk/openai": "^3.0.0"
```
**Rationale**: `@ai-sdk/anthropic` is already a hard dependency. Keeping both as hard deps
means users don't need to install peer deps manually. The package is ~50KB and tree-shakes
well. The dynamic import in `ensureProvider()` still gates actual usage behind API key
presence, so no runtime cost for Anthropic-only users.

**Verification step** (run immediately after install):
```bash
npm info @ai-sdk/openai version          # confirm v3.x is published
cat node_modules/@ai-sdk/openai/dist/index.d.ts | head -50  # check exports
# Specifically look for: createOpenAI, shell tool types, execute callback signature
```

#### Task 1.2 — Eager initialization in `initializeProviders()`
**File**: `src/ai/AIProvider.ts` — `initializeProviders()` (line 390)
**Current**: Only Anthropic is eagerly initialized and stored as `this.anthropicInstance`.
**Change**: Add OpenAI eager init when credentials exist. Required because OpenAI's
provider-defined tools (shell, web search) need the provider instance, same as Anthropic's
`bash_20250124`.

```typescript
// New field on AIProvider class
// VERIFIED: @ai-sdk/openai DOES export OpenAIProvider (index.d.ts:1054)
private openaiInstance?: OpenAIProvider;

// In initializeProviders():
if (providerName === 'openai') {
  const openai = createOpenAI({ apiKey: creds.apiKey });
  this.openaiInstance = openai;
  this.providers.set('openai', (modelId) => openai(modelId));
}
```

**Import**: `import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';`

**VERIFIED** (2026-02-25): `@ai-sdk/openai` exports `OpenAIProvider` as a named type
(index.d.ts:1054). Same pattern as `AnthropicProvider` from `@ai-sdk/anthropic`.

This is a static import (not dynamic) because `@ai-sdk/openai` is now a hard dependency.
The `ensureProvider()` dynamic import path still works as a fallback for any provider
not eagerly initialized.

---

### Phase 2: Provider Options

#### Task 2.1 — OpenAI provider options in `buildProviderOptions()`
**File**: `src/ai/AIProvider.ts` — `buildProviderOptions()` (line 304)
**Current**: Returns `userOptions` unchanged for non-Anthropic providers.
**Change**: Add OpenAI-specific option handling.

```typescript
private buildProviderOptions(
  resolved: ResolvedModel,
  userOptions?: ProviderOptions,
): ProviderOptions | undefined {
  if (resolved.provider === 'anthropic') {
    return this.buildAnthropicOptions(resolved, userOptions);
  }

  if (resolved.provider === 'openai') {
    return this.buildOpenAIOptions(resolved, userOptions);
  }

  return userOptions;
}
```

**New method** `buildOpenAIOptions()`:
```typescript
private buildOpenAIOptions(
  resolved: ResolvedModel,
  userOptions?: ProviderOptions,
): ProviderOptions | undefined {
  const userOpenAIOpts = (userOptions?.openai ?? {}) as Record<string, unknown>;
  let openaiOpts = { ...userOpenAIOpts };

  // Auto-set reasoningEffort for reasoning models if user hasn't specified
  if (resolved.capabilities.extendedThinking && !('reasoningEffort' in openaiOpts)) {
    openaiOpts = {
      ...openaiOpts,
      reasoningEffort: 'medium',
    };
  }

  // Return undefined if no options to set (avoids empty provider key)
  if (Object.keys(openaiOpts).length === 0) {
    return userOptions;
  }

  return {
    ...(userOptions ?? {}),
    openai: openaiOpts as Record<string, unknown>,
  } as ProviderOptions;
}
```

**Key decisions**:
- **`reasoningEffort: 'medium'`** as default — matches OpenAI's default. Unlike Anthropic's
  thinking budget (which has a token cost), reasoning effort is a hint, so defaulting to
  medium is safe. Users override via `providerOptions.openai.reasoningEffort`.
- **No context management** — OpenAI has no equivalent of `clear_tool_uses_20250919`. The
  `prepareStep` budget wrap-up (forcing `toolChoice: 'none'` at 80%) is the only context
  protection for OpenAI models.
- **No `systemMessageMode`** — `@ai-sdk/openai` automatically converts system messages to
  developer messages for reasoning models (see `docs/ai-sdk/providers/openai.md:251` and
  `:1462-1464`). No SDK action needed. Users who want explicit control can pass
  `systemMessageMode: 'system' | 'developer' | 'remove'` via `providerOptions.openai`.
- **`reasoningEffort` on non-reasoning models** — If passed to a non-reasoning OpenAI model
  (e.g., gpt-4o), the option is ignored by the API. No guard needed in our code.
- **No `promptCacheKey`/`promptCacheRetention`** — OpenAI caching is automatic for prompts
  ≥1024 tokens. We don't need to manage it explicitly. Users who want manual control can
  pass it through `providerOptions.openai`.

**Refactor note**: Extract existing Anthropic logic into `buildAnthropicOptions()` for symmetry.
Same code, just moved into a named method. Keeps `buildProviderOptions()` as a clean dispatcher.

---

### Phase 3: Provider-Defined Tools

#### Task 3.1 — OpenAI shell tool support
**File**: `src/ai/AIProvider.ts` — `createBashTool()` (line 238)
**Current**: Returns Anthropic's `bash_20250124` provider tool or `undefined`.
**Change**: Rename to `createProviderShellTool()` and support both providers.

```typescript
/**
 * Create provider-defined shell tool for the resolved model's provider.
 * - Anthropic: bash_20250124 (Claude's built-in bash knowledge)
 * - OpenAI: openai.tools.shell() with local execution callback
 * Returns undefined if the model's provider has no shell tool support.
 */
createProviderShellTool(
  provider: string,
  targetDir: string,
  timeoutMs = 30_000,
): ToolSet | undefined {
  if (provider === 'anthropic' && this.anthropicInstance) {
    return {
      bash: this.anthropicInstance.tools.bash_20250124({
        // Anthropic bash tool: execute returns Promise<string>
        execute: async ({ command }) => this.executeShellAsString(command, targetDir, timeoutMs),
      }),
    };
  }

  if (provider === 'openai' && this.openaiInstance) {
    return {
      shell: this.openaiInstance.tools.shell({
        // OpenAI shell tool: execute receives { action } and must return
        // { output: Array<{ stdout, stderr, outcome }> } — NOT a plain string.
        // See docs/ai-sdk/providers/openai.md:854-860 for the contract.
        execute: async ({ action }) => {
          return this.executeShellAsOpenAIResult(action, targetDir, timeoutMs);
        },
      }),
    };
  }

  return undefined;
}
```

**IMPORTANT — Return type difference between providers**:

The Anthropic `bash_20250124` execute callback returns `Promise<string>`.
The OpenAI `shell` execute callback returns `Promise<{ output: Array<ShellResult> }>` where:
```typescript
interface ShellResult {
  stdout: string;
  stderr: string;
  outcome: { type: 'exit'; exitCode: number } | { type: 'timeout' };
}
```

These are **different contracts** — a shared `executeShellCommand()` returning a plain string
would fail for OpenAI. Instead, extract two methods that share a common low-level runner:

```typescript
/** Low-level command runner — returns raw stdout/stderr/exitCode */
private async runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout || '', stderr: stderr || '', timedOut: false, exitCode: 0 };
  } catch (error) {
    const err = error as { killed?: boolean; signal?: string; stderr?: string; code?: number; stdout?: string };
    if (err.killed || err.signal) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', timedOut: true, exitCode: 1 };
    }
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || String(error),
      timedOut: false,
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

/** Anthropic bash tool: returns plain string */
private async executeShellAsString(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const result = await this.runCommand(command, cwd, timeoutMs);
  if (result.timedOut) return `Command timed out after ${timeoutMs}ms`;
  return result.stdout || result.stderr || '(no output)';
}

/** OpenAI shell tool: returns { output: Array<{ stdout, stderr, outcome }> }
 *  VERIFIED: action.commands is string[] — one result per command in the array. */
private async executeShellAsOpenAIResult(
  action: { commands: string[]; timeoutMs?: number; maxOutputLength?: number },
  cwd: string,
  defaultTimeoutMs: number,
): Promise<{ output: Array<{ stdout: string; stderr: string; outcome: { type: 'timeout' } | { type: 'exit'; exitCode: number } }> }> {
  const commands = this.extractCommandsFromAction(action);
  const timeoutMs = action.timeoutMs ?? defaultTimeoutMs;
  const results = [];

  for (const command of commands) {
    const result = await this.runCommand(command, cwd, timeoutMs);
    results.push({
      stdout: result.stdout,
      stderr: result.stderr,
      outcome: result.timedOut
        ? { type: 'timeout' as const }
        : { type: 'exit' as const, exitCode: result.exitCode },
    });
  }

  return { output: results };
}

/** VERIFIED (2026-02-25): Shell tool action shape from @ai-sdk/openai index.d.ts:718-722:
 *  { commands: string[], timeoutMs?: number, maxOutputLength?: number }
 *  Note: `commands` is PLURAL (array of command strings).
 *  The localShell tool uses singular `command: string[]` — different shape. */
private extractCommandsFromAction(
  action: { commands: string[]; timeoutMs?: number; maxOutputLength?: number },
): string[] {
  return action.commands;
}
```

**Breaking change**: `createBashTool()` → `createProviderShellTool()` signature changes.
This is an internal API (not exported from package). Only caller is `AgentExecutor.ts:58`.

**Implementation note**: During Task 1.1 (after `npm install @ai-sdk/openai`), immediately
inspect `node_modules/@ai-sdk/openai/dist/index.d.ts` to verify:
1. The shell tool `execute` callback's `action` parameter shape
2. The expected return type of the `execute` callback
3. Whether `OpenAIProvider` is exported as a named type
Update this section with confirmed types before writing production code.

#### Task 3.2 — Update AgentExecutor caller
**File**: `src/executor/AgentExecutor.ts` (line 54-59)
**Current**:
```typescript
if (agentTools?.includes('bash')) {
  additionalTools = this.aiProvider.createBashTool(input.target, context.timeoutMs);
}
```
**Change**: Pass the resolved provider name so the right tool variant is created:
```typescript
if (agentTools?.includes('bash')) {
  additionalTools = this.aiProvider.createProviderShellTool(
    resolved.provider ?? 'anthropic',   // provider from model resolution
    input.target,
    context.timeoutMs,
  );
}
```

**Approach**: Resolve model early in `AgentExecutor.execute()` to get the provider name
before tool setup. This avoids double-resolution (once for tools, once in `generate()`).

```typescript
// In AgentExecutor.execute(), before tool setup (replaces inline model resolution):
const modelInput = options?.model ?? defaults?.model ?? this.config.ai.modelOverride ?? 'sonnet';
const resolvedModel = await this.aiProvider.resolveModel(modelInput);
const providerName = resolvedModel.provider;
// ... use providerName for createProviderShellTool()
// ... pass resolvedModel to generate() to skip re-resolution
```

This requires a new method on AIProvider. Mark it `@internal` since it is needed by
`AgentExecutor` (an internal class) but should not be part of the public SDK API:

```typescript
/**
 * Resolve model alias and ensure provider is loaded.
 * @internal Used by AgentExecutor for early provider detection.
 */
async resolveModel(input: string, opts?: { requiredCapabilities?: Array<keyof ModelCapabilities> }): Promise<ResolvedModel> {
  const resolved = await this.catalog.resolve(input, opts);
  await this.ensureProvider(resolved.provider);
  return resolved;
}
```

**Rejected alternatives**:
- *Expose `catalog` directly*: Leaks internal abstraction. AgentExecutor shouldn't
  depend on ModelCatalog.
- *`getDefaultProvider()` method*: Doesn't help — we need the provider for a specific
  model, not the default.
- *Resolve inside `createProviderShellTool()`*: Would make the shell tool creation async
  AND coupled to model resolution — violates single responsibility.

---

### Phase 4: Usage Mapping

#### Task 4.1 — OpenAI cache metrics in `mapUsage()`
**File**: `src/ai/AIProvider.ts` — `mapUsage()` (line 468)
**Current**: Extracts cache tokens from `inputTokenDetails` (AI SDK standard) + Anthropic
provider metadata fallback.
**Change**: Add OpenAI provider metadata path.

```typescript
private mapUsage(
  usage: { ... },
  providerMetadata?: Record<string, unknown>,
): UsageMetrics {
  const base: UsageMetrics = { ... };

  // 1. AI SDK standard path (works for both providers)
  if (usage.inputTokenDetails) {
    base.cache_read_input_tokens = usage.inputTokenDetails.cacheReadTokens ?? undefined;
    base.cache_creation_input_tokens = usage.inputTokenDetails.cacheWriteTokens ?? undefined;
  }

  // 2. Anthropic provider metadata fallback
  const anthropicMeta = providerMetadata as {
    anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
  } | undefined;
  if (anthropicMeta?.anthropic) {
    base.cache_creation_input_tokens ??= anthropicMeta.anthropic.cacheCreationInputTokens;
    base.cache_read_input_tokens ??= anthropicMeta.anthropic.cacheReadInputTokens;
  }

  // 3. OpenAI provider metadata fallback
  const openaiMeta = providerMetadata as {
    openai?: { cachedPromptTokens?: number; reasoningTokens?: number };
  } | undefined;
  if (openaiMeta?.openai) {
    base.cache_read_input_tokens ??= openaiMeta.openai.cachedPromptTokens;
    // Note: OpenAI has no cache_creation equivalent — caching is automatic
  }

  return base;
}
```

**OpenAI reasoning tokens**: `openaiMeta.openai.reasoningTokens` is available but doesn't
map to our current `UsageMetrics` type. Consider adding `reasoning_tokens?: number` to
`UsageMetrics` for future use:

```typescript
// In src/types/ai.ts — UsageMetrics
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;  // NEW — OpenAI reasoning models
}
```

This is additive and backwards-compatible. Populate when available:
```typescript
if (openaiMeta?.openai?.reasoningTokens) {
  base.reasoning_tokens = openaiMeta.openai.reasoningTokens;
}
```

---

### Phase 5: CLI Passthrough

#### Task 5.1 — Auto-detect OpenAI in CLI
**File**: `packages/cli/src/context.ts` — `createCoreContext()` (line 233)
**Current**: Passes no `ai` config to `UluOpsClient`, so `resolveAIConfig()` defaults to
Anthropic-only from `ANTHROPIC_API_KEY`.
**Change**: When `OPENAI_API_KEY` is present in env, include OpenAI in the providers config.

```typescript
// In createCoreContext(), before constructing config:
const aiProviders: Record<string, { apiKey?: string }> = {
  anthropic: {},  // resolved from ANTHROPIC_API_KEY by resolveAIConfig
};

// Auto-detect OpenAI from env
if (process.env['OPENAI_API_KEY']) {
  aiProviders.openai = {};  // resolved from OPENAI_API_KEY by resolveAIConfig
}

const config: UluOpsConfig = {
  apiKey,
  ai: { providers: aiProviders },
  // ... rest unchanged
};
```

**Why this is needed**: `resolveAIConfig()` only populates providers that are keys in
`ai.providers`. If `ai` is omitted entirely, it defaults to Anthropic-only. By passing
an explicit `providers` map with both entries, `resolveAIConfig()` will resolve API keys
from env vars for both.

**Alternative** (simpler): Modify `resolveAIConfig()` to auto-detect all known providers
from env vars even when no explicit config is passed. This would be a change in
`UluOpsClient.ts`:

```typescript
private resolveAIConfig(ai?: AIConfig): ResolvedAIConfig {
  const providers: Record<string, { apiKey: string }> = {};
  const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google'] as const;

  if (ai?.providers) {
    // Explicit config — use it with env fallback
    for (const [name, creds] of Object.entries(ai.providers)) {
      const envKey = `${name.toUpperCase()}_API_KEY`;
      const apiKey = creds.apiKey ?? process.env[envKey];
      if (apiKey) providers[name] = { apiKey };
    }
  } else {
    // No explicit config — auto-detect from known env vars
    for (const name of KNOWN_PROVIDERS) {
      const envKey = `${name.toUpperCase()}_API_KEY`;
      const apiKey = process.env[envKey];
      if (apiKey) providers[name] = { apiKey };
    }
  }

  return {
    providers,
    defaultProvider: ai?.defaultProvider ?? 'anthropic',
    modelOverride: ai?.modelOverride,
  };
}
```

**Decision**: Use the simpler approach in `UluOpsClient.resolveAIConfig()`. This eliminates
the need for CLI changes entirely and benefits all SDK consumers, not just the CLI. The
`KNOWN_PROVIDERS` list is a minimal maintenance burden.

---

### Phase 6: Tests

#### Task 6.1 — Fix existing Anthropic mock + add OpenAI mock
**File**: `test/ai/AIProvider.test.ts`

**Pre-existing gap**: The existing `vi.mock('@ai-sdk/anthropic')` (line 25-30) creates a
provider function but does **not** mock `provider.tools.bash_20250124`. This means
`createBashTool()` / `createProviderShellTool()` tests will fail for Anthropic unless
the mock is updated. Fix this first.

**Updated Anthropic mock** (fixes pre-existing gap):
```typescript
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-model' }));
    // Mock provider-defined tools (needed for createProviderShellTool tests)
    provider.tools = {
      bash_20250124: vi.fn((opts: { execute: Function }) => ({
        type: 'provider-defined',
        name: 'bash',
        execute: opts.execute,
      })),
    };
    return provider;
  }),
}));
```

**New OpenAI mock**:
```typescript
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-openai-model' }));
    // Mock provider-defined tools
    provider.tools = {
      shell: vi.fn((opts: { execute?: Function }) => ({
        type: 'provider-defined',
        name: 'shell',
        execute: opts.execute,
      })),
    };
    return provider;
  }),
}));
```

**OpenAI config variant**:
```typescript
const mockConfigWithOpenAI: ResolvedConfig = {
  ...mockConfig,
  ai: {
    providers: {
      anthropic: { apiKey: 'test-anthropic-key' },
      openai: { apiKey: 'test-openai-key' },
    },
    defaultProvider: 'anthropic',
  },
};
```

#### Task 6.2 — Test cases to add (~15 tests)

**`ensureProvider` tests**:
- `it('loads OpenAI provider from config')` — verify `providers.has('openai')` after init
- `it('creates openaiInstance for provider-defined tools')` — verify shell tool creation

**`buildProviderOptions` tests** (access via `generate()` call inspection):
- `it('sets reasoningEffort for OpenAI reasoning models')` — resolve o3, check providerOptions
- `it('does not set reasoningEffort for non-reasoning OpenAI models')` — resolve gpt-4o
- `it('does not inject context management for OpenAI')` — verify no clear_tool_uses

**`createProviderShellTool` tests**:
- `it('returns Anthropic bash tool when provider is anthropic')`
- `it('returns OpenAI shell tool when provider is openai')`
- `it('returns undefined for unsupported providers')`

**`mapUsage` tests** (access via `generate()` return):
- `it('maps OpenAI cachedPromptTokens to cache_read_input_tokens')`
- `it('maps OpenAI reasoningTokens to reasoning_tokens')`
- `it('prefers inputTokenDetails over provider metadata')`

**`resolveModel` test**:
- `it('resolves and ensures provider is loaded')`

**Error-path tests** (new — addresses pre-impl review gap):
- `it('throws ConfigurationError when OpenAI model requested but no OPENAI_API_KEY')`
  — config with only Anthropic, resolve `openai:gpt-4o`, expect ConfigurationError
- `it('maps OpenAI 429 to RateLimitError')` — same as Anthropic 429 test, but with
  OpenAI config active to verify error mapping works identically
- `it('falls back to SdkApiError for unknown OpenAI errors')` — status 422 or similar

---

## 3. File Change Summary

| File | Changes | Lines Est. |
|------|---------|-----------|
| `package.json` | Add `@ai-sdk/openai` dep, bump version to 0.2.0 | +2 |
| `src/ai/AIProvider.ts` | Import OpenAI, new field, init, options, shell tool (with 3 helper methods), usage | +120, -20 |
| `src/types/ai.ts` | Add `reasoning_tokens` to `UsageMetrics` | +1 |
| `src/client/UluOpsClient.ts` | Auto-detect providers from env via `KNOWN_PROVIDERS` | +10, -5 |
| `src/executor/AgentExecutor.ts` | Update shell tool call, early model resolution | +8, -3 |
| `test/ai/AIProvider.test.ts` | Fix Anthropic mock, add OpenAI mock, ~15 test cases | +180 |
| `README.md` | Add `OPENAI_API_KEY` env var, multi-provider config example | +15 |
| `CHANGELOG.md` | Add `[Unreleased]` section for v0.2.0 | +12 |
| **Total** | | ~+348, -28 |

---

## 4. Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | `@ai-sdk/openai` as hard dep, not peer | Matches `@ai-sdk/anthropic` treatment. Tree-shakes. No user install step. Dynamic-only peer dep rejected (see Section 1). |
| D2 | Static import (not dynamic) | Hard dep means we can import at module level. Eager init for tool access. |
| D3 | `reasoningEffort: 'medium'` default | Matches OpenAI default. Safe — it's a hint, not a budget. Ignored on non-reasoning models. |
| D4 | No explicit cache control for OpenAI | OpenAI caching is automatic. Users can passthrough via providerOptions. |
| D5 | Auto-detect providers from env vars | Simpler than CLI passthrough. Benefits all SDK consumers. |
| D6 | Rename `createBashTool` → `createProviderShellTool` | Reflects multi-provider reality. Internal API only. |
| D7 | Add `reasoning_tokens` to UsageMetrics | Forward-compatible. Additive. Useful for cost tracking. |
| D8 | Early model resolution in AgentExecutor | Needed to pick the right shell tool before generation starts. Expose via `@internal resolveModel()`. |
| D9 | Use `OpenAIProvider` named type directly | VERIFIED: `@ai-sdk/openai` exports `OpenAIProvider` (index.d.ts:1054). Same pattern as Anthropic. |
| D10 | Separate `executeShellAsString` / `executeShellAsOpenAIResult` | Anthropic returns `string`, OpenAI returns `{ output: Array<{ stdout, stderr, outcome }> }`. Cannot share return path. Share `runCommand()` low-level runner. |
| D11 | Update README and CHANGELOG alongside code | Consumer-facing SDK needs docs updated in same PR to avoid silent behavior changes. |

---

## 5. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenAI shell tool API differs from docs | Medium | Inspect `node_modules/@ai-sdk/openai/dist/index.d.ts` immediately after `npm install` (Task 1.1). Update shell tool code before writing tests. |
| Shell tool `action` parameter shape unknown | Medium | `extractCommandFromAction()` handles array, string, and fallback. Verify against actual types in Task 1.1. |
| Breaking `createBashTool` callers | Low | Only 1 internal caller (AgentExecutor). Renamed in same PR. |
| `OPENAI_API_KEY` auto-detection surprises | Low | Only adds provider if env var present. `defaultProvider` remains `anthropic` — model alias must explicitly resolve to OpenAI for OpenAI models to be used. A user with `OPENAI_API_KEY` set for unrelated purposes will see no behavior change unless they request an OpenAI model alias (gpt4, o3, etc). |
| Model resolves to OpenAI but no API key | Low | `ensureProvider('openai')` throws `ConfigurationError` with message: `AI provider "openai" is not configured. Add it to config.ai.providers...`. Existing behavior, no change needed. |
| OpenAI reasoning token accounting | Low | Additive field. Existing code ignores unknown fields. |
| Registry model aliases stale | Low | OpenAI aliases already seeded. `models sync` command exists for updates. |

**Edge cases (documented for implementer awareness)**:
- **No `OPENAI_API_KEY` but user passes `--model gpt4`**: ModelCatalog resolves `gpt4` →
  `openai:gpt-4o-...`. `ensureProvider('openai')` checks `config.ai.providers['openai']` →
  not present → throws `ConfigurationError`. User sees: `AI provider "openai" is not configured.`
- **Both API keys set, alias resolves to wrong provider**: Not possible. Aliases are
  provider-specific in the registry DB (`gpt4` → `openai:gpt-4o`, `sonnet` → `anthropic:claude-sonnet`).
  `defaultProvider` is only used for tier resolution, not alias resolution.
- **`reasoningEffort` passed to non-reasoning model**: Ignored by OpenAI API. No error, no guard needed.

---

## 6. Implementation Order

```
Phase 1 (Foundation)
├── 1.1  npm install @ai-sdk/openai
│        └── GATE: Inspect node_modules/@ai-sdk/openai/dist/index.d.ts
│                  Verify: shell tool action shape, execute return type,
│                  whether OpenAIProvider type is exported.
│                  Update Phase 3 code if types differ from plan.
├── 1.2  Eager initialization + static import (ReturnType<typeof createOpenAI>)
│
Phase 2 (Provider Options)
├── 2.1  buildOpenAIOptions + refactor buildAnthropicOptions
│
Phase 3 (Provider Tools)
├── 3.1  createProviderShellTool + runCommand + dual return adapters
├── 3.2  AgentExecutor: early model resolution via @internal resolveModel()
│
Phase 4 (Usage)
├── 4.1  mapUsage OpenAI path + reasoning_tokens in UsageMetrics
│
Phase 5 (Auto-detection)
├── 5.1  resolveAIConfig KNOWN_PROVIDERS auto-detect from env vars
│
Phase 6 (Tests)
├── 6.1  Fix Anthropic mock (add tools.bash_20250124) + add OpenAI mock
├── 6.2  ~15 test cases (12 happy-path + 3 error-path)
│
Phase 7 (Documentation)
├── 7.1  README: add OPENAI_API_KEY env var row, multi-provider config example
├── 7.2  CHANGELOG: add [Unreleased] section for v0.2.0
├── 7.3  package.json: bump version to 0.2.0
│
Phase 8 (Verification)
├── 8.1  typecheck + existing tests pass (335 + 15 new = 350)
├── 8.2  Live test: OPENAI_API_KEY + exec agent code-validator --model gpt4
└── 8.3  Live test: exec agent code-validator --model o3 (reasoning model)
```

---

## 7. Documentation Updates

### Task 7.1 — README updates
**File**: `README.md`

**Changes**:
1. Update "AI Provider Keys" section (line 86-106) to show both providers:
```bash
export ANTHROPIC_API_KEY=your_anthropic_key
export OPENAI_API_KEY=your_openai_key    # optional — enables OpenAI models
```

2. Add OpenAI to the providers config example:
```typescript
ai: {
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
},
```

3. Add `OPENAI_API_KEY` row to environment variables table (line 303-311):
```
| `OPENAI_API_KEY` | OpenAI provider key (auto-detected) | - |
```

### Task 7.2 — CHANGELOG [Unreleased] section
**File**: `CHANGELOG.md`

Add at top, before `## [0.1.0]`:
```markdown
## [Unreleased]

### Added
- OpenAI provider support via `@ai-sdk/openai` — use models like `gpt4`, `o3`, `o4-mini`
- Auto-detection of `OPENAI_API_KEY` from environment (no explicit config needed)
- `reasoning_tokens` field in `UsageMetrics` for OpenAI reasoning models
- OpenAI shell tool support via `openai.tools.shell()` with local execution

### Changed
- `createBashTool()` renamed to `createProviderShellTool()` (internal API)
- `resolveAIConfig()` now scans known provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
- `buildProviderOptions()` refactored into per-provider methods

### Dependencies
- Added `@ai-sdk/openai` ^3.0.0
```

### Task 7.3 — Version bump
**File**: `package.json`
**Change**: `"version": "0.1.0"` → `"version": "0.2.0"`

---

## 8. Pre-Implementation Review Resolution

This plan was reviewed by `pre-implementation-architect` (87/100, PROCEED) and
`docs-validator` (70/100, PARTIALLY_DOCUMENTED) on 2026-02-25.

**All flagged issues have been resolved in this revision:**

| # | Issue | Resolution |
|---|-------|------------|
| 1 | Shell tool execute callback return type mismatch (SEM-COM/H) | Split into `executeShellAsString()` and `executeShellAsOpenAIResult()` with shared `runCommand()` |
| 2 | `OpenAIProvider` type export unverified (EPI-OVR/H) | Changed to `ReturnType<typeof createOpenAI>`. Added verification gate in Phase 1. |
| 3 | Shell tool `action.command` shape unverified (EPI-OVR/M) | Added `extractCommandFromAction()` with multiple fallback patterns. Gate in Phase 1. |
| 4 | OpenAI error handling not validated (SEM-COM/M) | Documented AI SDK error normalization in architecture table. |
| 5 | README omits OpenAI (SEM-COM/M) | Added Task 7.1 with specific README changes. |
| 6 | CHANGELOG missing [Unreleased] (STR-OMI/M) | Added Task 7.2 with full changelog section. |
| 7 | AgentExecutor approach ambiguous (SEM-AMB/M) | Committed to approach A. Struck rejected alternatives with rationale. |
| 8 | Anthropic mock missing `tools` property (SEM-COM/M) | Added to Task 6.1 — fix Anthropic mock before adding OpenAI mock. |
| 9 | No error-path tests (STR-OMI/L) | Added 3 error-path test cases to Task 6.2. |
| 10 | `resolveModel()` public API concern (STR-EXC/L) | Marked `@internal` in JSDoc. Rejected alternatives documented. |

---

## 9. References

| Resource | Path |
|----------|------|
| AIProvider source | `packages/uluops-core-sdk/src/ai/AIProvider.ts` |
| ModelCatalog source | `packages/uluops-core-sdk/src/ai/ModelCatalog.ts` |
| Config types | `packages/uluops-core-sdk/src/types/config.ts` |
| Usage types | `packages/uluops-core-sdk/src/types/ai.ts` |
| AgentExecutor | `packages/uluops-core-sdk/src/executor/AgentExecutor.ts` |
| UluOpsClient | `packages/uluops-core-sdk/src/client/UluOpsClient.ts` |
| Test file | `packages/uluops-core-sdk/test/ai/AIProvider.test.ts` |
| OpenAI AI SDK docs | `packages/uluops-core-sdk/docs/ai-sdk/providers/openai.md` |
| Original spec | `uluops-core-docs/specs/uluops-ai-sdk-integration-spec-v0_1_0.md` |
| Registry alias seed | `uluops-registry-api/src/database/seeds/003_aliases.ts` |
