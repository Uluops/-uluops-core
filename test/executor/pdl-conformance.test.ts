/**
 * PDL 1.6.0 conformance fixtures, the parts build units P3a and P3b own. The fixtures are vendored
 * under `test/fixtures/pdl-conformance/` (`SOURCE` names the corpus commit); their README is the
 * harness contract.
 *
 * P3b (load validation, conditions, refusals):
 * - `load-errors/*`: core's load validator (`checkPipelineLoadRules`) reports exactly the case's
 *   code at its location; every `load_ok` case loads with its `load_warnings`; and every case of
 *   every other group loads clean (a fixture pipeline core refused would test nothing).
 * - **Condition decisions, against the oracle.** For every core case that runs, each stage and agent
 *   condition is evaluated in array order over a context built from the oracle: each earlier stage's
 *   `passed` from the expected file, and real step results from running the case's steps. A condition
 *   that is false must be an expected SKIPPED stage or a `skipped` agent; E must be an expected
 *   ERRORED stage with `STAGE_ERRORED` / `condition_error` (or an `errored` agent); true must be
 *   neither. Stage statuses and gates are P4b's end-to-end run, below; this checks every condition
 *   against the oracle independently of the executor.
 * - `conditions/step-output-with-steps-disabled`: start() refuses with STEP_OUTPUT_STEPS_DISABLED.
 *
 * P4a (reading decisions and scores; the pre-launch vocabulary check):
 * - **Every launched stub agent, through the real AgentExecutor.** For each core case that runs, each
 *   agent the oracle says launched (a `timeout` or `hang` stub excepted) is executed with a provider
 *   that returns the stub's text, built byte for byte as the README specifies, against a definition
 *   built from `stubs/agents.yaml`. The verdict's class, its saved decision where pinned, and its
 *   warnings (exhaustive over the six verdict codes, for that agent) must match; an `errored` agent
 *   must be unjudgeable at its gate, and any other must not; a stage the oracle marks
 *   `STAGE_ERRORED` / `agent_unjudgeable` must hold one. Gates, statuses and the run verdict: P4b, below.
 *
 * P4b (gates, stage status, the saved verdict):
 * - **Every core case that runs, end to end** through PipelineExecutor (pdlConformanceHarness.runCase):
 *   stage statuses, `passed`, launches, agent classes, upstream, steps, `all_gates_passed` in memory and
 *   as SubmissionClient writes it, `run_decision`, ABORTED records, and warnings exhaustively. The
 *   checklist's negative controls are pdlP4bControls.test.ts.
 * - `decisions/precheck-*`: start() refuses with VOCABULARY_MISSING, or does not.
 *
 * P3a (StepsExecutor and the step-template load rules):
 *
 * - `steps/*` (core): each stage's steps run through StepsExecutor against a COPY of `targets/`, with
 *   the target passed relative to the working directory as the README specifies, and each pinned
 *   step result is compared. Stage statuses, gates and agents are P3b/P4's: `steps/corpus-detector-
 *   shape-detects` is asserted on its detector step here, and its agent stage when P4 lands.
 * - `steps/nul-in-parameter-refused`: PipelineExecutor.start() refuses with PARAM_NUL before launch.
 * - `load-errors/*`: the two codes P3a reports (`template_placement`, `parameter_env_collision`) come
 *   back exactly, at their location; every other case, of any group, gets no step-template error.
 *
 * Negative control: on 98adad5 (core 0.53.1) the file-target, absolute-target, detector, shell-syntax
 * and quote-character cases fail, and none of the load-error or refusal assertions has a function to
 * call.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StepsExecutor } from '../../src/executor/StepsExecutor.js';
import { checkStepTemplateRules } from '../../src/executor/stepTemplates.js';
import { checkPipelineLoadRules, bindParameterDefaults } from '../../src/executor/pipelineLoad.js';
import { evaluateCondition, E, type ConditionContext } from '../../src/executor/conditions.js';
import { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import { isUnjudgeable } from '../../src/executor/agentVerdict.js';

/**
 * How a stage's gate judges an unjudgeable agent, derived from the YAML here rather than through
 * stageGate.ts, so the oracle does not share the code it checks: a threshold (aggregate or
 * per-agent), and a blocking gate (any gate but `warn`; a stage with no gate is not blocking, D43).
 */
function judging(stage: Obj): { hasThreshold: boolean; blocking: boolean } {
  return {
    hasThreshold: stage.gate?.threshold !== undefined || (stage.agents ?? []).some((a: Obj) => a.threshold !== undefined),
    blocking: stage.gate !== undefined && stage.gate.on_failure !== 'warn',
  };
}
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { PipelineError } from '../../src/errors/index.js';
import type { StageResult, StepDefinition } from '../../src/types/pipeline.js';
import {
  type Obj, noopLogger, FIX, cases, expected, wrap, appliesToCore,
  resolvedStub, stubText, VERDICT_CODES, config, provider, runCase,
} from './pdlConformanceHarness.js';

// The saved-verdict check reads what SubmissionClient WRITES, so the tracker save is captured here.
const mockSave = vi.fn();
vi.mock('@uluops/ops-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uluops/ops-sdk')>();
  return { ...actual, OpsClient: vi.fn(() => ({ runs: { save: mockSave, validate: vi.fn(), listByProject: vi.fn(), get: vi.fn() } })) };
});

describe('PDL 1.6.0 conformance: the fixtures load', () => {
  it('reads all six groups and pairs every case with one expectation', () => {
    expect(cases.length).toBeGreaterThanOrEqual(154);
    for (const c of cases) expect(expected.has(c.id), c.id).toBe(true);
    expect(cases.filter((c) => c.id.startsWith('steps/') && appliesToCore(c)).length).toBe(9);
  });
});

describe('PDL 1.6.0 conformance: step-template load rules (P3a)', () => {
  const ours = new Set(['template_placement', 'parameter_env_collision']);
  const owned = cases.filter((c) => expected.get(c.id)?.outcome === 'load_error' && ours.has(expected.get(c.id)!.load_error.code));

  it('has cases for both codes (a filter that matched nothing would pass vacuously)', () => {
    const codes = new Set(owned.map((c) => expected.get(c.id)!.load_error.code));
    expect([...codes].sort()).toEqual(['parameter_env_collision', 'template_placement']);
    expect(owned.length).toBeGreaterThanOrEqual(10);
  });

  it.each(owned.map((c) => [c.id as string, c]))('%s reports its code at its location', (_id, c) => {
    const want = expected.get(c.id)!.load_error as { code: string; at: string };
    const errors = checkStepTemplateRules(wrap(c).pipeline);
    expect(errors.map((e) => e.code)).toEqual([want.code]);
    // `stage:<id>` locates a step error too; the step part, when the fixture names one, must match.
    expect(errors[0]!.at === want.at || errors[0]!.at.startsWith(want.at + '/'), `${errors[0]!.at} vs ${want.at}`).toBe(true);
  });

  it.each(cases.filter((c) => !owned.includes(c)).map((c) => [c.id as string, c]))('%s gets no step-template error', (_id, c) => {
    expect(checkStepTemplateRules(wrap(c).pipeline)).toEqual([]);
  });
});

describe('PDL 1.6.0 conformance: steps (P3a)', () => {
  let root = '';
  /** Paths relative to the working directory, as the README says the harness passes them. */
  let targets: Record<string, string> = {};

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pdl-conformance-'));
    cpSync(path.join(FIX, 'targets'), path.join(root, 'targets'), { recursive: true, verbatimSymlinks: true });
    const rel = (p: string) => path.relative(process.cwd(), path.join(root, 'targets', p));
    targets = { dir: rel('project'), file: rel('project/docs/design-spec.md'), symlink: rel('linked-spec.md') };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const ran = cases.filter((c) => c.id.startsWith('steps/') && appliesToCore(c) && expected.get(c.id)!.outcome === 'ran');

  it.each(ran.map((c) => [c.id as string, c]))('%s', async (_id, c) => {
    const want = expected.get(c.id)!.steps as Record<string, Record<string, { status: string; output: string }>>;
    expect(Object.keys(want).length).toBeGreaterThan(0);
    const input = { target: targets[c.target ?? 'dir']!, params: c.params ?? {} };
    for (const [stageId, stepsWanted] of Object.entries(want)) {
      const stage = c.pipeline.stages.find((s: Obj) => s.id === stageId);
      const results = await new StepsExecutor(noopLogger).execute(stage.steps as StepDefinition[], input);
      const got = Object.fromEntries(results.map((r) => [r.name, { status: r.status, output: r.output }]));
      for (const [name, w] of Object.entries(stepsWanted)) {
        expect(got[name], `${stageId}/${name}: ${JSON.stringify(results.find((r) => r.name === name))}`).toEqual({ status: w.status, output: String(w.output) });
      }
    }
    // A runtime that let a value execute leaves a file behind; none may.
    expect(existsSync(path.join(root, 'targets', 'project', 'PWNED'))).toBe(false);
  });

  it('steps/nul-in-parameter-refused: start() refuses with PARAM_NUL before launch', async () => {
    const c = cases.find((x) => x.id === 'steps/nul-in-parameter-refused')!;
    const want = expected.get(c.id)!;
    expect(want.outcome).toBe('refused');
    // start() refuses before it touches any executor, so none is needed.
    const executor = new PipelineExecutor({} as never, {} as never, {} as never, {} as never, noopLogger, true);
    const resolved = { type: 'pipeline', definition: wrap(c) } as never;
    const err = await executor.start(resolved, { target: targets.dir!, params: c.params }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).context.refusal).toEqual(want.refused);
  });
});

describe('PDL 1.6.0 conformance: load validation (P3b)', () => {
  const loadErrorCases = cases.filter((c) => appliesToCore(c) && expected.get(c.id)!.outcome === 'load_error');
  const loadOkCases = cases.filter((c) => appliesToCore(c) && expected.get(c.id)!.outcome === 'load_ok');

  it('has every load-error code the spec names (a filter that matched nothing would pass vacuously)', () => {
    const codes = new Set(loadErrorCases.map((c) => expected.get(c.id)!.load_error.code));
    expect([...codes].sort()).toEqual([
      'aggregate_with_per_agent', 'condition_syntax', 'condition_too_long', 'duplicate_stage_id', 'forward_reference',
      'missing_threshold', 'non_ancestor_reference', 'parameter_env_collision', 'template_placement', 'undeclared_parameter',
      'undeclared_step', 'unknown_key', 'unknown_path', 'unknown_root', 'unknown_stage',
    ]);
    expect(loadOkCases.length).toBeGreaterThanOrEqual(6);
  });

  it.each(loadErrorCases.map((c) => [c.id as string, c]))('%s reports its code at its location', (_id, c) => {
    const want = expected.get(c.id)!.load_error as { code: string; at: string };
    const { errors } = checkPipelineLoadRules(wrap(c).pipeline);
    expect(errors.map((e) => [e.code, e.at === want.at || e.at.startsWith(want.at + '/') ? want.at : e.at])).toEqual([[want.code, want.at]]);
  });

  it.each(loadOkCases.map((c) => [c.id as string, c]))('%s loads, with its load warnings', (_id, c) => {
    const { errors, warnings } = checkPipelineLoadRules(wrap(c).pipeline);
    expect(errors).toEqual([]);
    expect(warnings.map((w) => ({ code: w.code, stage: w.stage }))).toEqual(expected.get(c.id)!.load_warnings ?? []);
  });

  it.each(cases.filter((c) => !['load_error', 'load_ok'].includes(expected.get(c.id)!.outcome)).map((c) => [c.id as string, c]))(
    '%s loads clean', (_id, c) => {
      expect(checkPipelineLoadRules(wrap(c).pipeline).errors).toEqual([]);
    },
  );
});

describe('PDL 1.6.0 conformance: condition decisions against the oracle (P3b)', () => {
  let root = '';
  let targets: Record<string, string> = {};
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pdl-conformance-cond-'));
    cpSync(path.join(FIX, 'targets'), path.join(root, 'targets'), { recursive: true, verbatimSymlinks: true });
    const rel = (p: string) => path.relative(process.cwd(), path.join(root, 'targets', p));
    targets = { dir: rel('project'), file: rel('project/docs/design-spec.md'), symlink: rel('linked-spec.md') };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const hasCondition = (c: Obj) => c.pipeline.stages.some((s: Obj) => s.condition || (s.agents ?? []).some((a: Obj) => a.condition));
  const runCases = cases.filter((c) => appliesToCore(c) && expected.get(c.id)!.outcome === 'ran' && c.run?.steps !== 'disabled' && hasCondition(c));

  it('covers the condition-bearing cases of every group (a filter that matched nothing would pass vacuously)', () => {
    expect(runCases.filter((c) => c.id.startsWith('conditions/')).length).toBe(18);
    expect(runCases.length).toBe(23);
  });

  it.each(runCases.map((c) => [c.id as string, c]))('%s', async (_id, c) => {
    const want = expected.get(c.id)!;
    const wantStages = want.stages as Record<string, Obj>;
    const erroredByCondition = new Set((want.warnings ?? [])
      .filter((w: Obj) => w.code === 'STAGE_ERRORED' && w.reason === 'condition_error').map((w: Obj) => w.stage));
    const doc = wrap(c).pipeline;
    const input = { target: targets[c.target ?? 'dir']!, params: c.params ?? {} };
    const stageResults: StageResult[] = [];
    const passed = new Map<string, boolean>();
    const ctx: ConditionContext = { params: bindParameterDefaults(doc, input.params, input.target), stages: stageResults, passed };
    let checked = 0;

    for (const stage of c.pipeline.stages as Obj[]) {
      const w = wantStages[stage.id]!;
      if (stage.condition) {
        checked++;
        const value = evaluateCondition(stage.condition, ctx);
        const label = `${stage.id}: ${stage.condition} → ${String(value)}, expected ${w.status}`;
        if (value === false) expect(w.status, label).toBe('SKIPPED');
        else if (value === E) {
          expect(w.status, label).toBe('ERRORED');
          expect(erroredByCondition.has(stage.id), label).toBe(true);
        } else expect(w.status === 'ERRORED' && erroredByCondition.has(stage.id), label).toBe(false);
      }
      const stageRuns = !stage.condition || evaluateCondition(stage.condition, ctx) === true;
      if (stageRuns) {
        const agentValues: Array<readonly [string, boolean | typeof E]> = (stage.agents ?? []).map((a: Obj) => [a.ref as string, a.condition ? evaluateCondition(a.condition, ctx) : true] as const);
        for (const [ref, value] of agentValues) {
          const cls = w.agents?.[ref];
          const cl = typeof cls === 'object' ? cls.class : cls;
          const launched = (w.launched ?? []).includes(ref);
          const label = `${stage.id}/${ref} → ${String(value)}, expected ${String(cl)} (launched: ${launched})`;
          if (value === false) { expect(launched, label).toBe(false); expect(cl ?? 'skipped', label).toBe('skipped'); }
          else if (value === E) { expect(launched, label).toBe(false); expect(cl, label).toBe('errored'); expect(w.status, label).toBe('ERRORED'); }
          else if (!(c.stubs?.[ref]?.hang || c.stubs?.[ref]?.timeout)) expect(launched || w.status === 'SKIPPED', label).toBe(true);
        }
        checked += agentValues.filter(([ref]) => (stage.agents as Obj[]).find((a) => a.ref === ref)?.condition).length;
        // A stage whose own condition holds and whose agents are not all skipped is not SKIPPED by a condition.
        if (stage.condition && agentValues.some(([, v]) => v !== false)) expect(w.status, `${stage.id} ran`).not.toBe('SKIPPED');
      }
      // Feed the oracle forward: this stage's steps run for real (they are what conditions read), its
      // `passed` comes from the expected file.
      const result: StageResult = { id: stage.id, name: stage.id, type: 'command', status: w.status === 'SKIPPED' ? 'skipped' : 'completed', durationMs: 0 };
      if (stage.steps && stageRuns && w.status !== 'SKIPPED') {
        result.steps = await new StepsExecutor(noopLogger).execute(stage.steps as StepDefinition[], { target: input.target, params: ctx.params as never });
      }
      stageResults.push(result);
      passed.set(stage.id, w.passed === true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('conditions/step-output-with-steps-disabled: start() refuses with STEP_OUTPUT_STEPS_DISABLED before launch', async () => {
    const c = cases.find((x) => x.id === 'conditions/step-output-with-steps-disabled')!;
    const want = expected.get(c.id)!;
    expect(want.outcome).toBe('refused');
    const executor = new PipelineExecutor({} as never, {} as never, {} as never, {} as never, noopLogger, false);
    const err = await executor.start({ type: 'pipeline', definition: wrap(c) } as never, { target: '/tmp', params: c.params })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).context.refusal).toEqual(want.refused);
    // Negative control: the same case with steps enabled is not refused at this step.
    const enabled = new PipelineExecutor({} as never, {} as never, {} as never, {} as never, noopLogger, true);
    const handle = await enabled.start({ type: 'pipeline', definition: wrap(c) } as never, { target: '/tmp', params: c.params }).catch((e: unknown) => e);
    expect(handle).not.toBeInstanceOf(PipelineError);
    await (handle as { cancel(): Promise<void> }).cancel().catch(() => {});
  });
});

// ── P4a ──────────────────────────────────────────────────────────────────────

describe('PDL 1.6.0 conformance: agent verdicts through AgentExecutor (P4a)', () => {
  const launches: Array<[string, Obj, string, string]> = [];
  for (const c of cases) {
    const want = expected.get(c.id)!;
    if (!appliesToCore(c) || want.outcome !== 'ran') continue;
    for (const [stageId, w] of Object.entries(want.stages as Record<string, Obj>)) {
      for (const ref of (w.launched ?? []) as string[]) {
        const out = c.stubs?.[ref];
        if (out && !out.timeout && !out.hang) launches.push([`${c.id} ${stageId}/${ref}`, c, stageId, ref]);
      }
    }
  }

  it('covers every group\'s launched stubs (a filter that matched nothing would pass vacuously)', () => {
    expect(launches.filter(([, c]) => c.id.startsWith('decisions/')).length).toBeGreaterThanOrEqual(40);
    expect(launches.length).toBe(121);
  });

  it.each(launches)('%s', async (_label, c, stageId, ref) => {
    const want = expected.get(c.id)!;
    const w = (want.stages as Record<string, Obj>)[stageId]!;
    const stage = (c.pipeline.stages as Obj[]).find((s) => s.id === stageId)!;
    const gate = judging(stage);
    const result = await new AgentExecutor(config, provider(stubText(c.stubs[ref])), noopLogger).execute(resolvedStub(ref), { target: '/tmp' });
    const verdict = result.verdict!;
    const unjudgeable = isUnjudgeable({ class: verdict.class, score: result.score }, gate);

    const pinned = w.agents?.[ref];
    const cls = typeof pinned === 'object' ? pinned.class : pinned;
    if (cls === 'errored') expect(unjudgeable, `${ref} should be unjudgeable (class ${verdict.class}, score ${result.score})`).toBe(true);
    else {
      expect(unjudgeable, `${ref} is unjudgeable`).toBe(false);
      if (cls !== undefined) expect(verdict.class).toBe(cls);
    }
    if (typeof pinned === 'object' && pinned.saved !== undefined) expect(result.decision).toBe(pinned.saved);

    const wantWarnings = ((want.warnings ?? []) as Obj[])
      .filter((x) => VERDICT_CODES.has(x.code) && x.agent === ref && (!x.runtimes || x.runtimes.includes('core')))
      .map(({ runtimes: _r, ...x }) => x);
    const key = (x: Obj) => JSON.stringify(Object.entries(x).sort());
    expect(verdict.warnings.map(key).sort()).toEqual(wantWarnings.map(key).sort());
  });

  const byStage = new Map<string, typeof launches>();
  for (const l of launches) {
    const k = `${l[1].id} ${l[2]}`;
    byStage.set(k, [...(byStage.get(k) ?? []), l]);
  }
  it.each([...byStage])(
    '%s: STAGE_ERRORED agent_unjudgeable iff an agent is unjudgeable', async (_k, group) => {
      const [, c, stageId] = group[0]!;
      const want = expected.get(c.id)!;
      if ((c.pipeline.stages as Obj[]).find((s) => s.id === stageId)!.agents?.some((a: Obj) => c.stubs?.[a.ref]?.timeout || c.stubs?.[a.ref]?.hang)) return;
      const stage = (c.pipeline.stages as Obj[]).find((s) => s.id === stageId)!;
      const gate = judging(stage);
      let any = false;
      for (const [, , , ref] of group) {
        const r = await new AgentExecutor(config, provider(stubText(c.stubs[ref])), noopLogger).execute(resolvedStub(ref), { target: '/tmp' });
        any ||= isUnjudgeable({ class: r.verdict!.class, score: r.score }, gate);
      }
      const flagged = ((want.warnings ?? []) as Obj[]).some((x) => x.code === 'STAGE_ERRORED' && x.stage === stageId && x.reason === 'agent_unjudgeable');
      expect(any).toBe(flagged);
    },
  );

  const precheck = cases.filter((c) => c.id.startsWith('decisions/precheck-'));
  it.each(precheck.map((c) => [c.id as string, c]))('%s', async (_id, c) => {
    const want = expected.get(c.id)!;
    const registry = { resolve: async (name: string) => resolvedStub(name) };
    const executor = new PipelineExecutor({} as never, {} as never, {} as never, registry as never, noopLogger, true);
    const outcome = await executor.start({ type: 'pipeline', definition: wrap(c) } as never, { target: '/tmp', params: c.params })
      .catch((e: unknown) => e);
    if (want.outcome === 'refused') {
      expect(outcome).toBeInstanceOf(PipelineError);
      expect((outcome as PipelineError).context.refusal).toEqual(want.refused);
    } else {
      expect(outcome).not.toBeInstanceOf(PipelineError);
      await (outcome as { cancel(): Promise<void> }).cancel().catch(() => {});
    }
  });
});

// ── P4b ──────────────────────────────────────────────────────────────────────

/**
 * Every core case that runs, end to end through the real PipelineExecutor and AgentExecutor, with a
 * provider that returns each stub's text (README, Stub outputs) and a registry that resolves each
 * stub from `stubs/agents.yaml`. Asserted against the oracle: each stage's status and `passed`, the
 * agents launched, each agent's class (and saved decision where pinned), the upstream each stage
 * received, pinned step results, `all_gates_passed` (in memory AND as SubmissionClient writes it),
 * `run_decision`, ABORTED records reaching submission, and the warnings, exhaustively over the
 * README's codes (the agent-reading six plus STAGE_ERRORED and CONDITIONAL_ACCEPTED).
 *
 * Stub forms: `timeout` rejects with TimeoutError once the agent's timeout elapses; `hang` waits until
 * the run's signal aborts and rejects with CancelledError. Events: `stage:<id>:running` cancels once
 * every agent of <id> has started; `stage:<id>:done` cancels when <id> has been judged, before the
 * next stage launches (wrapping the executor's one judgement call).
 */
const STAGE_STATUS: Record<string, string> = { PASSED: 'PASSED', WARNED: 'WARNED', FAILED: 'FAILED', SKIPPED: 'SKIPPED', ERRORED: 'ERRORED' };
const RUN_CODES = new Set(['STAGE_ERRORED', 'CONDITIONAL_ACCEPTED']);

describe('PDL 1.6.0 conformance: every core case end to end (P4b)', () => {
  let root = '';
  let targets: Record<string, string> = {};
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pdl-conformance-run-'));
    cpSync(path.join(FIX, 'targets'), path.join(root, 'targets'), { recursive: true, verbatimSymlinks: true });
    const rel = (p: string) => path.relative(process.cwd(), path.join(root, 'targets', p));
    targets = { dir: rel('project'), file: rel('project/docs/design-spec.md'), symlink: rel('linked-spec.md') };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const runCases = cases.filter((c) => appliesToCore(c) && expected.get(c.id)!.outcome === 'ran');

  it('covers every group (a filter that matched nothing would pass vacuously)', () => {
    const groups = new Set(runCases.map(c => c.id.split('/')[0]));
    expect([...groups].sort()).toEqual(['conditions', 'decisions', 'gates', 'run-control', 'steps']);
    expect(runCases.length).toBe(113);
    expect(runCases.filter(c => c.events).length).toBe(2);
  });

  it.each(runCases.map((c) => [c.id as string, c]))('%s', async (_id, c) => {
    const want = expected.get(c.id)!;
    const { result, launches, written } = await runCase(c, targets, mockSave);
    const byId = new Map(result.stages.map(s => [s.id, s]));

    for (const [stageId, w] of Object.entries(want.stages as Record<string, Obj>)) {
      const got = byId.get(stageId);
      expect(got, `stage ${stageId} recorded`).toBeDefined();
      expect(got!.outcome, `${stageId} status`).toBe(STAGE_STATUS[w.status]);
      expect(got!.outcome === 'PASSED', `${stageId} passed`).toBe(w.passed);
      const launched = launches.filter(l => l.stage === stageId).map(l => l.agent);
      expect(launched.sort(), `${stageId} launched`).toEqual([...(w.launched ?? [])].sort());

      for (const [ref, pinned] of Object.entries((w.agents ?? {}) as Record<string, unknown>)) {
        const cls = typeof pinned === 'object' ? (pinned as Obj).class : pinned;
        const rec = got!.agentResults?.find(r => r.name === ref);
        const label = `${stageId}/${ref}`;
        if (cls === 'skipped') { expect(rec, `${label} skipped`).toBeUndefined(); continue; }
        if (cls === 'errored') {
          // Unjudgeable (D24, a crash or timeout included), stopped, or undispatched by a condition E.
          const stage = (c.pipeline.stages as Obj[]).find(s => s.id === stageId)!;
          const ok = rec === undefined
            || rec.version === '1.0.0-synthesized'
            || isUnjudgeable({ class: rec.verdict!.class, score: rec.score }, judging(stage));
          expect(ok, `${label} errored`).toBe(true);
          expect(got!.outcome, `${label}: an errored agent errors its stage`).toBe('ERRORED');
          continue;
        }
        expect(rec?.verdict?.class, `${label} class`).toBe(cls);
        if (typeof pinned === 'object' && (pinned as Obj).saved !== undefined) expect(rec!.decision, `${label} saved`).toBe((pinned as Obj).saved);
      }

      if (w.upstream) {
        const received = launches.filter(l => l.stage === stageId).map(l => l.upstream);
        expect(received.length, `${stageId} launched for upstream`).toBeGreaterThan(0);
        for (const up of received) {
          const shape = up.map(e => e.absent ? { stage: e.stageId, absent: e.absentReason } : { stage: e.stageId, agent: e.agentName });
          const wantShape = (w.upstream as Obj[]).map(e => e.absent === 'any' ? { stage: e.stage, absent: shape.find(x => x.stage === e.stage && 'absent' in x)?.absent ?? '(none)' } : e);
          expect(shape, `${stageId} upstream`).toEqual(wantShape);
        }
      }
    }

    for (const [stageId, steps] of Object.entries((want.steps ?? {}) as Record<string, Record<string, Obj>>)) {
      const got = Object.fromEntries((byId.get(stageId)!.steps ?? []).map(s => [s.name, { status: s.status, output: s.output }]));
      for (const [name, w] of Object.entries(steps)) expect(got[name], `${stageId}/${name}`).toEqual({ status: w.status, output: String(w.output) });
    }

    expect(result.allGatesPassed, 'all_gates_passed').toBe(want.all_gates_passed);
    expect(written.summary.allGatesPassed, 'all_gates_passed as SubmissionClient writes it').toBe(want.all_gates_passed);
    expect(result.decision, 'run_decision').toBe(want.run_decision);
    expect(written.rawMarkdown, 'params line').toMatch(/^params: \{/);

    for (const name of (want.aborted_records ?? []) as string[]) {
      expect(result.stages.flatMap(s => s.agentResults ?? []).find(r => r.name === name)?.decision, `${name} ABORTED`).toBe('ABORTED');
      expect(written.agents.find(a => a.name === name)?.decision, `${name} ABORTED reaches submission`).toBe('ABORTED');
    }

    const key = (x: Obj) => JSON.stringify(Object.entries(x).sort());
    const wantWarnings = ((want.warnings ?? []) as Obj[])
      .filter((x) => !x.runtimes || x.runtimes.includes('core'))
      .map(({ runtimes: _r, ...x }) => x);
    const gotWarnings = [
      ...result.warnings.filter(w => RUN_CODES.has(w.code)),
      ...result.stages.flatMap(s => s.agentResults ?? []).flatMap(r => r.verdict?.warnings ?? []).filter(w => VERDICT_CODES.has(w.code)),
    ] as Obj[];
    expect(gotWarnings.map(key).sort(), 'warnings').toEqual(wantWarnings.map(key).sort());
  }, 15_000);
});
