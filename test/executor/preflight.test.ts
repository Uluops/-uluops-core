import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runPreflightChecks } from '../../src/executor/preflight.js';
import { PreflightError } from '../../src/errors/index.js';
import type { PreflightCheck } from '../../src/types/command.js';
import type { ExecutionInput } from '../../src/types/execution.js';

describe('runPreflightChecks', () => {
  let tmpDir: string;
  let input: ExecutionInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-'));
    input = { target: tmpDir };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('file_exists', () => {
    it('passes when file exists', async () => {
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
      const checks: PreflightCheck[] = [{ check: 'file_exists', path: 'package.json' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    it('fails when file does not exist', async () => {
      const checks: PreflightCheck[] = [{ check: 'file_exists', path: 'missing.json' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow(PreflightError);
    });

    it('uses custom error message', async () => {
      const checks: PreflightCheck[] = [{
        check: 'file_exists',
        path: 'missing.json',
        message: 'package.json is required',
      }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('package.json is required');
    });

    it('throws when path is missing from check', async () => {
      const checks: PreflightCheck[] = [{ check: 'file_exists' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('requires a path');
    });
  });

  describe('command', () => {
    it('passes when command succeeds', async () => {
      const checks: PreflightCheck[] = [{ check: 'command', command: 'true' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    it('fails when command fails', async () => {
      const checks: PreflightCheck[] = [{ check: 'command', command: 'false' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow(PreflightError);
    });

    it('throws when command is missing from check', async () => {
      const checks: PreflightCheck[] = [{ check: 'command' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('requires a command');
    });

    it.each([
      ['semicolon', 'echo ok; rm -rf /'],
      ['pipe', 'echo ok | cat'],
      ['ampersand', 'echo ok && rm -rf /'],
      ['backtick', 'echo `whoami`'],
      ['command substitution', 'echo $(whoami)'],
      ['newline', 'echo ok\nrm -rf /'],
      ['carriage return', 'echo ok\rrm -rf /'],
    ])('rejects shell metacharacter: %s', async (_label, cmd) => {
      const checks: PreflightCheck[] = [{ check: 'command', command: cmd }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('disallowed shell metacharacters');
    });

    it('executes command in target directory', async () => {
      // Write a marker file in tmpDir, then use test -f to verify cwd is target
      await fs.writeFile(path.join(tmpDir, '.preflight-marker'), '');
      const checks: PreflightCheck[] = [{ check: 'command', command: 'test -f .preflight-marker' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    it.each([
      'npm', 'npx', 'node', 'pnpm', 'yarn', 'bun',
      'python', 'python3', 'pip', 'pip3',
      'docker', 'kubectl',
      'cargo', 'go', 'make', 'cmake',
    ])('rejects broad-authority command: %s', async (cmd) => {
      const checks: PreflightCheck[] = [{ check: 'command', command: `${cmd} --version` }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('not in the allowed command list');
    });

    it.each([
      ['node -e', 'node -e "process.exit(0)"'],
      ['python3 -c', 'python3 -c "print(1)"'],
      ['bash -c', 'bash -c "echo hi"'],
      ['bun --eval', 'bun --eval "1"'],
    ])('rejects interpreter eval: %s', async (_label, cmd) => {
      const checks: PreflightCheck[] = [{ check: 'command', command: cmd }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow(PreflightError);
    });
  });

  describe('env_var', () => {
    it('passes when env var is set', async () => {
      vi.stubEnv('PREFLIGHT_TEST_VAR', 'something');
      const checks: PreflightCheck[] = [{ check: 'env_var', var: 'PREFLIGHT_TEST_VAR' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    it('fails when env var is not set', async () => {
      delete process.env['PREFLIGHT_MISSING_VAR'];
      const checks: PreflightCheck[] = [{ check: 'env_var', var: 'PREFLIGHT_MISSING_VAR' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow(PreflightError);
    });

    it('throws when var name is missing from check', async () => {
      const checks: PreflightCheck[] = [{ check: 'env_var' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('requires a var name');
    });
  });

  describe('git_clean', () => {
    it('passes when git directory is clean', async () => {
      // Initialize a clean git repo
      const { execSync } = await import('node:child_process');
      execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'content');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      const checks: PreflightCheck[] = [{ check: 'git_clean' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    it('fails when git directory has uncommitted changes', async () => {
      const { execSync } = await import('node:child_process');
      execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'content');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      // Create uncommitted changes
      await fs.writeFile(path.join(tmpDir, 'dirty.txt'), 'uncommitted');

      const checks: PreflightCheck[] = [{ check: 'git_clean' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('not clean');
    });

    it('fails when target is not a git repo', async () => {
      const checks: PreflightCheck[] = [{ check: 'git_clean' }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow(PreflightError);
    });
  });

  describe('multiple checks', () => {
    it('runs all checks in order', async () => {
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
      vi.stubEnv('PREFLIGHT_MULTI_TEST', 'yes');

      const checks: PreflightCheck[] = [
        { check: 'file_exists', path: 'package.json' },
        { check: 'env_var', var: 'PREFLIGHT_MULTI_TEST' },
        { check: 'command', command: 'true' },
      ];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    it('fails on first failing check', async () => {
      const checks: PreflightCheck[] = [
        { check: 'file_exists', path: 'nonexistent.json' },
        { check: 'command', command: 'true' },
      ];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow(PreflightError);
    });

    it('passes with empty check list', async () => {
      await expect(runPreflightChecks([], input)).resolves.toBeUndefined();
    });
  });
});
