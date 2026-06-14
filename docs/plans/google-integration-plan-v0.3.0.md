# Google/Gemini Provider Integration — Implementation Plan

**Date**: 2026-02-25
**Status**: Ready for implementation
**Version**: v0.3.0 (hybrid top-3 providers)
**Scope**: Add Google/Gemini as the third bundled AI provider + improve dynamic provider DX

---

## 1. Architecture Summary

The core-sdk bundles Anthropic (v0.1.0) and OpenAI (v0.2.0) as eagerly-initialized providers with
provider-specific options, shell tools, and usage metadata mapping. All other providers work via a
dynamic `ensureProvider()` import path but get no auto-tuning.

**v0.3.0 adds Google/Gemini as the third bundled provider.** Google has unique features that warrant
provider-specific code: thinking config (thinkingBudget for Gemini 2.5, thinkingLevel for Gemini 3),
implicit caching, Google Search grounding, code execution tools, and 1M+ context windows.

Additionally, v0.3.0 improves the dynamic provider path for non-bundled providers (DeepSeek, Mistral,
xAI, Cohere) with better factory name resolution and generic usage metadata extraction.

### Provider Comparison Matrix

| Feature | Anthropic | OpenAI | Google (NEW) | Dynamic (others) |
|---------|-----------|--------|-------------|-----------------|
| Import type | Static (bundled) | Static (bundled) | Static (bundled) | Dynamic (lazy) |
| Instance stored | `anthropicInstance` | `openaiInstance` | `googleInstance` | No |
| Provider options | thinking, contextMgmt | reasoningEffort | thinkingConfig | Passthrough |
| System message | Cache control wrapper | Plain string | Plain string | Plain string |
| Shell/code tool | bash_20250124 | shell() | None (codeExec is remote) | None |
| Cache strategy | Explicit (ephemeral) | Automatic | Automatic (implicit) | Unknown |
| Usage metadata | cache tokens | cache + reasoning | cache + thinking | Base only → generic |

### Registry Status (Already Seeded)

| Component | Status |
|-----------|--------|
| Provider `google` | Active in 001_providers.ts |
| Models | `gemini-2.5-flash` (extendedThinking: true), `gemini-2-flash` (false) |
| Aliases | `gemini` → gemini-2.5-flash, `gemini-flash` → gemini-2-flash |
| KNOWN_PROVIDERS | Already includes `'google'` in resolveAIConfig() |

---

## 2. Critical Discovery: Naming Mismatches

| Aspect | SDK Convention | Google Actual | Impact |
|--------|--------------|---------------|--------|
| Factory function | `createGoogle` | `createGoogleGenerativeAI` | Dynamic `ensureProvider()` would fail |
| Env var | `GOOGLE_API_KEY` | `GOOGLE_GENERATIVE_AI_API_KEY` | Auto-detect wouldn't find key |

**Resolution**: Bundled provider uses static import (bypasses factory name issue). Dual env var
check covers both conventions. `FACTORY_NAME_OVERRIDES` map added to `ensureProvider()` as
fallback safety.

---

## 3. Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | `@ai-sdk/google` as hard dep (like anthropic, openai) | Bundled = hard dep. ~50KB, tree-shakes. No user install friction. Matches D1 from OpenAI plan. |
| D2 | Store `googleInstance` field | Matches established pattern. Enables future provider-defined tools (googleSearch, codeExecution). Zero runtime cost. |
| D3 | Auto-enable `thinkingConfig.thinkingBudget` for extendedThinking models | Mirrors Anthropic thinking and OpenAI reasoningEffort auto-enable. Uses `config.defaultThinkingBudget` (10K). |
| D4 | Add `thinking_tokens` field to UsageMetrics | Distinct from `reasoning_tokens` (OpenAI). Maps Google's `thoughtsTokenCount`. Additive, backwards-compatible. |
| D5 | Check both `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` | Users may have either set. Our convention is `GOOGLE_API_KEY`; Google SDK default is the long form. |
| D6 | Add `FACTORY_NAME_OVERRIDES` map in `ensureProvider()` | Fixes the dynamic path for providers with non-standard factory names. Fallback safety for Google. |
| D7 | No Google shell tool wiring | Google has `codeExecution` (remote Python on Google servers), not local bash. Our agent `tools: ['bash']` opt-in doesn't apply. Future: add `tools: ['code_execution']` support. |
| D8 | No system message wrapping for Google | Caching is implicit for Gemini 2.5+ (like OpenAI). Plain string passthrough. No action needed. |
| D9 | Generic provider metadata scan for non-bundled providers | Best-effort cache token extraction from `providerMetadata[providerName]` for unknown providers. Checks fields: `cachedTokens` (number), `cachedContentTokenCount` (number). Maps to `cache_read_input_tokens`. Uses `??=` to never override provider-specific values already set by bundled extractors. |

---

## 4. Implementation Tasks

### Phase 1: Dependency & Types

#### Task 1.1 — Add `@ai-sdk/google` dependency
**File**: `packages/uluops-core-sdk/package.json`
**Change**: Add to `dependencies` (not optional — Google is a first-class bundled provider)
```jsonc
"@ai-sdk/google": "^3.0.0"
```

**Verification step** (run immediately after install):
```bash
npm install
cat node_modules/@ai-sdk/google/dist/index.d.ts | head -80  # verify exports
# Look for: createGoogleGenerativeAI, GoogleGenerativeAIProvider, google.tools.*
```

#### Task 1.2 — Add `thinking_tokens` to UsageMetrics
**File**: `src/types/ai.ts`
**Change**: Add new optional field

```typescript
export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** OpenAI reasoning model internal reasoning tokens (o1, o3, o4-mini) */
  reasoning_tokens?: number;
  /** Google Gemini thinking tokens (Gemini 2.5 thinkingBudget, Gemini 3 thinkingLevel) */
  thinking_tokens?: number;
}
```

#### Task 1.3 — Update `calculateEffectiveTokens()`
**File**: `src/executor/AgentExecutor.ts` (line 300)
**Change**: Include thinking tokens in effective total

```typescript
private calculateEffectiveTokens(usage: UsageMetrics): number {
  return usage.input_tokens + usage.output_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.thinking_tokens ?? 0);
}
```

**Note**: Google thinking tokens are separate from `candidatesTokenCount` (output tokens) and
represent billable computation. OpenAI `reasoning_tokens` are already included in `output_tokens`
and should NOT be double-counted here.

---

### Phase 2: AIProvider Google Integration

#### Task 2.1 — Import and instance field
**File**: `src/ai/AIProvider.ts`
**Change**: Add static import and instance field

```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// In class AIProvider:
/** Google provider instance for accessing provider-defined tools (googleSearch, codeExecution) */
private googleInstance?: ReturnType<typeof createGoogleGenerativeAI>;
```

**Note**: Use `ReturnType<typeof createGoogleGenerativeAI>` if `GoogleGenerativeAIProvider` is not
exported as a named type. Verify during Task 1.1 inspection.

#### Task 2.2 — Eager initialization in `initializeProviders()`
**File**: `src/ai/AIProvider.ts` — `initializeProviders()` (line 529)
**Change**: Add Google branch after OpenAI

```typescript
} else if (providerName === 'google') {
  const google = createGoogleGenerativeAI({ apiKey: creds.apiKey });
  this.googleInstance = google;
  this.providers.set('google', (modelId) => google(modelId));
}
// Other providers are loaded lazily in ensureProvider()
```

#### Task 2.3 — `buildGoogleOptions()` and dispatch
**File**: `src/ai/AIProvider.ts`

Add dispatch in `buildProviderOptions()` (before default passthrough):

```typescript
if (resolved.provider === 'google') {
  return this.buildGoogleOptions(resolved, userOptions);
}
```

New method:

```typescript
/**
 * Google-specific provider options.
 * - Auto-enables thinkingConfig for Gemini 2.5+ when model has extendedThinking capability
 * - Gemini 2.5: thinkingBudget (token count) — currently registered models
 * - Gemini 3: thinkingLevel (low/medium/high) — when these models are added
 * - No context management equivalent — budget wrap-up via prepareStep is the only guard
 * - No system message wrapping needed — implicit caching for Gemini 2.5+
 */
private buildGoogleOptions(
  resolved: ResolvedModel,
  userOptions?: ProviderOptions,
): ProviderOptions | undefined {
  const userGoogleOpts = (userOptions?.google ?? {}) as Record<string, unknown>;
  let googleOpts = { ...userGoogleOpts };

  // Auto-enable thinking for capable models if user hasn't specified
  if (resolved.capabilities.extendedThinking && !('thinkingConfig' in googleOpts)) {
    const budgetTokens = this.config.defaultThinkingBudget;
    googleOpts = {
      ...googleOpts,
      thinkingConfig: { thinkingBudget: budgetTokens },
    };
  }

  // No options to inject — return user options unchanged
  if (Object.keys(googleOpts).length === 0) {
    return userOptions;
  }

  return {
    ...(userOptions ?? {}),
    google: googleOpts as Record<string, unknown>,
  } as ProviderOptions;
}
```

#### Task 2.4 — Google usage metadata in `mapUsage()`
**File**: `src/ai/AIProvider.ts` — `mapUsage()`
**Change**: Add 4th tier after OpenAI metadata

```typescript
// 4. Google provider metadata fallback
const googleMeta = providerMetadata as {
  google?: {
    usageMetadata?: {
      cachedContentTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
} | undefined;

if (googleMeta?.google?.usageMetadata) {
  const gUsage = googleMeta.google.usageMetadata;
  base.cache_read_input_tokens ??= gUsage.cachedContentTokenCount;
  if (gUsage.thoughtsTokenCount) {
    base.thinking_tokens = gUsage.thoughtsTokenCount;
  }
}
```

#### Task 2.5 — Update usage logging
**File**: `src/ai/AIProvider.ts` — `generate()` (around line 218)
**Change**: Add thinking tokens to usage log

```typescript
this.logger.info(
  `Usage: ${usage.input_tokens}in / ${usage.output_tokens}out` +
  (usage.cache_creation_input_tokens ? ` / cache_write=${usage.cache_creation_input_tokens}` : '') +
  (usage.cache_read_input_tokens ? ` / cache_read=${usage.cache_read_input_tokens}` : '') +
  (usage.thinking_tokens ? ` / thinking=${usage.thinking_tokens}` : ''),
);
```

---

### Phase 3: Dynamic Provider DX Improvements

#### Task 3.1 — Factory name override map
**File**: `src/ai/AIProvider.ts`
**Change**: Add static map and update `ensureProvider()`

```typescript
/**
 * Override map for non-standard AI SDK factory function names.
 * Convention: @ai-sdk/<provider> exports create<Capitalized>().
 * Some providers break this convention.
 */
private static readonly FACTORY_NAME_OVERRIDES: Record<string, string> = {
  google: 'createGoogleGenerativeAI',
};
```

In `ensureProvider()`, replace factory name generation:

```typescript
const factoryName = AIProvider.FACTORY_NAME_OVERRIDES[providerName]
  ?? `create${providerName.charAt(0).toUpperCase() + providerName.slice(1)}`;
```

#### Task 3.2 — Generic provider metadata extraction
**File**: `src/ai/AIProvider.ts` — `mapUsage()`
**Change**: Add 5th tier after Google

```typescript
// 5. Generic provider metadata — best-effort for non-bundled providers
if (providerMetadata) {
  for (const [key, meta] of Object.entries(providerMetadata)) {
    if (['anthropic', 'openai', 'google'].includes(key)) continue;
    if (typeof meta !== 'object' || meta === null) continue;
    const m = meta as Record<string, unknown>;
    // Check for common cache token field names
    if (typeof m['cachedTokens'] === 'number') {
      base.cache_read_input_tokens ??= m['cachedTokens'] as number;
    }
    if (typeof m['cachedContentTokenCount'] === 'number') {
      base.cache_read_input_tokens ??= m['cachedContentTokenCount'] as number;
    }
  }
}
```

---

### Phase 4: Env Var Handling

#### Task 4.1 — Dual Google env var in `resolveAIConfig()`
**File**: `src/client/UluOpsClient.ts`
**Change**: Support both `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY`

In the explicit-providers path (line 296):

```typescript
for (const [name, creds] of Object.entries(ai.providers)) {
  const envKey = `${name.toUpperCase()}_API_KEY`;
  let apiKey = creds.apiKey ?? process.env[envKey];
  // Google SDK uses a different env var convention
  if (!apiKey && name === 'google') {
    apiKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  }
  if (apiKey) {
    providers[name] = { apiKey };
  }
}
```

In the auto-detect path (after the KNOWN_PROVIDERS loop):

```typescript
// Fallback: Google SDK uses GOOGLE_GENERATIVE_AI_API_KEY (not GOOGLE_API_KEY)
if (!providers['google']) {
  const googleKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (googleKey) {
    providers['google'] = { apiKey: googleKey };
  }
}
```

---

### Phase 5: Tests (~10 new tests)

#### Task 5.1 — Google provider mock
**File**: `test/ai/AIProvider.test.ts`

```typescript
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, type: 'mock-google-model' }));
    provider.tools = {
      googleSearch: vi.fn(() => ({ type: 'provider-defined-tool', name: 'google_search' })),
      codeExecution: vi.fn(() => ({ type: 'provider-defined-tool', name: 'code_execution' })),
      urlContext: vi.fn(() => ({ type: 'provider-defined-tool', name: 'url_context' })),
    };
    return provider;
  }),
}));
```

#### Task 5.2 — Google test cases

`describe('Google provider')`:

| # | Test | Key assertion |
|---|------|---------------|
| 1 | Initializes when Google credentials configured | `providers.has('google')` after init |
| 2 | Generates with Google model | `result.provider === 'google'`, `result.model === 'google:gemini-2.5-flash'` |
| 3 | Auto-enables thinkingConfig for extendedThinking | `providerOptions.google.thinkingConfig.thinkingBudget === 10000` |
| 4 | Preserves user-supplied thinkingConfig | User's thinkingConfig NOT overridden |
| 5 | Maps cachedContentTokenCount | `result.usage.cache_read_input_tokens === expected` |
| 6 | Maps thoughtsTokenCount | `result.usage.thinking_tokens === expected` |
| 7 | Uses plain string system message | `generateText.system` is string, not object |
| 8 | Returns undefined for shell tool | `createProviderShellTool('google', ...)` === undefined |
| 9 | No thinkingConfig for non-thinking models | No `thinkingConfig` in providerOptions |
| 10 | Factory name override resolves correctly | `FACTORY_NAME_OVERRIDES['google']` === 'createGoogleGenerativeAI' |

---

### Phase 6: Documentation

#### Task 6.1 — README.md
- Add `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` to env vars table
- Add Google to providers config example
- Update "bundled providers" description to "Anthropic, OpenAI, Google"

#### Task 6.2 — CHANGELOG.md

```markdown
## [0.3.0] - 2026-02-25

### Added
- **Google/Gemini provider support** — `@ai-sdk/google` bundled as third provider
- Auto-thinking for Gemini — `thinkingConfig.thinkingBudget` auto-set for capable models
- Google usage metrics — maps `cachedContentTokenCount` and `thoughtsTokenCount`
- `thinking_tokens` field on `UsageMetrics` for Google Gemini thinking token tracking
- Factory name override map for non-standard AI SDK factory names
- Generic provider metadata extraction for non-bundled providers
- Dual Google API key support (`GOOGLE_API_KEY` + `GOOGLE_GENERATIVE_AI_API_KEY`)

### Changed
- `buildProviderOptions()` dispatches to `buildGoogleOptions()` for google provider
- `calculateEffectiveTokens()` includes thinking_tokens in total
- `ensureProvider()` checks FACTORY_NAME_OVERRIDES before convention-based name

### Dependencies
- Added `@ai-sdk/google` ^3.0.0
```

#### Task 6.3 — Version bump
**File**: `package.json`
**Change**: `"version": "0.2.0"` → `"version": "0.3.0"`

---

## 5. File Change Summary

| File | Changes | Est. Lines |
|------|---------|-----------|
| `package.json` | Add `@ai-sdk/google`, bump version | +2, -1 |
| `src/types/ai.ts` | Add `thinking_tokens` field | +2 |
| `src/ai/AIProvider.ts` | Import, instance, init, buildGoogleOptions, mapUsage, FACTORY_NAME_OVERRIDES, generic metadata, logging | +90, -5 |
| `src/executor/AgentExecutor.ts` | Include thinking_tokens in calculateEffectiveTokens | +1, -1 |
| `src/client/UluOpsClient.ts` | Dual env var check for Google | +12, -2 |
| `test/ai/AIProvider.test.ts` | Google mock + ~10 test cases | +150 |
| `README.md` | Google provider docs, env vars | +15 |
| `CHANGELOG.md` | v0.3.0 section | +15 |
| **Total** | | ~+287, -9 |

---

## 6. Verification

1. **Typecheck**: `npm run typecheck` — all imports resolve, types align
2. **Unit tests**: `npm test` — existing 350 + ~10 new = ~360 pass
3. **Live smoke test**:
   ```bash
   cd packages/cli && GOOGLE_API_KEY=<key> npm run dev -- exec agent code-validator . \
     --project test --model gemini --local-definitions ~/uluops/uluops-agent-workflows/udl --debug
   ```
4. **Debug log verification**:
   - `Model: google:gemini-2.5-flash (from "gemini")`
   - `Config: maxTokens=8192, maxSteps=50, temp=0`
   - Provider options include `thinkingConfig.thinkingBudget=10000`
   - Usage line includes `thinking=<N>`

---

## 7. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Google `usageMetadata` not in AI SDK `providerMetadata` type | Low | Runtime property check via `as Record<string, unknown>`. AI SDK standard path may already map cache tokens. |
| Gemini 3 needs `thinkingLevel` not `thinkingBudget` | Low | Only Gemini 2.5 in registry now. Detect from model ID when Gemini 3 is added. |
| `GoogleGenerativeAIProvider` type not exported | Low | Fall back to `ReturnType<typeof createGoogleGenerativeAI>`. Verify in Phase 1.1. |
| Package size increase | Minimal | `@ai-sdk/google` is ~50KB, tree-shakes. Same rationale as OpenAI in v0.2.0. |

---

## 8. References

| Resource | Path |
|----------|------|
| AIProvider source | `src/ai/AIProvider.ts` |
| ModelCatalog source | `src/ai/ModelCatalog.ts` |
| Config types | `src/types/config.ts` |
| Usage types | `src/types/ai.ts` |
| AgentExecutor | `src/executor/AgentExecutor.ts` |
| UluOpsClient | `src/client/UluOpsClient.ts` |
| Test file | `test/ai/AIProvider.test.ts` |
| Google AI SDK docs | `docs/ai-sdk/providers/google.md` |
| OpenAI integration plan | `docs/openai-integration-plan-handoff.md` |
| Registry alias seed | `uluops-registry-api/src/db/seeds/003_aliases.ts` |
| Registry model seed | `uluops-registry-api/src/db/seeds/002_models.ts` |
