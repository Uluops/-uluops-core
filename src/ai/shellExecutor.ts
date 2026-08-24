import { exec } from 'child_process';
import { promisify } from 'util';
import type { Logger } from '@uluops/sdk-core';

const execAsync = promisify(exec);

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface ShellResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number;
}

interface OpenAIShellAction {
  commands: string[];
  timeoutMs?: number;
  maxOutputLength?: number;
}

interface OpenAIShellOutput {
  output: Array<{
    stdout: string;
    stderr: string;
    outcome: { type: 'timeout' } | { type: 'exit'; exitCode: number };
  }>;
}

/**
 * Execute a shell command string via `exec()`.
 *
 * SECURITY NOTE: The bash tool is an opt-in feature gated by `agentTools: ['bash']` in the
 * agent YAML definition. When enabled, the LLM-generated command string is passed directly
 * to `exec()` (i.e., `sh -c <command>`), which grants the LLM full host OS access scoped
 * to `cwd`. There is no allowlist or OS-level sandbox. Only enable the bash tool in
 * isolated environments (containers, CI sandboxes). Never enable it for untrusted targets.
 *
 * AUDIT: Every invocation is logged (command string only, not output) for traceability.
 * Output is not logged because it may contain secrets read from the target project.
 */
export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  logger: Logger = noopLogger,
): Promise<ShellResult> {
  logger.info(`[shell] exec: ${command.length > 200 ? command.substring(0, 200) + '…' : command} (cwd=${cwd}, timeout=${timeoutMs}ms)`);
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
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

/**
 * Truncate to a bound, saying so when it happens.
 *
 * `executeShellAsString` has appended a `[truncated — N chars total]` marker since it was
 * written; this adapter substringed silently. Silence here is the same absent-vs-zero
 * conflation the rest of this release corrects, in text: the model receives a shorter
 * string and has no way to know it is not the whole story.
 */
function markTruncation(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen)}\n\n[truncated — ${text.length} chars total, showing first ${maxLen}]`;
}

/** Max shell output size returned to the LLM context. Prevents a single tool call from
 *  consuming the entire context budget (e.g., `cat /dev/urandom | base64 | head -c 500000`). */
const MAX_SHELL_OUTPUT = 100_000; // ~100KB, well within 1MB maxBuffer but bounded for context

/** Anthropic bash tool adapter — returns plain string */
export async function executeShellAsString(
  command: string,
  cwd: string,
  timeoutMs: number,
  logger?: Logger,
): Promise<string> {
  const result = await runShellCommand(command, cwd, timeoutMs, logger);
  if (result.timedOut) return `Command timed out after ${timeoutMs}ms`;
  const output = result.stdout || result.stderr || '(no output)';
  if (output.length > MAX_SHELL_OUTPUT) {
    return output.substring(0, MAX_SHELL_OUTPUT) + `\n\n[truncated — ${output.length} chars total, showing first ${MAX_SHELL_OUTPUT}]`;
  }
  return output;
}

/**
 * Clamp a MODEL-SUPPLIED numeric bound into the operator's allowed range.
 *
 * The model's tool arguments are EXTERNAL INPUT, exactly like a provider payload, and
 * `Math.min(x ?? d, d)` is not a clamp — it is a ceiling with no floor. The smallest legal
 * value defeats it:
 *
 *   Math.min(0 ?? 2000, 2000) === 0, and Node's child_process treats a timeout of 0 as
 *   NO TIMEOUT AT ALL.
 *
 * Measured against the built code with a control: with the operator ceiling at 2000 ms, a
 * model omitting the field had its 5-second command killed at 2004 ms; a model sending
 * `timeoutMs: 0` ran the full 5011 ms to completion and reported a clean `exitCode: 0`.
 * That directly falsified the comment this file carried — "the model can only LOWER the
 * timeout ... never raise it" — because at zero it raises it to unbounded. The bash tool
 * grants full host OS access, so this is the operator's only liveness control over it.
 *
 * Negative and NaN values were no better: they reach `execFile` and throw
 * ERR_OUT_OF_RANGE, which the catch reports as `exitCode: 1` — a configuration error
 * presented to the model as a failed command.
 *
 * So: a value the model did not supply, or supplied unusably, falls back to the operator
 * default; a usable value is bounded on BOTH sides.
 */
function clampModelBound(supplied: number | undefined, operatorDefault: number): number {
  if (typeof supplied !== 'number' || !Number.isFinite(supplied) || supplied < 1) {
    return operatorDefault;
  }
  return Math.min(supplied, operatorDefault);
}

/**
 * OpenAI shell tool adapter — returns structured output.
 * Shell tool action shape (verified from @ai-sdk/openai index.d.ts:718-722):
 *   { commands: string[], timeoutMs?: number, maxOutputLength?: number }
 */
export async function executeShellAsOpenAIResult(
  action: OpenAIShellAction,
  cwd: string,
  defaultTimeoutMs: number,
  logger?: Logger,
): Promise<OpenAIShellOutput> {
  // Bounded on BOTH sides — see clampModelBound. The model can lower these below the
  // operator default and cannot raise them, including by sending 0, a negative, or NaN.
  const timeoutMs = clampModelBound(action.timeoutMs, defaultTimeoutMs);
  const results = [];

  const maxLen = clampModelBound(action.maxOutputLength, MAX_SHELL_OUTPUT);

  for (const command of action.commands) {
    const result = await runShellCommand(command, cwd, timeoutMs, logger);
    results.push({
      // Truncation is MARKED, matching the Anthropic twin above. This path substringed
      // silently, so a model could not tell "the command produced no output" from "the
      // output was discarded" — and at the 100 KB ceiling that difference changes what the
      // model concludes. Two adapters over one shell, one of them honest.
      stdout: markTruncation(result.stdout, maxLen),
      stderr: markTruncation(result.stderr, maxLen),
      outcome: result.timedOut
        ? { type: 'timeout' as const }
        : { type: 'exit' as const, exitCode: result.exitCode },
    });
  }

  return { output: results };
}
