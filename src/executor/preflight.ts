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

/** Replace CDL template variables in preflight check fields. */
function substituteCheckVars(check: PreflightCheck, input: ExecutionInput): PreflightCheck {
  const sub = (s: string | undefined): string | undefined =>
    s?.replace(/\$ARGUMENTS/g, input.target);
  return {
    ...check,
    path: sub(check.path),
    command: sub(check.command),
    message: sub(check.message),
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
      return checkCommand(check);
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

  try {
    await fs.access(fullPath);
  } catch {
    throw new PreflightError(
      check.message ?? `Required file not found: ${check.path}`,
      'file_exists',
      { path: check.path },
    );
  }

  // Symlink check — resolve real paths to detect escape via symlink.
  // Must run after access check so realpath has a valid target.
  try {
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
    // realpath failure on target root itself is unexpected — re-throw
    throw new PreflightError(
      `Failed to resolve real path: ${error instanceof Error ? error.message : 'unknown'}`,
      'file_exists',
      { path: check.path },
    );
  }
}

/**
 * Run a shell command from a CDL preflight definition.
 *
 * SECURITY: The command string comes from the definition YAML file, which is
 * authored by the SDK user (not end-user input). It's passed to `sh -c` via
 * execFile's argv array (not shell-expanded), but the inner command IS
 * interpreted by sh. We reject commands that contain obvious injection
 * patterns from untrusted YAML.
 */
async function checkCommand(check: PreflightCheck): Promise<void> {
  if (!check.command) {
    throw new PreflightError('command check requires a command', 'command');
  }

  // Allowlist of commands permitted in preflight checks.
  // Preflight commands come from operator-authored YAML definitions (supply-chain trust).
  // An allowlist is more robust than a denylist — new dangerous patterns are blocked
  // by default rather than requiring explicit enumeration.
  const ALLOWED_PREFLIGHT_COMMANDS = [
    'test', '[', 'true', 'false', 'echo',
    'git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'bun',
    'python', 'python3', 'pip', 'pip3',
    'grep', 'find', 'ls', 'cat', 'head', 'tail', 'wc', 'which', 'command',
    'docker', 'kubectl',
    'cargo', 'go', 'make', 'cmake',
  ];

  // Extract the base command name (first token, strip any path prefix)
  const baseCommand = check.command.trim().split(/\s+/)[0]?.replace(/^.*\//, '');
  if (!baseCommand || !ALLOWED_PREFLIGHT_COMMANDS.includes(baseCommand)) {
    throw new PreflightError(
      `Preflight command "${baseCommand}" is not in the allowed command list. ` +
      `Allowed: ${ALLOWED_PREFLIGHT_COMMANDS.join(', ')}`,
      'command',
      { command: check.command },
    );
  }

  // Reject interpreter-based code execution even for allowed commands.
  // Commands like `node -e "..."` or `python3 -c "..."` can execute arbitrary code.
  if (/\b(bash|sh|zsh|dash|csh|fish|node|python[23]?|ruby|perl|php|lua|deno|bun|awk|gawk|mawk|nawk)\s+(-e|--eval|-c)\b/.test(check.command)) {
    throw new PreflightError(
      `Preflight command contains disallowed interpreter eval: ${check.command}`,
      'command',
      { command: check.command },
    );
  }

  try {
    await execFileAsync('sh', ['-c', check.command], { timeout: 10_000 });
  } catch {
    throw new PreflightError(
      check.message ?? `Command check failed: ${check.command}`,
      'command',
      { command: check.command },
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
