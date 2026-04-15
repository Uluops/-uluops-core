import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Path to bundled starter agent definitions.
 * Use as `localDefinitions` in config for quick-start without registry access.
 */
export const STARTER_DEFINITIONS_DIR = resolve(__dirname, '../definitions/starter');

// ─── Threshold Defaults ────────────────────────────────────────────────────

/** Default pass threshold for agent/command scoring (0-100). */
export const DEFAULT_PASS_THRESHOLD = 75;

/** Default warn threshold for agent/command scoring (0-100). */
export const DEFAULT_WARN_THRESHOLD = 50;

/** Default gate threshold for workflow phase quality gates (0-100). */
export const DEFAULT_GATE_THRESHOLD = 70;

/** Default maximum tool loop steps for agent execution. */
export const DEFAULT_MAX_STEPS = 50;

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
export const DEFAULT_DYNAMIC_PROVIDERS = [
  'anthropic', 'openai', 'google', 'mistral', 'cohere', 'groq', 'xai', 'deepseek',
] as const;
