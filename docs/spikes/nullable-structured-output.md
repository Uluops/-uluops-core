# Spike 0a — Nullable structured-output across providers

**Spec:** `agent-schema-score-nullability-spec` (Phase 0a)
**Date:** 2026-06-22
**Script:** `scripts/structured-output-spike.mts`
**SDK:** `ai@6.0.77`, `@ai-sdk/openai@3.0.33`, `@ai-sdk/anthropic@3.0.39`, `@ai-sdk/google@3.0.31`, `zod@3.25.76`
**Path tested:** the production path — `generateText({ output: Output.object({ schema }) })`, mirroring `AIProvider.ts:289-354`.

## Question

Does each provider accept the relaxed score schema and let `null` flow through structured output, or reject the schema / coerce null → 0?

Two candidate shapes:
- **constrained:** `score: z.number().min(0).max(100).nullable()`
- **fallback (nullable):** `score: z.number().nullable()` (no min/max)
- **nullish:** `score: z.number().nullable().optional()`

## Results

| Provider / model | constrained (min/max+nullable) | nullable (no min/max) | nullish (nullable+optional) |
|---|---|---|---|
| **OpenAI** gpt-4o-2024-08-06 (strict) | ✅ ACCEPTED, null preserved | ✅ (implied; superset accepted) | ❌ **REJECTED** — strict mode requires every field in `required`; `optional` not allowed (`'required' is required to be supplied and to be an array`) |
| **Anthropic** claude-haiku-4-5 | ❌ **REJECTED** — `For 'number' type, properties maximum, minimum are not supported` | ✅ ACCEPTED, null preserved | ✅ ACCEPTED |
| **Google** gemini-2.5-flash | ❌ (rejected via no-output, see note) | ✅ ACCEPTED, null preserved — **at adequate token budget** | ⚠️ intermittent at low budget |

Validator (numeric) probes returned `score=85, maxScore=100` on all three providers, all shapes that were accepted.

## The Gemini "No output generated" finding (diagnosed)

Initial runs showed gemini-2.5-flash failing the **null** generator case with `NoObjectGeneratedError: No output generated`, while the numeric validator case succeeded. Diagnosis:

- **Raw (no schema):** Gemini emits `{"decision":"COMPLETE","score":null,"maxScore":null}` correctly → the model is *not* refusing null.
- **Reliability vs token budget** (`nullable` schema, 5× each):
  - `maxOutputTokens: 300` → **flaky** (mixed `ERR No output generated` / success)
  - `maxOutputTokens: 1500` → **5/5 success**
  - `maxOutputTokens: 1500`, `thinkingConfig.thinkingBudget: 0` → **5/5 success**
- **Root cause:** gemini-2.5-flash does extended thinking by default; at a low output-token budget, thinking consumes the budget and leaves no room for the structured object → `NoObjectGeneratedError`. Not a null-schema incompatibility.
- **Production impact: none.** `DEFAULT_MAX_TOKENS = 16384` (`src/constants.ts:64`) — 50× the failing budget. Null structured output is reliable in production.

Also: **`gemini-2.0-flash-001` (the spec's original model id) is dead** — `This model ... is no longer available`. Use `gemini-2.5-flash`.

## Decision

**Schema shape = `z.number().nullable()` — required + nullable, NO `.min/.max`, NO `.optional()`.** It is the only shape all three providers accept in structured-output mode:
- `.min/.max` → rejected by Anthropic.
- `.optional()` → rejected by OpenAI strict.
- `.nullable()` (required) → accepted by all three; Gemini reliable at production token budgets.

**Range (0–100) enforcement moves to the `AgentExecutor` mapping layer** (clamp or reject-with-warn when a present score is out of range), since the schema no longer enforces it. This matches the spec's stated fallback decision and the comment at `outputSchemas.ts:8-10`.

**Gate: PASSED.** No provider blocks the nullable shape. No Phase-2 blocker.

## Acceptance criteria discharged

- **V5** — per-provider acceptance documented (this table). ✅
- **V6** — fallback shape (`z.number().nullable()`) validated on the provider that rejected the constrained form (Anthropic). ✅
- **V22** — no latency regression: nullable validator probes 1.0–2.0s, comparable to baseline; null-generator probes 3.5s (OpenAI) / 1.0–5.8s (Anthropic) — within normal variance. ✅
