import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
 */
export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellResult> {
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

/** Anthropic bash tool adapter — returns plain string */
export async function executeShellAsString(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const result = await runShellCommand(command, cwd, timeoutMs);
  if (result.timedOut) return `Command timed out after ${timeoutMs}ms`;
  return result.stdout || result.stderr || '(no output)';
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
): Promise<OpenAIShellOutput> {
  const timeoutMs = action.timeoutMs ?? defaultTimeoutMs;
  const results = [];

  const maxLen = action.maxOutputLength;

  for (const command of action.commands) {
    const result = await runShellCommand(command, cwd, timeoutMs);
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
