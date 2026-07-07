/**
 * StepsExecutor — engine execution of PDL stage `steps:` blocks.
 *
 * Runs inline shell steps (detection preflights, build gates) per the PDL
 * step contract: timeout, retries/retry_delay, continue_on_error, always_run,
 * expect_empty, expect_match, working_dir, per-step env.
 *
 * SECURITY POSTURE (pdl-steps-execution-spec-v0_1_0 D3): step commands come
 * from resolved definitions — running them is host shell access. This
 * executor is only reachable when the operator opts in via
 * `allowStageSteps: true` (config or per-run option, default false),
 * mirroring the bash-tool blocked-by-default precedent. There is no command
 * allowlist in v0.1.x: the opt-in is the boundary.
 *
 * Template substitution: `{{ params.<name> }}` (with optional `|| default`)
 * is resolved against `input.params` (plus `target` from input.target) and
 * shell-quoted before interpolation (CWE-78, same idiom as preflight's
 * $ARGUMENTS handling). A command with unresolved templates FAILS the step
 * rather than executing literal braces.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@uluops/sdk-core';
import type { StepDefinition, StepResult } from '../types/pipeline.js';
import type { ExecutionInput } from '../types/execution.js';

const execFileAsync = promisify(execFile);

/** Default per-step timeout (ms) — matches the PDL schema default. */
const DEFAULT_STEP_TIMEOUT = 60_000;
/** Step output retention cap (spec D4). */
const MAX_OUTPUT_BYTES = 8 * 1024;

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) + '…[truncated]' : s;
}

const TEMPLATE_RE = /\{\{\s*params\.([A-Za-z_][\w]*)\s*(?:\|\|\s*([^}]+?)\s*)?\}\}/g;

/**
 * Substitute `{{ params.x }}` / `{{ params.x || fallback }}` in a step command.
 * Values are shell-quoted. Returns null when a template cannot be resolved —
 * the caller fails the step instead of running literal braces.
 */
export function substituteStepTemplates(
  command: string,
  input: ExecutionInput,
): { command: string } | { unresolved: string } {
  const params: Record<string, unknown> = { target: input.target, ...(input.params ?? {}) };
  let unresolved: string | undefined;
  const substituted = command.replace(TEMPLATE_RE, (whole, name: string, fallback?: string) => {
    let value = params[name];
    if (value === undefined && fallback !== undefined) {
      // Fallback is a YAML-side literal: strip matching quotes if present.
      const trimmed = fallback.trim();
      const quoted = /^(['"])(.*)\1$/.exec(trimmed);
      value = quoted ? quoted[2] : trimmed;
    }
    if (value === undefined) {
      unresolved = whole;
      return whole;
    }
    return shellQuote(String(value));
  });
  if (unresolved) return { unresolved };
  // Any leftover template syntax is a construct we don't support — fail loud.
  if (/\{\{.*\}\}/.test(substituted)) {
    return { unresolved: substituted.match(/\{\{.*?\}\}/)?.[0] ?? '{{…}}' };
  }
  return { command: substituted };
}

export class StepsExecutor {
  constructor(private logger: Logger) {}

  /**
   * Run steps sequentially. A hard failure (failed step without
   * continue_on_error) skips remaining steps except those marked always_run.
   */
  async execute(steps: StepDefinition[], input: ExecutionInput): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const targetRoot = path.resolve(input.target);
    let hardFailed = false;

    for (const step of steps) {
      if (hardFailed && !step.always_run) {
        results.push({
          name: step.name,
          command: step.command,
          status: 'skipped',
          output: '',
          durationMs: 0,
        });
        continue;
      }

      const result = await this.runStep(step, input, targetRoot);
      results.push(result);
      if (result.status === 'failed' && !step.continue_on_error) {
        hardFailed = true;
      }
    }

    return results;
  }

  private async runStep(step: StepDefinition, input: ExecutionInput, targetRoot: string): Promise<StepResult> {
    const start = Date.now();
    const fail = (error: string, extra?: Partial<StepResult>): StepResult => ({
      name: step.name,
      command: step.command,
      status: 'failed',
      output: '',
      error,
      durationMs: Date.now() - start,
      ...extra,
    });

    const substituted = substituteStepTemplates(step.command, input);
    if ('unresolved' in substituted) {
      return fail(`Unresolved template in step command: ${substituted.unresolved}. ` +
        'Pass the parameter via input.params or add a || fallback in the step.');
    }
    const command = substituted.command;

    // working_dir containment: resolve within the target root and verify the
    // real path stays inside it (dual-path idiom, see ToolHandler.isPathSafe).
    let cwd = targetRoot;
    if (step.working_dir) {
      const candidate = path.resolve(targetRoot, step.working_dir);
      try {
        const [realCandidate, realRoot] = await Promise.all([realpath(candidate), realpath(targetRoot)]);
        if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
          return fail(`working_dir "${step.working_dir}" escapes the target root`);
        }
        cwd = candidate;
      } catch {
        return fail(`working_dir "${step.working_dir}" does not exist under the target root`);
      }
    }

    const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT;
    const maxAttempts = 1 + Math.max(0, step.retries ?? 0);

    let lastResult: StepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1 && step.retry_delay) {
        await new Promise(resolve => setTimeout(resolve, step.retry_delay));
      }
      lastResult = await this.attempt(step, command, cwd, timeout, start);
      if (lastResult.status === 'passed') return lastResult;
      this.logger.debug(`Step "${step.name}" attempt ${attempt}/${maxAttempts} failed`);
    }
    return lastResult!;
  }

  private async attempt(
    step: StepDefinition,
    command: string,
    cwd: string,
    timeout: number,
    start: number,
  ): Promise<StepResult> {
    let stdout = '';
    let exitCode = 0;
    let error: string | undefined;

    try {
      const out = await execFileAsync('sh', ['-c', command], {
        cwd,
        timeout,
        env: step.env ? { ...process.env, ...step.env } : process.env,
        maxBuffer: 1024 * 1024,
      });
      stdout = out.stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      stdout = e.stdout ?? '';
      exitCode = typeof e.code === 'number' ? e.code : 1;
      error = e.killed ? `timed out after ${timeout}ms`
        : truncate((e.stderr ?? '').trim() || e.message);
    }

    const output = truncate(stdout.trim());
    let status: StepResult['status'] = error === undefined && exitCode === 0 ? 'passed' : 'failed';

    if (status === 'passed' && step.expect_empty && output !== '') {
      status = 'failed';
      error = 'expected empty output';
    }
    if (status === 'passed' && step.expect_match && !new RegExp(step.expect_match).test(output)) {
      status = 'failed';
      error = `output did not match /${step.expect_match}/`;
    }

    return {
      name: step.name,
      command: step.command,
      status,
      exitCode,
      output,
      ...(error !== undefined ? { error } : {}),
      durationMs: Date.now() - start,
    };
  }
}
