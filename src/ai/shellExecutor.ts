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
  /**
   * The child's exit status — meaningful ONLY when `termination === 'exited'`.
   *
   * On every other termination the child's status was never observed (it was killed, or
   * never started), and this carries a placeholder `1`. `termination` is the field that
   * says whether this number is a measurement or a stand-in; read it first. The placeholder
   * is kept rather than made nullable because the OpenAI shell-tool outcome union requires
   * a number and would have to re-invent one at the boundary — moving the fabrication
   * rather than removing it. Both adapters carry the real story in `stderr` instead.
   */
  exitCode: number;
  /**
   * How the process actually ended. `timedOut` alone could not distinguish these, and the
   * conflation was reported to the MODEL as fact.
   *
   * Node's own error shapes, measured:
   *   real timeout   { killed: true,  signal: 'SIGTERM' }
   *   external kill  { killed: false, signal: 'SIGKILL' }   <- was reported as a timeout
   *   maxBuffer      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }  (a STRING code)
   *   spawn failure  { code: 'ENOENT', syscall: 'spawn /bin/sh' }   (a STRING code)
   *   normal exit    { killed: false, signal: null, code: 3 }
   *
   * The old guard was `if (err.killed || err.signal)`, so the `|| err.signal` disjunct
   * swept up every signalled death — and `executeShellAsString` then told the model
   * "Command timed out after Nms", a duration nobody measured for an event that did not
   * occur. A model reading that will rationally ask for a longer timeout, which cannot
   * help. Node distinguishes these; the code was discarding the distinction.
   */
  termination: 'exited' | 'timeout' | 'signal' | 'output-limit' | 'spawn-failure' | 'cancelled';
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
  /**
   * Cancellation from the caller — `PipelineHandle.cancel()`, or a consumer's own signal.
   *
   * Without it, cancelling a run killed the provider request and left the `sh -c` child
   * running: an agent mid-`npm run build` kept writing to the target directory after the
   * run reported CANCELLED, for up to `SHELL_COMMAND_TIMEOUT_MS`. Bounded, but the whole
   * point of the cancel is that the user asked the work to stop.
   */
  signal?: AbortSignal,
): Promise<ShellResult> {
  logger.info(`[shell] exec: ${command.length > 200 ? command.substring(0, 200) + '…' : command} (cwd=${cwd}, timeout=${timeoutMs}ms)`);
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      ...(signal ? { signal } : {}),
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

    // A STRING `code` that is not the maxBuffer sentinel is Node's own error identifier,
    // not the child's exit status: the child never started. `cwd` missing gives ENOENT,
    // an unreadable `cwd` gives EACCES, a file where a directory was expected ENOTDIR,
    // and fd exhaustion EMFILE — and that list is OPEN, it grows with libuv. The
    // PROVENANCE is closed and is what the test keys on: a NUMBER means the child ran
    // and exited, a STRING means Node failed before it could. Classifying these as
    // `exited` told the model "your command ran and failed", so it would go on to debug
    // the command instead of the environment that could not run it.
    if (typeof err.code === 'string') {
      const syscall = (error as { syscall?: string }).syscall;
      return {
        stdout: err.stdout || '',
        stderr: err.stderr ||
          `Command could not be started (${err.code}${syscall ? `, ${syscall}` : ''}); it never ran, so no exit status exists. Check that the working directory exists and is readable.`,
        timedOut: false, exitCode: 1, termination: 'spawn-failure',
      };
    }

    // A caller abort arrives here as a signalled death (Node kills the child with SIGTERM).
    // Reporting it as "terminated by signal SIGTERM" would tell the model its command was
    // killed by something unexplained; it was stopped on purpose.
    if (signal?.aborted) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || 'Command was cancelled before it completed.',
        timedOut: false, exitCode: 1, termination: 'cancelled',
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
 * Map a termination to the OpenAI shell tool's `outcome` union, exhaustively.
 *
 * The SDK union has exactly two members — `timeout` and `exit` — so the four terminations
 * where no exit status was ever observed have nowhere of their own to go and must report
 * an exit. That collapse is unavoidable; what was avoidable was doing it with a ternary on
 * one member, which silently absorbed every future addition. `'spawn-failure'` was added
 * this session and slid into the `exit` branch without a compile error or a test, and the
 * next member would have done the same.
 *
 * The `switch` with the `never` check is the guard: a new termination fails to compile here
 * until someone decides where it belongs. For the collapsed cases the placeholder
 * `exitCode` is meaningless — `stderr`, set at the classification site in
 * `runShellCommand`, is what carries the real story to the model.
 */
function toOpenAIOutcome(result: ShellResult): OpenAIShellOutput['output'][number]['outcome'] {
  switch (result.termination) {
    case 'timeout':
      return { type: 'timeout' as const };
    case 'exited':
      // The only branch where `exitCode` is a measurement rather than a placeholder.
      return { type: 'exit' as const, exitCode: result.exitCode };
    case 'signal':
    case 'output-limit':
    case 'spawn-failure':
    case 'cancelled':
      return { type: 'exit' as const, exitCode: result.exitCode };
    default: {
      // Exhaustiveness guard — widening `termination` without visiting this function is a
      // compile error, not a silent default.
      const unreachable: never = result.termination;
      return unreachable;
    }
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
  signal?: AbortSignal,
): Promise<string> {
  const result = await runShellCommand(command, cwd, timeoutMs, logger, signal);
  // Each termination reports what actually happened. Returning "timed out" for a SIGKILL
  // or a buffer overflow hands the model a false premise it will then act on.
  if (result.termination === 'timeout') return `Command timed out after ${timeoutMs}ms`;
  if (result.termination === 'signal') return result.stderr;
  if (result.termination === 'output-limit') return result.stderr;
  if (result.termination === 'spawn-failure') return result.stderr;
  if (result.termination === 'cancelled') return result.stderr;

  const output = markTruncation(result.stdout || result.stderr || '(no output)', MAX_SHELL_OUTPUT);

  // A FAILED command must say so. This returned the same shape for exit 0 and exit 1 —
  // stdout when there was any, else stderr, else '(no output)' — so a model asking for
  // `npm test` got the test output with no indication the suite had failed, and
  // `grep -q pattern file` (silent, exit 1) got a literal '(no output)' that reads as
  // success. The OpenAI twin has carried the exit code in its outcome since it was
  // written; the Anthropic adapter returns a bare string and had nowhere to put it, so
  // the status was simply dropped. It goes in the text, ahead of the output so that
  // truncation can never remove it.
  if (result.exitCode !== 0) {
    return `Command failed with exit code ${result.exitCode}\n\n${output}`;
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
  signal?: AbortSignal,
): Promise<OpenAIShellOutput> {
  // Bounded on BOTH sides — see clampModelBound. The model can lower these below the
  // operator default and cannot raise them, including by sending 0, a negative, or NaN.
  const timeoutMs = clampModelBound(action.timeoutMs, defaultTimeoutMs);
  const results = [];

  const maxLen = clampModelBound(action.maxOutputLength, MAX_SHELL_OUTPUT);

  for (const command of action.commands) {
    const result = await runShellCommand(command, cwd, timeoutMs, logger, signal);
    results.push({
      // Truncation is MARKED, matching the Anthropic twin above. This path substringed
      // silently, so a model could not tell "the command produced no output" from "the
      // output was discarded" — and at the 100 KB ceiling that difference changes what the
      // model concludes. Two adapters over one shell, one of them honest.
      stdout: markTruncation(result.stdout, maxLen),
      stderr: markTruncation(result.stderr, maxLen),
      outcome: toOpenAIOutcome(result),
    });
  }

  return { output: results };
}
