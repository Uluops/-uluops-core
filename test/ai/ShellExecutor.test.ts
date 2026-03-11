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

const { runShellCommand, executeShellAsString, executeShellAsOpenAIResult } = await import('../../src/ai/ShellExecutor');

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
      expect(result.output[0].stdout).toBe('output1');
      expect(result.output[0].outcome).toEqual({ type: 'exit', exitCode: 0 });
      expect(result.output[1].stdout).toBe('output2');
    });

    it('uses action timeoutMs over default', async () => {
      const err = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
      setupExec(err);

      const result = await executeShellAsOpenAIResult(
        { commands: ['sleep 99'], timeoutMs: 1000 },
        '/tmp',
        30000,
      );
      expect(result.output[0].outcome).toEqual({ type: 'timeout' });
    });

    it('returns exit outcome for non-zero exit', async () => {
      const err = Object.assign(new Error('fail'), { code: 42, stdout: '', stderr: 'err' });
      setupExec(err);

      const result = await executeShellAsOpenAIResult(
        { commands: ['bad-cmd'] },
        '/tmp',
        5000,
      );
      expect(result.output[0].outcome).toEqual({ type: 'exit', exitCode: 42 });
    });
  });
});
