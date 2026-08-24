import { exec } from 'child_process';
import { promisify } from 'util';
import type { Logger } from '@uluops/sdk-core';
import { clampModelBound } from '../utils/externalValue.js';

const execAsync = promisify(exec);

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface ShellResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number;
  /**
   * How the process actually ended. `timedOut` alone could not distinguish these, and the
   * conflation was reported to the MODEL as fact.
   *
   * Node's own error shapes, measured:
   *   real timeout   { killed: true,  signal: 'SIGTERM' }
   *   external kill  { killed: false, signal: 'SIGKILL' }   <- was reported as a timeout
   *   maxBuffer      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }  (a STRING code)
   *   normal exit    { killed: false, signal: null, code: 3 }
   *
   * The old guard was `if (err.killed || err.signal)`, so the `|| err.signal` disjunct
   * swept up every signalled death — and `executeShellAsString` then told the model
   * "Command timed out after Nms", a duration nobody measured for an event that did not
   * occur. A model reading that will rationally ask for a longer timeout, which cannot
   * help. Node distinguishes these; the code was discarding the distinction.
   */
  termination: 'exited' | 'timeout' | 'signal' | 'output-limit';
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
    return { stdout: stdout || '', stderr: stderr || '', timedOut: false, exitCode: 0, termination: 'exited' };
  } catch (error) {
    // `code` is typed `number | string`: Node uses a STRING code for its own internal
    // failures (ERR_CHILD_PROCESS_STDIO_MAXBUFFER), which the old `typeof === 'number'`
    // test silently turned into a fabricated `exitCode: 1`.
    const err = error as {
      killed?: boolean; signal?: string; stderr?: string; code?: number | string; stdout?: string;
    };

    // A TIMEOUT is specifically Node killing the child because our timeout elapsed:
    // killed === true. An external signal leaves killed false and must not claim a
    // duration that was never measured.
    if (err.killed === true) {
      return {
        stdout: err.stdout || '', stderr: err.stderr || '',
        timedOut: true, exitCode: 1, termination: 'timeout',
      };
    }

    // maxBuffer overflow. The 1 MB ceiling sits ABOVE the 100 KB MAX_SHELL_OUTPUT that
    // markTruncation reports, and this path discards ALL output while reporting a failure
    // that may not have occurred — the command's real exit code was never observed. Say so
    // rather than inventing an exit code.
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || 'Output exceeded the 1MB buffer limit; the command\'s exit status was not observed.',
        timedOut: false, exitCode: 1, termination: 'output-limit',
      };
    }

    if (err.signal) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || `Process terminated by signal ${err.signal}.`,
        timedOut: false, exitCode: 1, termination: 'signal',
      };
    }

    return {
      stdout: err.stdout || '',
      stderr: err.stderr || String(error),
      timedOut: false,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      termination: 'exited',
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
  // Each termination reports what actually happened. Returning "timed out" for a SIGKILL
  // or a buffer overflow hands the model a false premise it will then act on.
  if (result.termination === 'timeout') return `Command timed out after ${timeoutMs}ms`;
  if (result.termination === 'signal') return result.stderr;
  if (result.termination === 'output-limit') return result.stderr;
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
      // Only a genuine timeout reports `timeout`. The SDK's outcome union has no member
      // for "killed by an external signal" or "output limit exceeded", so those report an
      // exit — but their stderr (set at the classification site) says what actually
      // happened, rather than the exit code silently standing in for a story that is false.
      outcome: result.termination === 'timeout'
        ? { type: 'timeout' as const }
        : { type: 'exit' as const, exitCode: result.exitCode },
    });
  }

  return { output: results };
}
