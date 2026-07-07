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
/** Caps on author-supplied retry knobs: unbounded retries × retry_delay would
 *  otherwise defeat the per-step timeout — the one resource control this
 *  executor implements (security review, PRA-FRA/M CWE-400). */
const MAX_STEP_RETRIES = 10;
const MAX_RETRY_DELAY = 60_000;

/** Secret-class env vars are scrubbed from the environment inherited by
 *  definition-authored step commands (defense-in-depth against exfil from
 *  registry-sourced pipelines; security review SEM-INC/M CWE-200). Steps do
 *  not receive operator credentials — a step that legitimately needs one is a
 *  capability question for a future PDL tier, not an inheritance default. */
const SECRET_ENV_RE = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$|^(AWS_|GOOGLE_|AZURE_|ANTHROPIC_|OPENAI_)/;

/** step.env may not override loader/interpreter hijack vectors or PATH. */
const BLOCKED_STEP_ENV_RE = /^(LD_|DYLD_)|^(NODE_OPTIONS|PATH)$/;

function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_RE.test(k)) out[k] = v;
  }
  return out;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) + '…[truncated]' : s;
}

/** Matches any {{ … }} template span; the inner text is parsed in plain JS
 *  (name + optional || fallback) to keep this pattern star-height 1 for
 *  safe-regex2. Exported for test/executor/regex-safety.test.ts. */
export const TEMPLATE_RE = /\{\{([^}]*)\}\}/g;

const PARAM_NAME_RE = /^params\.([A-Za-z_]\w*)$/;

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
  const substituted = command.replace(TEMPLATE_RE, (whole, innerRaw: string) => {
    // Inner text parsed in plain JS: `params.<name>` with optional `|| fallback`.
    // Anything else inside {{ }} is an unsupported construct — fail the step.
    const inner = innerRaw.trim();
    const sep = inner.indexOf('||');
    const pathPart = (sep < 0 ? inner : inner.slice(0, sep)).trim();
    const fallbackPart = sep < 0 ? undefined : inner.slice(sep + 2).trim();
    const nameMatch = PARAM_NAME_RE.exec(pathPart);
    if (!nameMatch) {
      unresolved = whole;
      return whole;
    }
    let value = params[nameMatch[1]!];
    if (value === undefined && fallbackPart !== undefined) {
      // Fallback is a YAML-side literal: strip matching quotes if present.
      const quoted = /^(['"])(.*)\1$/.exec(fallbackPart);
      value = quoted ? quoted[2] : fallbackPart;
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
    const baseEnv = scrubEnv(process.env);
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

      const result = await this.runStep(step, input, targetRoot, baseEnv);
      results.push(result);
      if (result.status === 'failed' && !step.continue_on_error) {
        hardFailed = true;
      }
    }

    return results;
  }

  private async runStep(step: StepDefinition, input: ExecutionInput, targetRoot: string, baseEnv: NodeJS.ProcessEnv): Promise<StepResult> {
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

    // step.env may not override loader/interpreter hijack vectors or PATH.
    const blockedKey = step.env && Object.keys(step.env).find(k => BLOCKED_STEP_ENV_RE.test(k));
    if (blockedKey) {
      return fail(`step.env key "${blockedKey}" is not permitted (loader/PATH override)`);
    }

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
        // Execute at the resolved real path — shrinks the check→use symlink
        // window (TOCTOU, security review PRA-FRA/L).
        cwd = realCandidate;
      } catch {
        return fail(`working_dir "${step.working_dir}" does not exist under the target root`);
      }
    }

    const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT;
    const maxAttempts = 1 + Math.min(MAX_STEP_RETRIES, Math.max(0, step.retries ?? 0));
    const retryDelay = Math.min(step.retry_delay ?? 0, MAX_RETRY_DELAY);

    let lastResult: StepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1 && retryDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
      lastResult = await this.attempt(step, command, cwd, timeout, start, baseEnv);
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
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<StepResult> {
    let stdout = '';
    let exitCode = 0;
    let error: string | undefined;

    try {
      const out = await execFileAsync('sh', ['-c', command], {
        cwd,
        timeout,
        env: step.env ? { ...baseEnv, ...step.env } : baseEnv,
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
    if (status === 'passed' && step.expect_match) {
      // Author-supplied pattern: a compile failure fails THIS step with an
      // actionable message, like every other per-step failure path — it must
      // not throw past the stage and discard accumulated step results.
      try {
        if (!new RegExp(step.expect_match).test(output)) {
          status = 'failed';
          error = `output did not match /${step.expect_match}/`;
        }
      } catch (e) {
        status = 'failed';
        error = `invalid expect_match regex /${step.expect_match}/: ${(e as Error).message}`;
      }
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
