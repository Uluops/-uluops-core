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
