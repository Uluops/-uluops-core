import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

// We need to mock exec with the custom promisify symbol so that
// promisify(exec) returns { stdout, stderr } instead of just the first arg.
const mockExecFn = vi.fn();

// Custom promisify implementation that delegates to mockExecFn
const customPromisified = (...args: unknown[]) => {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    mockExecFn(...args, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        Object.assign(err, { stdout, stderr });
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

const execMock = Object.assign(mockExecFn, {
  [promisify.custom]: customPromisified,
});

vi.mock('child_process', () => ({
  exec: execMock,
}));

const { runShellCommand, executeShellAsString, executeShellAsOpenAIResult } = await import('../../src/ai/shellExecutor.js');

function setupExec(result: { stdout?: string; stderr?: string } | Error) {
  mockExecFn.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof callback !== 'function') return;
    if (result instanceof Error) {
      callback(result, (result as { stdout?: string }).stdout ?? '', (result as { stderr?: string }).stderr ?? '');
    } else {
      callback(null, result.stdout ?? '', result.stderr ?? '');
    }
  });
}

describe('ShellExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runShellCommand', () => {
    it('returns stdout on success', async () => {
      setupExec({ stdout: 'hello world\n', stderr: '' });
      const result = await runShellCommand('echo hello world', '/tmp', 5000);
      expect(result.stdout).toBe('hello world\n');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('returns stderr alongside stdout', async () => {
      setupExec({ stdout: 'out', stderr: 'warn' });
      const result = await runShellCommand('cmd', '/tmp', 5000);
      expect(result.stdout).toBe('out');
      expect(result.stderr).toBe('warn');
      expect(result.exitCode).toBe(0);
    });

    it('handles non-zero exit code', async () => {
      const err = Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'not found' });
      setupExec(err);
      const result = await runShellCommand('false', '/tmp', 5000);
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toBe('not found');
    });

    it('detects timeout via killed signal', async () => {
      const err = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', stdout: 'partial', stderr: '' });
      setupExec(err);
      const result = await runShellCommand('sleep 100', '/tmp', 100);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('partial');
    });

    it('handles missing stdout/stderr in error', async () => {
      const err = Object.assign(new Error('fail'), { code: 127 });
      setupExec(err);
      const result = await runShellCommand('nonexistent', '/tmp', 5000);
      expect(result.exitCode).toBe(127);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('fail');
    });

    it('defaults exitCode to 1 when code is not a number', async () => {
      const err = new Error('unknown error');
      setupExec(err);
      const result = await runShellCommand('bad', '/tmp', 5000);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('executeShellAsString', () => {
    it('returns stdout on success', async () => {
      setupExec({ stdout: 'output data', stderr: '' });
      const result = await executeShellAsString('cmd', '/tmp', 5000);
      expect(result).toBe('output data');
    });

    it('returns timeout message on timeout', async () => {
      const err = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
      setupExec(err);
      const result = await executeShellAsString('sleep 99', '/tmp', 3000);
      expect(result).toBe('Command timed out after 3000ms');
    });

    it('returns stderr when stdout is empty', async () => {
      setupExec({ stdout: '', stderr: 'error output' });
      const result = await executeShellAsString('cmd', '/tmp', 5000);
      expect(result).toBe('error output');
    });

    it('returns (no output) when both stdout and stderr are empty', async () => {
      setupExec({ stdout: '', stderr: '' });
      const result = await executeShellAsString('cmd', '/tmp', 5000);
      expect(result).toBe('(no output)');
    });
  });

  describe('executeShellAsOpenAIResult', () => {
    it('runs multiple commands sequentially', async () => {
      let callCount = 0;
      mockExecFn.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
        if (typeof callback !== 'function') return;
        callCount++;
        callback(null, `output${callCount}`, '');
      });

      const result = await executeShellAsOpenAIResult(
        { commands: ['cmd1', 'cmd2'] },
        '/tmp',
        5000,
      );
      expect(result.output).toHaveLength(2);
      expect(result.output[0]!.stdout).toBe('output1');
      expect(result.output[0]!.outcome).toEqual({ type: 'exit', exitCode: 0 });
      expect(result.output[1]!.stdout).toBe('output2');
    });

    it('uses action timeoutMs over default', async () => {
      const err = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
      setupExec(err);

      const result = await executeShellAsOpenAIResult(
        { commands: ['sleep 99'], timeoutMs: 1000 },
        '/tmp',
        30000,
      );
      expect(result.output[0]!.outcome).toEqual({ type: 'timeout' });
    });

    it('returns exit outcome for non-zero exit', async () => {
      const err = Object.assign(new Error('fail'), { code: 42, stdout: '', stderr: 'err' });
      setupExec(err);

      const result = await executeShellAsOpenAIResult(
        { commands: ['bad-cmd'] },
        '/tmp',
        5000,
      );
      expect(result.output[0]!.outcome).toEqual({ type: 'exit', exitCode: 42 });
    });
  });
});

/**
 * Two ways `executeShellAsString` told the model a failed command had succeeded.
 *
 * The Anthropic adapter returns a bare STRING, so unlike its OpenAI twin — which has
 * carried `outcome.exitCode` since it was written — it had nowhere to put the exit status
 * and simply dropped it. A non-zero exit was reported as `stdout || stderr || '(no output)'`,
 * byte-identical to the success shape.
 *
 * Separately, a command that never STARTED (spawn failure: `cwd` missing, shell
 * unavailable) landed in the residual `exited` branch and was described to the model as a
 * command that ran and failed — pointing it at the command instead of the environment.
 *
 * POSITIVE CONTROL: revert either change and the matching block below fails. Both blocks
 * carry a negative control so "reports failure" cannot pass for an implementation that
 * decorates every result.
 */
describe('executeShellAsString — a failed command cannot read as a successful one', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const exitedWith = (code: number, out?: { stdout?: string; stderr?: string }) =>
    Object.assign(new Error(`exit ${code}`), { code, killed: false, signal: null, ...out });

  it('reports the exit code when a command fails with output on stdout', async () => {
    // `npm test` prints its report to stdout and exits 1. The model used to see the report
    // with no signal that the suite had failed.
    setupExec(exitedWith(1, { stdout: 'Tests: 3 failed, 40 passed\n' }));
    const out = await executeShellAsString('npm test', '/tmp', 5000);

    expect(out).toContain('exit code 1');
    expect(out).toContain('Tests: 3 failed');
  });

  it('reports the exit code when a failing command is SILENT', async () => {
    // `grep -q pattern file` exits 1 and prints nothing. '(no output)' alone reads as
    // "the command ran fine and had nothing to say" — the exact inversion of the truth.
    setupExec(exitedWith(1));
    const out = await executeShellAsString('grep -q needle haystack', '/tmp', 5000);

    expect(out).toContain('exit code 1');
    expect(out).not.toBe('(no output)');
  });

  it('preserves the real exit code rather than a generic failure flag', async () => {
    setupExec(exitedWith(127, { stderr: 'sh: nosuchbin: not found\n' }));
    const out = await executeShellAsString('nosuchbin', '/tmp', 5000);

    expect(out).toContain('exit code 127');
    expect(out).toContain('nosuchbin');
  });

  it('says NOTHING about exit status on success — the negative control', async () => {
    // Without this, every assertion above would also pass for an implementation that
    // stamped a failure banner on all output.
    setupExec({ stdout: 'hello\n', stderr: '' });
    const out = await executeShellAsString('echo hello', '/tmp', 5000);

    expect(out).toBe('hello\n');
    expect(out).not.toContain('exit code');
  });

  it('puts the status AHEAD of the output so truncation cannot remove it', async () => {
    setupExec(exitedWith(2, { stdout: 'x'.repeat(150_000) }));
    const out = await executeShellAsString('big-failing-cmd', '/tmp', 5000);

    expect(out.startsWith('Command failed with exit code 2')).toBe(true);
    expect(out).toContain('[truncated —');
  });
});

describe('runShellCommand — a command that never STARTED is not a command that failed', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Enumerated by PROVENANCE, not by name: a NUMBER code is the child's exit status, a
  // STRING code is Node's own error identifier and means the child never ran. The list of
  // possible strings is open (it grows with libuv); the provenance distinction is closed.
  it.each([
    ['ENOENT', 'spawn /bin/sh'],
    ['EACCES', 'spawn /bin/sh'],
    ['ENOTDIR', 'spawn /bin/sh'],
    ['EMFILE', 'spawn /bin/sh'],
  ])('classifies a %s spawn failure as spawn-failure, not exited', async (code, syscall) => {
    setupExec(Object.assign(new Error(`spawn error ${code}`), { code, syscall, killed: false, signal: null }));
    const result = await runShellCommand('anything', '/nonexistent-dir', 5000);

    expect(result.termination).toBe('spawn-failure');
    expect(result.termination).not.toBe('exited');
    expect(result.stderr).toContain(code);
    expect(result.stderr).toContain('never ran');
  });

  it('tells the model the command never ran, not that it failed', async () => {
    setupExec(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: 'spawn /bin/sh', killed: false, signal: null }));
    const out = await executeShellAsString('npm test', '/gone', 5000);

    expect(out).toContain('never ran');
    // Must NOT present a fabricated exit status for a process that produced none.
    expect(out).not.toContain('exit code 1');
  });

  it('a NUMERIC code is still a real exit — the negative control', async () => {
    // Without this, "string codes are spawn failures" would also pass for an
    // implementation that classified every error as a spawn failure.
    setupExec(Object.assign(new Error('exit 3'), { code: 3, killed: false, signal: null }));
    const result = await runShellCommand('failing-cmd', '/tmp', 5000);

    expect(result.termination).toBe('exited');
    expect(result.exitCode).toBe(3);
  });

  it('still classifies the maxBuffer sentinel as output-limit, not spawn-failure', async () => {
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER is also a string code, and its branch runs FIRST.
    // The child DID run in that case; only its output was discarded.
    setupExec(Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: false, signal: null }));
    const result = await runShellCommand('cat /dev/urandom', '/tmp', 5000);

    expect(result.termination).toBe('output-limit');
  });
});
