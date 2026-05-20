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
  const timeoutMs = action.timeoutMs ?? defaultTimeoutMs;
  const results = [];

  const maxLen = action.maxOutputLength;

  for (const command of action.commands) {
    const result = await runShellCommand(command, cwd, timeoutMs, logger);
    results.push({
      stdout: maxLen !== undefined ? result.stdout.substring(0, maxLen) : result.stdout,
      stderr: maxLen !== undefined ? result.stderr.substring(0, maxLen) : result.stderr,
      outcome: result.timedOut
        ? { type: 'timeout' as const }
        : { type: 'exit' as const, exitCode: result.exitCode },
    });
  }

  return { output: results };
}
