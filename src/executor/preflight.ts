import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PreflightCheck } from '../types/command.js';
import type { ExecutionInput } from '../types/execution.js';
import { PreflightError } from '../errors/index.js';

const execFileAsync = promisify(execFile);

/**
 * Run a set of preflight checks before command execution.
 * Throws PreflightError on first failure.
 */
export async function runPreflightChecks(
  checks: PreflightCheck[],
  input: ExecutionInput,
): Promise<void> {
  for (const check of checks) {
    // Substitute CDL template variables ($ARGUMENTS → target path)
    const resolved = substituteCheckVars(check, input);
    await runSingleCheck(resolved, input);
  }
}

/**
 * Shell-quote a string for safe embedding in sh -c commands.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Replace CDL template variables in preflight check fields. */
function substituteCheckVars(check: PreflightCheck, input: ExecutionInput): PreflightCheck {
  // Shell-quote the target for command substitution to prevent CWE-78.
  // Path/message fields use the raw value (not shell-interpreted).
  const subRaw = (s: string | undefined): string | undefined =>
    s?.replace(/\$ARGUMENTS/g, input.target);
  const subShell = (s: string | undefined): string | undefined =>
    s?.replace(/\$ARGUMENTS/g, shellQuote(input.target));
  return {
    ...check,
    path: subRaw(check.path),
    command: subShell(check.command),
    message: subRaw(check.message),
  };
}

async function runSingleCheck(
  check: PreflightCheck,
  input: ExecutionInput,
): Promise<void> {
  switch (check.check) {
    case 'file_exists':
    case 'path_exists':
      return checkFileExists(check, input);
    case 'command':
      return checkCommand(check, input);
    case 'env_var':
      return checkEnvVar(check);
    case 'git_clean':
      return checkGitClean(input);
    default:
      throw new PreflightError(
        `Unknown preflight check type: ${check.check as string}`,
        check.check as string,
      );
  }
}

async function checkFileExists(
  check: PreflightCheck,
  input: ExecutionInput,
): Promise<void> {
  if (!check.path) {
    throw new PreflightError('file_exists check requires a path', 'file_exists');
  }

  const targetRoot = path.resolve(input.target);
  const fullPath = path.resolve(input.target, check.path);

  // Logical path check — catches ../.. traversal
  if (!fullPath.startsWith(targetRoot + path.sep) && fullPath !== targetRoot) {
    throw new PreflightError(
      `file_exists path escapes target directory: ${check.path}`,
      'file_exists',
      { path: check.path },
    );
  }

  // Use lstat + realpath in a single try block to minimize TOCTOU window.
  // lstat checks existence without following symlinks; realpath then resolves
  // the final target. Both must succeed and the resolved path must stay within
  // the target directory.
  try {
    await fs.lstat(fullPath);
    const realTarget = await fs.realpath(targetRoot);
    const realFull = await fs.realpath(fullPath);
    if (!realFull.startsWith(realTarget + path.sep) && realFull !== realTarget) {
      throw new PreflightError(
        `file_exists path escapes target directory via symlink: ${check.path}`,
        'file_exists',
        { path: check.path },
      );
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    // lstat ENOENT → file not found; realpath failure → dangling symlink or race
    const isNotFound = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new PreflightError(
      isNotFound
        ? (check.message ?? `Required file not found: ${check.path}`)
        : `Failed to resolve real path: ${error instanceof Error ? error.message : 'unknown'}`,
      'file_exists',
      { path: check.path },
      { cause: error },
    );
  }
}

/**
 * Run a shell command from a CDL preflight definition.
 *
 * SECURITY MODEL: Preflight commands are prerequisite checks authored in CDL
 * YAML by definition authors (supply-chain trust). The allowlist prevents
 * accidental use of destructive or network-capable commands but does NOT
 * sandbox command effects — allowed commands (git, grep, find, etc.) can still
 * read arbitrary files accessible to the process.
 *
 * Defense layers:
 *   1. Base-command allowlist (read-only/query commands only)
 *   2. Interpreter eval rejection (node -e, python -c, etc.)
 *   3. Shell metacharacter rejection (;, |, &&, $(), backticks)
 *   4. $ARGUMENTS shell-quoting (CWE-78 prevention)
 *
 * Commands execute in the target directory (cwd = input.target) to match
 * the execution context of file_exists and git_clean checks.
 */
async function checkCommand(check: PreflightCheck, input: ExecutionInput): Promise<void> {
  if (!check.command) {
    throw new PreflightError('command check requires a command', 'command');
  }

  // Allowlist restricted to read-only/query commands. Package managers (npm, pip),
  // orchestrators (docker, kubectl), build tools (make, cargo), and interpreters
  // (node, python) are excluded — they have broad side-effect authority that
  // doesn't belong in prerequisite checks. None are used in any real CDL definition.
  const ALLOWED_PREFLIGHT_COMMANDS = [
    'test', '[', 'true', 'false', 'echo',
    'git',
    'grep', 'find', 'ls', 'cat', 'head', 'tail', 'wc',
    'which', 'command',
  ];

  // Extract the base command name (first token, strip any path prefix)
  const baseCommand = check.command.trim().split(/\s+/)[0]?.replace(/^.*\//, '');
  if (!baseCommand || !ALLOWED_PREFLIGHT_COMMANDS.includes(baseCommand)) {
    throw new PreflightError(
      `Preflight command "${baseCommand}" is not in the allowed command list. ` +
      `Allowed: ${ALLOWED_PREFLIGHT_COMMANDS.join(', ')}`,
      'command',
      { command: baseCommand },
    );
  }

  // Reject interpreter-based code execution even for allowed commands.
  // Commands like `node -e "..."` or `python3 -c "..."` can execute arbitrary code.
  if (/\b(bash|sh|zsh|dash|csh|fish|node|python[23]?|ruby|perl|php|lua|deno|bun|awk|gawk|mawk|nawk)\s+(-e|--eval|-c)\b/.test(check.command)) {
    throw new PreflightError(
      'Preflight command contains disallowed interpreter eval',
      'command',
      { command: baseCommand },
    );
  }

  // Reject shell chaining metacharacters that bypass the base-command allowlist.
  // The allowlist checks only the first token; operators like ; && || and
  // command substitution $() or backticks allow arbitrary second commands.
  // Newlines (\n, \r) are also rejected — sh -c treats them as command separators.
  // Backslash (\) is rejected too — it enables line continuation and word-level
  // obfuscation that the changelog (0.8.2) documented as blocked. No legitimate
  // preflight command (test/git/grep/find existence checks) needs an unquoted
  // backslash; quoted $ARGUMENTS backslashes are stripped before this check.
  // Single-quoted strings from shellQuote($ARGUMENTS) are safe — the
  // rejection targets unquoted metacharacters in the original command template.
  if (/[;|&`\n\r\\]|\$\(/.test(check.command.replace(/'[^']*'/g, ''))) {
    throw new PreflightError(
      `Preflight command contains disallowed shell metacharacters. ` +
      `Commands must be simple (no chaining with ; && || or command substitution).`,
      'command',
      { command: baseCommand },
    );
  }

  try {
    await execFileAsync('sh', ['-c', check.command], { cwd: input.target, timeout: 10_000 });
  } catch (error) {
    throw new PreflightError(
      check.message ?? 'Preflight command check failed',
      'command',
      { command: check.command },
      { cause: error },
    );
  }
}

function checkEnvVar(check: PreflightCheck): void {
  if (!check.var) {
    throw new PreflightError('env_var check requires a var name', 'env_var');
  }

  if (process.env[check.var] === undefined) {
    throw new PreflightError(
      check.message ?? `Required environment variable not set: ${check.var}`,
      'env_var',
      { var: check.var },
    );
  }
}

async function checkGitClean(input: ExecutionInput): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: input.target,
      timeout: 10_000,
    });
    if (stdout.trim().length > 0) {
      throw new PreflightError(
        'Git working directory is not clean',
        'git_clean',
      );
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError(
      `Failed to check git status: ${error instanceof Error ? error.message : 'is this a git repository?'}`,
      'git_clean',
    );
  }
}
