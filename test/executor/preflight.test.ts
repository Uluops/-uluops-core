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

    // Logical traversal guard. Assert the message WITHOUT "via symlink" — the symlink
    // guard's message is a superstring of this one, so a looser matcher would let either
    // branch satisfy either test.
    it.each([
      '../outside.txt',
      '../../etc/passwd',
      'nested/../../outside.txt',
    ])('rejects path traversal escaping the target directory: %s', async (p) => {
      const checks: PreflightCheck[] = [{ check: 'file_exists', path: p }];
      await expect(runPreflightChecks(checks, input))
        .rejects.toThrow(`file_exists path escapes target directory: ${p}`);
    });

    // Control: the traversal guard must not reject a legitimate nested path. Without this,
    // a guard that rejected everything would pass every test above.
    it('allows a nested path that stays inside the target', async () => {
      await fs.mkdir(path.join(tmpDir, 'nested'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'nested', 'ok.json'), '{}');
      const checks: PreflightCheck[] = [{ check: 'file_exists', path: 'nested/ok.json' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
    });

    // Symlink escape. The link target must really exist: lstat does not follow the link,
    // but realpath does, and a dangling link would fail with "Failed to resolve real path"
    // — a different branch that would make this test pass for the wrong reason.
    it('rejects a symlink whose target escapes the directory', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret');
      await fs.symlink(outsideFile, path.join(tmpDir, 'escape.txt'));

      const checks: PreflightCheck[] = [{ check: 'file_exists', path: 'escape.txt' }];
      try {
        await expect(runPreflightChecks(checks, input))
          .rejects.toThrow('file_exists path escapes target directory via symlink: escape.txt');
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    // Control: a symlink pointing INSIDE the target is legitimate and must be allowed.
    // This is what distinguishes the symlink guard from "reject all symlinks".
    it('allows a symlink whose target stays inside the directory', async () => {
      await fs.writeFile(path.join(tmpDir, 'real.json'), '{}');
      await fs.symlink(path.join(tmpDir, 'real.json'), path.join(tmpDir, 'link.json'));
      const checks: PreflightCheck[] = [{ check: 'file_exists', path: 'link.json' }];
      await expect(runPreflightChecks(checks, input)).resolves.toBeUndefined();
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
      ['backslash line continuation', 'echo ok\\'],
      ['backslash word obfuscation', 'grep foo \\bar'],
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

    // Payloads MUST use an allowlisted base command (`command`, `which`) to wrap the
    // interpreter. A bare `node -e ...` never reaches the interpreter guard — the
    // allowlist check runs first and rejects `node` on its own, so the test would pass
    // at the wrong branch and the guard could be deleted without failing. Assert on the
    // message, not on PreflightError: every guard in this module throws that same class,
    // so a class-only assertion cannot tell you which one fired.
    it.each([
      ['command + bash -c', 'command bash -c "echo hi"'],
      ['command + python3 -c', 'command python3 -c "print(1)"'],
      ['which + node -e', 'which node -e x'],
      ['command + sh -c', 'command sh -c x'],
    ])('rejects interpreter eval: %s', async (_label, cmd) => {
      const checks: PreflightCheck[] = [{ check: 'command', command: cmd }];
      await expect(runPreflightChecks(checks, input)).rejects.toThrow('disallowed interpreter eval');
    });

    // $ARGUMENTS shell-quoting (CWE-78). The command runs via `sh -c`, so an unquoted
    // target path is shell-interpreted. `>` is the discriminating case: it is NOT in the
    // metacharacter blocklist (/[;|&`\n\r\\]|\$\(/), so the metachar guard cannot backstop
    // it — only shellQuote prevents the redirection. A stray file in the target directory
    // is the injection succeeding, which is why the assertion checks the filesystem and
    // not merely the absence of a throw.
    it.each([
      ['redirection', 't > pwned'],
      ['space', 'a b'],
    ])('shell-quotes $ARGUMENTS against a %s character in the target path', async (_label, dirName) => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-quote-'));
      const target = path.join(base, dirName);
      await fs.mkdir(target, { recursive: true });
      try {
        const checks: PreflightCheck[] = [{ check: 'command', command: 'test -d $ARGUMENTS' }];
        await expect(runPreflightChecks(checks, { target } as ExecutionInput)).resolves.toBeUndefined();
        // Nothing was created by shell interpretation of the path.
        expect(await fs.readdir(target)).toEqual([]);
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    });

    // Glob needs a decoy sibling to be a real test. A lone directory named `star*` passes
    // even unquoted, because the glob expands to the directory itself — the assertion
    // would hold whether or not shellQuote ran. With a second matching entry the unquoted
    // expansion yields two words and `test -d` errors, so the case can actually fail.
    it('shell-quotes $ARGUMENTS against a glob character in the target path', async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-quote-'));
      const target = path.join(base, 'q?');
      await fs.mkdir(target, { recursive: true });
      await fs.mkdir(path.join(base, 'qZ'), { recursive: true }); // decoy the glob would also match
      try {
        const checks: PreflightCheck[] = [{ check: 'command', command: 'test -d $ARGUMENTS' }];
        await expect(runPreflightChecks(checks, { target } as ExecutionInput)).resolves.toBeUndefined();
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    });

    // The metacharacter guard now runs against the command TEMPLATE, before
    // $ARGUMENTS substitution (runPreflightChecks / validateCommandTemplate),
    // rather than against the post-substitution string. Previously the guard
    // saw shellQuote's OWN output: shellQuote correctly emits 'it'\''s' for a
    // target containing a quote, but the guard then stripped the quoted spans
    // and tripped on the leftover backslash — rejecting the output of the
    // package's own quoting function for any target path containing an
    // apostrophe. Guarding the template instead means the guard never sees
    // target-derived text at all (only `command` is shell-interpreted, and it
    // always routes $ARGUMENTS through shellQuote), so a legitimately-named
    // directory now passes.
    it('resolves for a target path containing a single quote (template-only metachar guard)', async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-quote-'));
      const target = path.join(base, "it's");
      await fs.mkdir(target, { recursive: true });
      try {
        const checks: PreflightCheck[] = [{ check: 'command', command: 'test -d $ARGUMENTS' }];
        await expect(runPreflightChecks(checks, { target } as ExecutionInput))
          .resolves.toBeUndefined();
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    });

    // Controls: the guard must still fire when the metacharacter is in the
    // TEMPLATE (author-authored), not the substituted target — this is what
    // proves the fix narrowed the guard's scope rather than disabling it.
    it('still rejects a metacharacter in the command template (not the target)', async () => {
      const checks: PreflightCheck[] = [{ check: 'command', command: 'test -d $ARGUMENTS; rm -rf /' }];
      await expect(runPreflightChecks(checks, input))
        .rejects.toThrow('disallowed shell metacharacters');
    });
  });

  describe('unknown check type', () => {
    it('rejects a check type the switch does not handle', async () => {
      const checks = [{ check: 'bogus_check_type' }] as unknown as PreflightCheck[];
      await expect(runPreflightChecks(checks, input))
        .rejects.toThrow('Unknown preflight check type: bogus_check_type');
    });

    // Control: every documented check type must reach a real handler, so the default
    // branch above is proven to be reachable ONLY by genuinely unknown types.
    it.each(['file_exists', 'path_exists', 'command', 'env_var', 'git_clean'])(
      'does not treat %s as unknown', async (checkType) => {
        const checks = [{ check: checkType }] as unknown as PreflightCheck[];
        await expect(runPreflightChecks(checks, input))
          .rejects.not.toThrow('Unknown preflight check type');
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
