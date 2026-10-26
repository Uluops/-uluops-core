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
 * Where steps run (PDL 1.6.0, Execution Semantics → Steps): in the target directory, resolved with
 * `realpath`; for a file target, in the real file's parent. `{{ params.target }}` is that absolute,
 * resolved path. Until 1.6.0 cwd was `path.resolve(target)`, so a file target failed every step with
 * ENOTDIR, and `{{ params.target }}` was whatever relative path the caller gave.
 *
 * Templates (`stepTemplates.ts`): `{{ params.<name> }}` becomes an environment reference,
 * `"${ULU_P_<NAME>}"`, and the value travels in the step's environment, so the shell never re-parses
 * it. Until 1.6.0 values were shell-quoted into the command, and inside the author's double quotes
 * those quotes were literal (tracker 2595e1a8). A misplaced template, or a command with an
 * unresolved one, FAILS the step rather than running it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@uluops/sdk-core';
import type { StepDefinition, StepResult } from '../types/pipeline.js';
import type { ExecutionInput } from '../types/execution.js';
import { substituteStepTemplates } from './stepTemplates.js';
import { checkRegexPatternSafety } from '../utils/regexSafety.js';
import { clampModelBound, externalInt } from '../utils/externalValue.js';
import { scrubSecretEnv } from '../utils/secretEnv.js';

const execFileAsync = promisify(execFile);

/** Default per-step timeout (ms) — matches the PDL schema default. */
const DEFAULT_STEP_TIMEOUT = 60_000;
/** Step output retention cap (spec D4). Unit is UTF-16 code units (String.length),
 *  not bytes — multibyte output can exceed 8 KB on the wire. This is deliberate:
 *  the cap exists to bound context/token cost, and character count is a closer
 *  proxy for tokens than byte count would be. */
const MAX_OUTPUT_CHARS = 8 * 1024;
/** Caps on author-supplied retry knobs: unbounded retries × retry_delay would
 *  otherwise defeat the per-step timeout — the one resource control this
 *  executor implements (security review, PRA-FRA/M CWE-400). */
const MAX_STEP_RETRIES = 10;
const MAX_RETRY_DELAY = 60_000;

/** step.env may not override loader/interpreter hijack vectors or PATH. */
const BLOCKED_STEP_ENV_RE = /^(LD_|DYLD_)|^(NODE_OPTIONS|PATH)$/;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '…[truncated]' : s;
}

/**
 * Where a run's steps execute, and what `{{ params.target }}` names (spec, Where steps run).
 * `realpath` first, so a symlinked file target runs beside the real file. A target that does not
 * resolve keeps the pre-1.6.0 behaviour (`path.resolve`): its steps then fail on the missing
 * directory, which is the error the caller needs to see.
 */
export async function resolveStepRoot(target: string): Promise<{ root: string; targetPath: string }> {
  try {
    const real = await realpath(target);
    const isDir = (await stat(real)).isDirectory();
    return { root: isDir ? real : path.dirname(real), targetPath: real };
  } catch {
    const resolved = path.resolve(target);
    return { root: resolved, targetPath: resolved };
  }
}

export class StepsExecutor {
  constructor(private logger: Logger) {}

  /**
   * Run steps sequentially. A hard failure (failed step without
   * continue_on_error) skips remaining steps except those marked always_run.
   */
  async execute(steps: StepDefinition[], input: ExecutionInput): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const { root: targetRoot, targetPath } = await resolveStepRoot(input.target);
    // `target` is the resolved target, whatever input.params says (spec: params.target is the
    // absolute, resolved target path). Until 1.6.0 a params.target overrode input.target here.
    const params: Record<string, unknown> = { ...(input.params ?? {}), target: targetPath };
    // Secret-class env vars are scrubbed (src/utils/secretEnv.ts, shared with the agent shell):
    // steps do not receive operator credentials.
    const baseEnv = scrubSecretEnv(process.env);
    let hardFailed = false;

    for (const step of steps) {
      if (hardFailed && !step.always_run) {
        results.push({
          name: step.name,
          command: step.command,
          status: 'skipped',
          output: '',
          // FABRICATION-OK: nothing ran, so no time elapsed — 0 is the MEASURED duration of a
          // non-event, not an unknown standing in for one.
          durationMs: 0,
        });
        continue;
      }

      const result = await this.runStep(step, params, targetRoot, baseEnv);
      results.push(result);
      if (result.status === 'failed' && !step.continue_on_error) {
        hardFailed = true;
      }
    }

    return results;
  }

  private async runStep(step: StepDefinition, params: Record<string, unknown>, targetRoot: string, baseEnv: NodeJS.ProcessEnv): Promise<StepResult> {
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

    const substituted = substituteStepTemplates(step.command, params);
    if ('misplaced' in substituted) {
      // Load validation refuses this (template_placement); refused here too for callers that run
      // steps without loading a pipeline.
      return fail(`template_placement: ${substituted.misplaced} must be a whole double-quoted word or a whole bare word, ` +
        'not the first word, outside single quotes, $(…), backticks, process substitution and heredocs');
    }
    if ('unresolved' in substituted) {
      return fail(`Unresolved template in step command: ${substituted.unresolved}. ` +
        'Pass the parameter via input.params or add a || fallback in the step.');
    }
    const command = substituted.command;
    const nulName = Object.entries(substituted.env).find(([, v]) => v.includes('\0'))?.[0];
    if (nulName) {
      // Refused before launch (PARAM_NUL); an environment value cannot hold NUL.
      return fail(`PARAM_NUL: the value for ${nulName} contains NUL`);
    }

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

    // All three come from an AUTHORED definition — registry-resolved YAML that
    // RegistryClient type-erases with `as Record<string, unknown>` and no runtime schema —
    // so they are external input, and `.nan`/`.inf` are directly authorable in YAML.
    //
    // `timeout` was the odd one out: its two siblings below were already clamped and it was
    // not, on the line above them. Measured: `execFile` with `timeout: 0` RESOLVED after a
    // full 2 s sleep — no timeout at all — and `NaN` threw ERR_OUT_OF_RANGE, which
    // `attempt()` reports as `exitCode: 1`, presenting a configuration fault to a gate as a
    // failed command. A steps stage runs host shell commands, so this is the operator's
    // only liveness control over it.
    const timeout = clampModelBound(step.timeout, DEFAULT_STEP_TIMEOUT);

    // `retries` needed a floor for a sharper reason than bounds hygiene. Measured:
    // `retries: .nan` made `maxAttempts` NaN, so `attempt <= NaN` was false, the loop body
    // NEVER EXECUTED, the command never ran — and `return lastResult!` returned `undefined`
    // through a non-null assertion into `stepResults[]`, where PipelineExecutor then read
    // `s.status` off it.
    const maxAttempts = 1 + externalInt(step.retries, { min: 0, max: MAX_STEP_RETRIES, fallback: 0 });
    const retryDelay = externalInt(step.retry_delay, { min: 0, max: MAX_RETRY_DELAY, fallback: 0 });

    let lastResult: StepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1 && retryDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
      lastResult = await this.attempt(step, command, cwd, timeout, start, baseEnv, substituted.env);
      if (lastResult.status === 'passed') return lastResult;
      this.logger.debug(`Step "${step.name}" attempt ${attempt}/${maxAttempts} failed`);
    }
    // NOT `lastResult!`. The assertion was false whenever the loop did not execute, and it
    // put `undefined` into stepResults[] for a consumer that reads `.status` off it.
    //
    // With `externalInt` above, maxAttempts is >= 1 by construction, so this fallback is
    // UNREACHABLE — and a mutation sweep confirms it: removing it alone breaks no test.
    // That is stated rather than hidden. Its value is not runtime coverage; it is that the
    // PAIR fails safe. Delete the clamp and this returns a well-formed failed result;
    // delete both and `undefined` leaks into stepResults[]. The retries test asserts the
    // command actually ran (`status: 'passed'`, `output: 'ok'`), which fails in either
    // single-removal case, so the pair is covered as a pair even though this line is not
    // independently reachable.
    return lastResult ?? fail(`Step "${step.name}" produced no result`);
  }

  private async attempt(
    step: StepDefinition,
    command: string,
    cwd: string,
    timeout: number,
    start: number,
    baseEnv: NodeJS.ProcessEnv,
    paramEnv: Record<string, string>,
  ): Promise<StepResult> {
    let stdout = '';
    let exitCode = 0;
    let error: string | undefined;

    try {
      const out = await execFileAsync('sh', ['-c', command], {
        cwd,
        timeout,
        // Parameter variables last: a step's own env cannot shadow the value the caller passed.
        env: { ...baseEnv, ...(step.env ?? {}), ...paramEnv },
        maxBuffer: 1024 * 1024,
      });
      stdout = out.stdout;
    } catch (err) {
      // SAFETY: single type-erasing cast on the promisified execFile rejection.
      // Node's child_process contract guarantees stdout/stderr/code/killed on this
      // rejection shape — no field is fabricated — and every read below is guarded
      // (`e.stdout ?? ''`, `typeof e.code === 'number'`), so an unexpected shape
      // degrades rather than throws.
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
      // Length cap + catastrophic-backtracking heuristics (CWE-1333) mirror
      // ToolHandler's search_content guard — see regexSafety.ts.
      const patternSafetyIssue = checkRegexPatternSafety(step.expect_match);
      if (patternSafetyIssue !== undefined) {
        status = 'failed';
        error = `rejected expect_match regex /${step.expect_match}/: ${patternSafetyIssue}`;
      } else {
        try {
          if (!new RegExp(step.expect_match).test(output)) {
            status = 'failed';
            error = `output did not match /${step.expect_match}/`;
          }
        } catch (e) {
          // SAFETY: single type-erasing cast, scoped to this `new RegExp()` call —
          // its only possible throw is SyntaxError, and `.message` is the sole
          // field read from it.
          status = 'failed';
          error = `invalid expect_match regex /${step.expect_match}/: ${(e as Error).message}`;
        }
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
