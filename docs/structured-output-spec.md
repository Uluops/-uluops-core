# Structured Output Integration Spec

**Version**: 0.2.0
**Date**: 2026-03-11
**Status**: Draft (revised after audit)
**Package**: `@uluops/core` (uluops-core-sdk)

## Problem Statement

The `OutputExtractor` currently parses free-form LLM text responses using a 3-strategy fallback chain (code fence → inline JSON → structured text). Cross-model testing against 19 models revealed **12 distinct failure modes** (FM1–FM12), all caused by models producing valid but structurally different JSON shapes for the same semantic content.

These failure modes — `score.total` vs `score_total` vs `score_breakdown.sum`, decision-as-object vs decision-as-string, arbitrary wrapper names — are **symptoms of unconstrained output**. The Vercel AI SDK supports structured output via `Output.object()` with Zod schemas, which constrains the model at the token level to produce conformant JSON. For providers that support it (OpenAI with `strict: true`, Anthropic with `outputFormat`/`jsonTool`), this eliminates the problem at the source.

## Goals

1. **Eliminate extraction failures for models that support structured output** by constraining the final response shape via Zod schema
2. **Preserve the OutputExtractor as a universal fallback** for models that don't support structured output, or when structured output fails
3. **No breaking changes** to the public API — `AgentExecutor.execute()` returns the same `AgentResult` shape
4. **Per-provider optimization** — use each provider's strongest structured output mechanism

## Non-Goals

- Constraining intermediate tool-use steps (only the final synthesis step is constrained)
- Replacing `OutputExtractor` entirely (it remains the fallback and the adapter for providers without structured output support)
- Supporting streaming structured output (`streamText` + `Output.object()`) — not needed for agent execution
- Modifying the agent definition format (ADL) to include output schemas — the schema is universal across all agent types
- Structured output for analyst/generator/explorer/forecaster types — these use the same base schema as validators with `z.string()` decision (see Section 2). Future work may add type-specific schemas if output patterns diverge.

## Architecture

### Current Flow

```
Agent Prompt → generateText(tools, maxSteps) → result.text (free-form)
  → OutputExtractor.extract(text) → ParsedOutput
    ├── Strategy 1: JSON code fence
    ├── Strategy 2: Inline JSON detection
    └── Strategy 3: Structured text patterns
  → normalizeOutput() → score/decision/categories/issues resolution
    └── 12 failure mode handlers (FM1-FM12)
```

### Proposed Flow

```
Agent Prompt → generateText(tools, maxSteps, output?) → result
  ├── IF model supports structured output:
  │   result.output → Zod-validated ParsedOutput (direct, no extraction needed)
  │   ├── IF output is valid: use directly
  │   └── IF output fails (NoObjectGeneratedError): fall through to extractor
  └── IF model does NOT support structured output:
      result.text → OutputExtractor.extract(text) → ParsedOutput (unchanged)
```

### Decision Tree

```
resolveModel(input)
  → resolved.capabilities.structuredOutput?
    ├── true:  generateText({ ..., output: Output.object({ schema: validatorOutputSchema }) })
    │           → result.output exists?
    │             ├── yes: return directly (skip OutputExtractor)
    │             └── no:  fall back to OutputExtractor on result.text
    └── false: generateText({ ... }) — current behavior unchanged
```

## Detailed Design

### 1. Model Capability: `structuredOutput`

**Registry SDK** (`packages/registry-sdk/src/types/models.ts`):

```typescript
export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  extendedThinking: boolean;
  structuredOutput: boolean;  // NEW
}
```

**Registry API** (`uluops-registry-api`):
- Add `structured_output` boolean column to `models` table
- Populate via model sync for known models:
  - `true`: All OpenAI gpt-4o-2024-08-06+, gpt-5.x, o3, o4-mini; All Anthropic claude-sonnet-4+, claude-opus-4+, claude-haiku-4.5+; Google gemini-2.0+
  - `false`: gpt-4o-mini, gpt-4.1-nano, claude-3.x, older models

**Note**: The `structuredOutput` capability is about the provider/model supporting schema-constrained responses, not about the model being "good at JSON." Even models without this flag can produce valid JSON — they just can't be constrained to a specific schema at the token level.

### 2. Output Schema Definition

Define Zod schemas for structured output. These are the canonical output shapes — models are constrained to produce exactly this structure.

**Critical: OpenAI `.optional()` incompatibility.** OpenAI's strict structured output mode rejects schemas with `.optional()` properties. All optional fields must use `.nullable()` instead. This is documented in the AI SDK OpenAI provider docs. The schemas below use `.nullable()` throughout.

**Critical: Decision vocabulary.** Agent definitions use diverse decision vocabularies (`PASS/FAIL`, `EXAMINED/UNEXAMINED`, `ALIGNED/MISALIGNED`, `CALIBRATED/OVERCONFIDENT`, etc.). A fixed enum would either force models to pick incorrect values or trigger schema validation failures. The `decision` field uses `z.string()` — the existing `normalizeDecision()` in `OutputExtractor` handles synonym mapping, and the `AgentExecutor` casts to the appropriate union type per agent type.

**New file**: `src/parser/outputSchemas.ts`

```typescript
import { z } from 'zod';

/**
 * Issue within a finding — matches the Issue type from types/command.ts
 *
 * NOTE: All optional fields use .nullable() instead of .optional() because
 * OpenAI's strict structured output mode rejects optional properties.
 * See: https://platform.openai.com/docs/guides/structured-outputs/supported-schemas
 */
const issueSchema = z.object({
  title: z.string().describe('Short description of the issue'),
  description: z.string().nullable().describe('Detailed explanation'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable()
    .describe('Issue severity level'),
  filePath: z.string().nullable().describe('File path where the issue was found'),
  lineNumber: z.number().nullable().describe('Line number in the file'),
  failureCode: z.string().nullable().describe('Machine-readable failure code'),
});

/**
 * Category breakdown for validators
 */
const categorySchema = z.object({
  name: z.string().describe('Category name (e.g., "Code Quality", "Security")'),
  score: z.number().describe('Points earned in this category'),
  maxPoints: z.number().describe('Maximum points possible'),
  findings: z.array(z.object({
    criterion: z.string().describe('What is being evaluated'),
    pointsEarned: z.number(),
    pointsPossible: z.number(),
    issues: z.array(issueSchema).describe('Issues found for this criterion'),
  })).describe('Findings within this category'),
});

/**
 * Base output schema — shared by all agent types.
 *
 * Decision is z.string() (not an enum) because agents use diverse
 * decision vocabularies: PASS/FAIL, EXAMINED/UNEXAMINED, ALIGNED/MISALIGNED,
 * CALIBRATED/OVERCONFIDENT, etc. normalizeDecision() handles synonym mapping.
 */
const baseOutputSchema = z.object({
  decision: z.string()
    .describe('Overall decision (e.g., PASS, FAIL, EXAMINED, ALIGNED)'),
  score: z.number().min(0).max(100)
    .describe('Overall score from 0 to 100'),
  maxScore: z.number()
    .describe('Maximum possible score (typically 100)'),
  summary: z.string().nullable()
    .describe('Brief human-readable summary of the result'),
});

/**
 * Validator output schema — extends base with category breakdown.
 */
export const validatorOutputSchema = baseOutputSchema.extend({
  categories: z.array(categorySchema).nullable()
    .describe('Category breakdown with individual findings'),
});

/**
 * Executor output schema — extends base with artifacts.
 */
export const executorOutputSchema = baseOutputSchema.extend({
  artifacts: z.array(z.object({
    type: z.string().describe('Artifact type (e.g., "file", "report")'),
    path: z.string().nullable().describe('File path if applicable'),
    content: z.string().nullable().describe('Artifact content'),
  })).nullable().describe('Generated artifacts'),
});

/**
 * Generic agent output schema — for analyst, generator, explorer, forecaster types.
 * Uses the base schema without type-specific extensions.
 * These types currently fall through to OutputExtractor in most cases,
 * but structured output gives them consistent score/decision extraction.
 */
export const genericOutputSchema = baseOutputSchema;

export type ValidatorOutput = z.infer<typeof validatorOutputSchema>;
export type ExecutorOutput = z.infer<typeof executorOutputSchema>;
export type GenericOutput = z.infer<typeof genericOutputSchema>;
```

**ParsedOutput type change required**: Add `summary?: string` to `ParsedOutput` in `src/types/parser.ts` so the field is not silently dropped during mapping:

```typescript
export interface ParsedOutput {
  decision: string;
  score?: number;
  maxScore?: number;
  categories?: ParsedCategory[];
  artifacts?: ArtifactResult[];
  rawJson?: unknown;
  summary?: string;  // NEW — populated by structured output, also available from extraction
}
```

### 3. AIProvider Changes

**File**: `src/ai/AIProvider.ts`

Add an `output` option to `AIGenerateOptions`:

```typescript
import { Output } from 'ai';

export interface AIGenerateOptions {
  // ... existing fields ...

  /** Structured output schema. When provided and the model supports it,
   *  constrains the final response to match this schema exactly.
   *  The model must have `structuredOutput: true` capability. */
  output?: Parameters<typeof Output.object>[0];
}
```

Update `AIGenerateResult`:

```typescript
export interface AIGenerateResult {
  // ... existing fields ...

  /** Structured output object, if output schema was provided and model supports it.
   *  When present, this is already validated against the schema — no extraction needed. */
  structuredOutput?: unknown;
}
```

In `generate()`, conditionally pass `output` to `generateText`:

```typescript
import { generateText, Output, NoObjectGeneratedError, stepCountIs } from 'ai';

async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
  // ... existing resolution, provider setup ...

  // Determine if structured output should be used
  const useStructuredOutput = options.output
    && resolved.capabilities.structuredOutput;

  if (options.output && !resolved.capabilities.structuredOutput) {
    this.logger.info(
      `Model ${resolved.modelId} does not support structured output — falling back to free-form extraction`
    );
  }

  try {
    const result = await generateText({
      model: languageModel,
      system,
      prompt: options.prompt,
      tools: options.tools,
      maxOutputTokens: options.maxTokens ?? 8192,
      // +2 when structured output: +1 for the output generation step, +1 buffer
      // to avoid edge cases where the model needs one more tool step before synthesis
      stopWhen: stepCountIs((options.maxSteps ?? 50) + (useStructuredOutput ? 2 : 0)),
      // ... existing options ...
      ...(useStructuredOutput ? { output: Output.object(options.output) } : {}),
    });

    return {
      text: result.text,
      structuredOutput: useStructuredOutput ? result.output : undefined,
      usage,
      // ... rest unchanged ...
    };
  } catch (error) {
    // If structured output fails, extract from the error's preserved text
    // instead of re-running the entire generation (which would double cost).
    // NoObjectGeneratedError.text contains the raw model output.
    if (useStructuredOutput && NoObjectGeneratedError.isInstance(error)) {
      this.logger.warn(
        `Structured output generation failed — falling back to text extraction: ${error.message}`
      );
      return {
        text: error.text ?? '',
        structuredOutput: undefined,
        usage: this.mapUsage(error.usage ?? { inputTokens: 0, outputTokens: 0 }),
        toolCallCount: 0,
        model: `${resolved.provider}:${resolved.modelId}`,
        provider: resolved.provider,
        steps: 0,
        finishReason: error.finishReason ?? 'error',
      };
    }
    throw this.mapError(error, options.timeoutMs);
  }
}
```

**Important**: `stopWhen` gets +2 when using structured output: +1 for the output generation step (which counts as a step in the AI SDK), +1 buffer to handle edge cases where the model needs one more tool step before synthesis. Without the buffer, budget-triggered `toolChoice: 'none'` from `prepareStep` could prevent the structured output step from executing.

**`prepareStep` interaction**: The existing `buildBudgetPrepareStep()` forces `toolChoice: 'none'` at 80% budget. When structured output is active, the SDK treats the output generation as a non-tool step, so `toolChoice: 'none'` should not prevent it. However, if the budget triggers before the model has gathered enough context, the structured output step may produce a low-quality result. This is the same behavior as the current free-form path — budget wrap-up is a best-effort mechanism.

### 4. AgentExecutor Changes

**File**: `src/executor/AgentExecutor.ts`

Pass the output schema to `AIProvider.generate()`, then use structured output when available:

```typescript
import {
  validatorOutputSchema,
  executorOutputSchema,
  genericOutputSchema,
} from '../parser/outputSchemas.js';

// In execute():

// 5. Generate with optional structured output
// All 6 agent types get a schema — validator and executor have type-specific
// extensions, while analyst/generator/explorer/forecaster use the generic base.
const outputSchema = this.getOutputSchema(agentType);

const result = await this.aiProvider.generate({
  // ... existing options ...
  output: outputSchema,
});

// 6. Parse output — prefer structured output, fall back to extraction
let parsed: ParsedOutput;
let extraction: ExtractionResult | undefined;

if (result.structuredOutput) {
  // Structured output is already validated by Zod — map directly
  parsed = this.mapStructuredOutput(result.structuredOutput, agentType);
  this.logger.info('Output extraction: method=structured_output, confidence=1.0');
} else {
  // Fall back to OutputExtractor (unchanged path)
  extraction = this.outputExtractor.extractWithMetadata(result.text, agentType);
  parsed = extraction.output;
  this.logger.info(`Output extraction: method=${extraction.method}, confidence=${extraction.confidence}`);
}
```

Schema selection by agent type:

```typescript
private getOutputSchema(agentType: AgentType) {
  switch (agentType) {
    case 'validator':
      return { schema: validatorOutputSchema, name: 'ValidationResult' };
    case 'executor':
      return { schema: executorOutputSchema, name: 'ExecutionResult' };
    case 'analyst':
    case 'generator':
    case 'explorer':
    case 'forecaster':
      return { schema: genericOutputSchema, name: 'AgentResult' };
  }
}
```

The `mapStructuredOutput()` method maps from the Zod-validated output to `ParsedOutput`. Null values from `.nullable()` fields are converted to `undefined` for consistency with the existing type:

```typescript
private mapStructuredOutput(output: unknown, agentType: AgentType): ParsedOutput {
  const base = output as { decision: string; score: number; maxScore: number; summary: string | null };
  const result: ParsedOutput = {
    decision: base.decision,
    score: base.score,
    maxScore: base.maxScore,
    summary: base.summary ?? undefined,
    rawJson: output,
  };

  if (agentType === 'validator') {
    const v = output as { categories: Array<unknown> | null };
    result.categories = v.categories ?? undefined;
  } else if (agentType === 'executor') {
    const e = output as { artifacts: Array<unknown> | null };
    result.artifacts = e.artifacts ?? undefined;
  }

  return result;
}
```

**Note on `confidence`**: When structured output is used, the output is schema-validated (format confidence = 1.0). This means the JSON shape is guaranteed correct, but **not** that the semantic content is correct — the model could still hallucinate scores or misclassify decisions. Downstream consumers should treat confidence as a format signal, not a quality signal.

### 5. Provider-Specific Structured Output Modes

The AI SDK handles provider differences internally, but we can optimize via `providerOptions`:

**Anthropic** (`buildAnthropicOptions`):
```typescript
// Anthropic supports two modes: outputFormat (native) and jsonTool (via tool)
// Auto mode (default) picks the best available — no change needed
// But we can explicitly prefer outputFormat for newer models
if (resolved.capabilities.structuredOutput) {
  anthropicOpts.structuredOutputMode = 'auto';
}
```

**OpenAI** (`buildOpenAIOptions`):
```typescript
// OpenAI uses response_format with strict: true under the hood
// The AI SDK handles this automatically when Output.object() is passed
// No additional provider options needed
```

**Google** (`buildGoogleOptions`):
```typescript
// Gemini uses responseSchema with response_mime_type: "application/json"
// The AI SDK handles this automatically
// No additional provider options needed
```

### 6. Extraction Method Tracking

Update `ExtractionResult.method` to include the new path:

```typescript
export interface ExtractionResult {
  output: ParsedOutput;
  method: 'json_code_fence' | 'inline_json' | 'structured_text' | 'structured_output';
  confidence: number;
  warnings: string[];
}
```

When structured output succeeds, `AgentExecutor` constructs an `ExtractionResult` for consistent downstream tracking:

```typescript
if (result.structuredOutput) {
  extraction = {
    output: parsed,
    method: 'structured_output',
    confidence: 1.0,
    warnings: [],
  };
}
```

This ensures the `extraction.method` field is always populated via the `ExtractionResult` type, whether the output came from structured output or the fallback extractor. Downstream consumers can switch on `method` without special-casing.

## Migration & Rollout

### Phase 1: Schema + Capability Flag (Non-Breaking)
1. Add `structuredOutput` to `ModelCapabilities` in registry-sdk (default `false`)
2. Add `structured_output` boolean column to models table in registry API
   - Migration: `ALTER TABLE models ADD COLUMN structured_output BOOLEAN NOT NULL DEFAULT FALSE`
   - Existing rows get `false` (safe — no behavioral change)
3. Update `DEFAULT_CAPABILITIES` in `src/ai/ModelCatalog.ts` to include `structuredOutput: false`
   - This ensures locally-resolved models (without registry lookup) have the field defined
4. Add `summary?: string` to `ParsedOutput` in `src/types/parser.ts`
5. Create `src/parser/outputSchemas.ts` with Zod schemas
6. No behavioral change — all models still use free-form extraction

### Phase 2: AIProvider Integration
1. Add `output` to `AIGenerateOptions` and `structuredOutput` to `AIGenerateResult`
2. Implement conditional `Output.object()` pass-through in `generate()`
3. Add `NoObjectGeneratedError` fallback using `error.text` (not re-run)
4. Unit tests with mocked structured output responses

### Phase 3: AgentExecutor Integration
1. Pass output schema from `AgentExecutor` to `AIProvider` (all 6 agent types)
2. Add `getOutputSchema()` and `mapStructuredOutput()` methods
3. Construct `ExtractionResult` for both paths (structured + fallback)
4. Log extraction method for monitoring (`structured_output` vs fallback)
5. Cross-model verification: re-run problem models (gpt-5, gpt-5-codex) to confirm

### Phase 4: Model Catalog Population
1. Populate `structured_output` capability for all registered models
2. Run model sync to propagate to database
3. Verify via cross-model test matrix

## Testing Strategy

### Unit Tests (Phase 2)

| Test Case | What It Verifies |
|-----------|-----------------|
| Structured output returned when model supports it | `result.structuredOutput` is populated, `OutputExtractor` not called |
| Fallback to extractor when model lacks capability | `result.structuredOutput` is undefined, `OutputExtractor` called |
| `NoObjectGeneratedError` fallback uses `error.text` | No re-run, text extracted from error, usage preserved |
| `stopWhen` includes +2 buffer for structured output | Step count = maxSteps + 2 when output schema provided |
| Schema with `.nullable()` fields serializes correctly | No `.optional()` in JSON Schema output (OpenAI compatibility) |

### Integration Tests (Phase 3)

| Test Case | What It Verifies |
|-----------|-----------------|
| All 6 agent types produce valid `getOutputSchema()` | No `undefined` schema for any `AgentType` value |
| `mapStructuredOutput()` preserves all fields | `summary`, `categories`, `artifacts` not silently dropped |
| Null → undefined conversion for `.nullable()` fields | `ParsedOutput` uses `undefined`, not `null` |
| `ExtractionResult` constructed for both paths | `method: 'structured_output'` when structured, fallback method otherwise |

### Cross-Model Regression Tests (Phase 4)

Re-run the existing cross-model test matrix with structured output enabled:

| Model | Expected Behavior |
|-------|-------------------|
| gpt-5, gpt-5-codex, gpt-5.1 | Structured output path — FM1-FM12 should not trigger |
| gpt-4o, gpt-5.2 | Structured output path — already clean, should remain so |
| gpt-4o-mini, gpt-4.1-nano | Fallback path — no `structuredOutput` capability |
| claude-sonnet-4-5, claude-sonnet-4-6 | Structured output path via Anthropic `auto` mode |
| claude-haiku-4-5 | Structured output path — verify Anthropic budget tier |

### FM1-FM12 Regression

Each existing failure mode test in `test/parser/OutputExtractor.test.ts` (56 tests) must continue passing. These tests exercise the fallback path — they must not regress when structured output code is added.

## Risks & Mitigations

### Risk: Structured output + tools step interaction
**Issue**: When using `Output.object()` with `generateText` + tools, the structured output generation counts as an additional step. If `stopWhen` doesn't account for this, the model may exhaust steps before producing the final output. Additionally, `prepareStep` budget wrap-up (`toolChoice: 'none'` at 80%) could interact with the structured output step.
**Mitigation**: Add +2 to `stopWhen` step count when structured output is enabled (+1 for output generation, +1 buffer). The SDK treats structured output generation as a non-tool step, so `toolChoice: 'none'` should not prevent it. Monitor for runs that finish with `finishReason: 'tool-calls'` instead of `'stop'`.

### Risk: OpenAI rejects `.optional()` in strict mode
**Issue**: OpenAI's strict structured output mode does not support optional schema properties. Zod `.optional()` and `.nullish()` must be replaced with `.nullable()`.
**Mitigation**: All schemas use `.nullable()` throughout. This is documented in the AI SDK OpenAI provider reference and enforced by the schema definition in `outputSchemas.ts`. Unit tests verify no `.optional()` properties appear in the serialized JSON Schema.

### Risk: Schema rigidity rejects valid outputs
**Issue**: The Zod schema may be too strict — e.g., a model produces `score: 85.5` but schema expects integer.
**Mitigation**: Use `z.number()` (not `z.int()`) for score fields. The `decision` field uses `z.string()` (not an enum) to accept any decision vocabulary. The fallback to `OutputExtractor` also catches validation failures via `NoObjectGeneratedError.text`.

### Risk: `NoObjectGeneratedError` on structured output failure
**Issue**: When the model produces output that doesn't match the schema, the AI SDK throws `NoObjectGeneratedError`.
**Mitigation**: Extract from `error.text` (the raw model output preserved on the error object) via `OutputExtractor`. Do NOT re-run the entire generation — that would double cost and latency for 100K+ token agent runs. The error also preserves `.usage` and `.finishReason` for metrics.

### Risk: Provider inconsistency
**Issue**: Anthropic, OpenAI, and Google implement structured output differently. OpenAI `strict: true` provides token-level constraint (guaranteed conformance). Anthropic's `jsonTool` mode is strong guidance but not a hard constraint — near-miss outputs may fail Zod validation.
**Mitigation**: Treat all providers as best-effort with `OutputExtractor` fallback. The capability flag is binary (`true`/`false`) rather than distinguishing guarantee levels. If Anthropic's fallback rate is high, consider setting `structuredOutput: false` for Anthropic models and relying on the existing extractor.

### Risk: Reasoning models may not support structured output
**Issue**: OpenAI reasoning models (o1, o3, o4-mini) have restrictions on `response_format`.
**Mitigation**: Check `structuredOutput` capability per-model, not per-provider. Some reasoning models support it (o4-mini does), others may not. The capability is populated via model sync from the registry.

### Risk: Capability flag drift
**Issue**: New models are released frequently. The `structuredOutput` flag must be accurately maintained for each model.
**Mitigation**: The flag defaults to `false` in `DEFAULT_CAPABILITIES` (safe fallback — worst case is using `OutputExtractor` instead of structured output). Model sync from the registry propagates capability updates. False positives (flag `true` but model doesn't support it) are caught by `NoObjectGeneratedError` fallback.

## Cost Impact

**Minimal overhead, net positive from eliminated retries.**

Schema token overhead estimate:
- `validatorOutputSchema` serializes to ~800-1200 tokens as JSON Schema (nested categories + issues)
- `genericOutputSchema` serializes to ~200-300 tokens (base fields only)
- This is added to every request's input tokens, but is cacheable (sent as part of system message)
- For a typical 30K-50K input token run, the schema adds 1-3% overhead

Net cost reduction:
- Eliminates extraction failures that currently require manual re-runs
- Eliminates the risk of `NoObjectGeneratedError` fallback doubling cost (uses `error.text` instead of re-run)
- For OpenAI models with token-level constraint, output tokens may decrease slightly (no wrapper/formatting variability)

## Success Metrics

1. **Extraction success rate**: 100% for models with `structuredOutput: true` (currently ~93%)
2. **FM elimination**: FM1–FM12 should never trigger for structured-output-capable models
3. **Extraction method distribution**: >80% of runs use `structured_output` method
4. **No regression**: Models without structured output continue working via `OutputExtractor`

## Appendix: AI SDK Structured Output API

### `Output.object()` with `generateText`

```typescript
import { generateText, Output, stepCountIs } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  model: openai('gpt-5'),
  tools: { /* ... */ },
  output: Output.object({
    schema: z.object({
      decision: z.string(),           // z.string() not enum — accepts any decision vocabulary
      score: z.number(),
      summary: z.string().nullable(), // .nullable() not .optional() — OpenAI strict compatibility
    }),
    name: 'ValidationResult',
  }),
  stopWhen: stepCountIs(52), // 50 tool steps + 2 buffer (1 output step + 1 safety)
  prompt: 'Validate this codebase...',
});

// output is typed and validated:
// { decision: 'PASS', score: 85, summary: 'All checks passed.' }
```

### Provider Mechanisms

| Provider | Mechanism | Guarantee Level | `.nullable()` Required |
|----------|-----------|-----------------|----------------------|
| OpenAI | `response_format: { type: "json_schema", strict: true }` | Token-level constraint (guaranteed) | Yes — rejects `.optional()` |
| Anthropic | `outputFormat` (native) or `jsonTool` (via tool call) | Strong guidance, best-effort | No, but `.nullable()` works |
| Google | `responseSchema` + `response_mime_type: "application/json"` | Strong guidance | No, but `.nullable()` works |

### Error Handling

```typescript
import { generateText, Output, NoObjectGeneratedError } from 'ai';

try {
  const result = await generateText({ /* ... */ output: Output.object({ schema }) });
} catch (error) {
  if (NoObjectGeneratedError.isInstance(error)) {
    // error.text — raw text the model produced (use for OutputExtractor fallback)
    // error.usage — token usage (preserve for metrics)
    // error.response — response metadata
    // error.finishReason — why the model stopped
    // error.cause — underlying parse/validation error
    // DO NOT re-run — extract from error.text via OutputExtractor
  }
}
```
