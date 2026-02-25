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
    await runSingleCheck(check, input);
  }
}

async function runSingleCheck(
  check: PreflightCheck,
  input: ExecutionInput,
): Promise<void> {
  switch (check.check) {
    case 'file_exists':
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

  const fullPath = path.resolve(input.target, check.path);
  try {
    await fs.access(fullPath);
  } catch {
    throw new PreflightError(
      check.message ?? `Required file not found: ${check.path}`,
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

  // Reject commands with backtick substitution or process substitution
  if (/`|\$\(/.test(check.command)) {
    throw new PreflightError(
      `Preflight command contains disallowed shell substitution: ${check.command}`,
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
