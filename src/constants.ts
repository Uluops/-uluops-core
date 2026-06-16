import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Path to bundled starter agent definitions.
 * Use as `localDefinitions` in config for quick-start without registry access.
 */
export const STARTER_DEFINITIONS_DIR = resolve(__dirname, '../definitions/starter');

// ─── Threshold Defaults ────────────────────────────────────────────────────
//
// ASSUMPTION (2026-04-16): these thresholds assume a stable score distribution
// across models and agent definitions. In practice, different models (Claude vs
// GPT) score differently for the same codebase, and prompt changes (e.g., the
// uluops-full render profile) shift score distributions. These constants are
// fallbacks — agent definitions carry their own thresholds via decisions.thresholds,
// and RAH provides runtime calibration. If you're seeing systematic pass/fail
// drift after a model or prompt change, the fix is in the definition or RAH
// calibration, not here.

/**
 * Default pass threshold for agent/command scoring (0-100).
 *
 * Score normalization: The Zod output schema constrains `score` to 0-100
 * (`z.number().min(0).max(100)` in outputSchemas.ts). The `maxScore` field
 * on results is informational (category point totals) and is NOT used in
 * threshold comparisons. Thresholds always operate on the normalized 0-100 scale.
 */
export const DEFAULT_PASS_THRESHOLD = 75;

/** Default warn threshold for agent/command scoring (0-100). */
export const DEFAULT_WARN_THRESHOLD = 50;

/** Default gate threshold for workflow phase quality gates (0-100). */
export const DEFAULT_GATE_THRESHOLD = 70;

/** Minimum output-extraction confidence (0-1) for a parsed decision to be
 * trusted by gate logic. Below this, the decision is preserved on the result
 * (non-destructive) but treated as non-passing by SubmissionClient.allGatesPassed.
 * Confidence by extraction method: structured output = 1.0; JSON code fence = 0.95;
 * whole/inline JSON = 0.9/0.75; regex structured-text = 0.5; fallback = 0.
 * See OutputExtractor.ts for where these are assigned. */
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.7;

/** Default maximum tool loop steps for agent execution. */
export const DEFAULT_MAX_STEPS = 50;

/**
 * Default ceiling on concurrent in-flight LLM generation calls per AIProvider
 * instance. Workflows and pipelines fan out agents/phases in parallel with no
 * inherent bound; under provider rate limits, unbounded concurrent retries
 * sustain the limit (the protective retry becomes the dominant stressor). A
 * shared semaphore in AIProvider caps total in-flight calls regardless of how
 * many executors fanned out. Override via UluOpsConfig.maxConcurrency or the
 * ULUOPS_MAX_CONCURRENCY env var. */
export const DEFAULT_MAX_CONCURRENCY = 8;

/** Default maximum output tokens per LLM generation call.
 * 16384 gives verbose models (Gemini, GPT) enough headroom to emit full prose
 * reports + trailing JSON without truncation. Override per-agent via definition
 * defaults.maxTokens or per-call via ExecutionOptions.maxTokens. */
export const DEFAULT_MAX_TOKENS = 16384;

/** Fallback context-window budget (tokens) used only when the resolved model's
 * real window is unknown AND the operator did not set an explicit contextBudget.
 * The model's actual window (registry `limits.context`) is preferred — see
 * {@link deriveContextBudget} in ai/contextBudget.ts. */
export const DEFAULT_CONTEXT_BUDGET = 200_000;

/** Number of recent tool uses retained during Anthropic context management.
 * When context management clears old tool uses to stay within budget,
 * this many recent tool uses are kept. Recency-based heuristic — most recent
 * tool results are usually the most relevant to the current analysis step.
 * Higher values preserve more context but consume more of the budget. */
export const ANTHROPIC_CONTEXT_KEEP_TOOL_USES = 5;

// ─── Anthropic API Identifiers ─────────────────────────────────────────────
// Date-stamped identifiers from Anthropic's API. These are volatile and will
// need updating when Anthropic ships successor versions. Centralized here so
// updates require changing one line instead of searching the codebase.

/** Anthropic bash tool version identifier. Update when Anthropic ships a successor. */
export const ANTHROPIC_BASH_TOOL_VERSION = 'bash_20250124';

/** Anthropic context management edit type. Update when Anthropic ships a new version. */
export const ANTHROPIC_CONTEXT_MANAGEMENT_TYPE = 'clear_tool_uses_20250919';

// ─── Provider Defaults ─────────────────────────────────────────────────────

/**
 * Default allowlist of valid provider names for dynamic import.
 * Prevents path traversal via crafted provider strings (CWE-829).
 * Users can extend this via config.ai.additionalProviders.
 */
/** Default model alias when no model is specified in options or agent definition. */
export const DEFAULT_MODEL_ALIAS = 'sonnet';

export const DEFAULT_DYNAMIC_PROVIDERS = [
  'anthropic', 'openai', 'google', 'mistral', 'cohere', 'groq', 'xai', 'deepseek',
] as const;
