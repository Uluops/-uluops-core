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
 *   neither. Stage statuses and gates are P4b's, so the whole run through PipelineExecutor waits for
 *   the stub-agent harness there; this checks every condition the fixtures hold, now.
 * - `conditions/step-output-with-steps-disabled`: start() refuses with STEP_OUTPUT_STEPS_DISABLED.
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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Logger } from '@uluops/sdk-core';
import { StepsExecutor } from '../../src/executor/StepsExecutor.js';
import { checkStepTemplateRules } from '../../src/executor/stepTemplates.js';
import { checkPipelineLoadRules, bindParameterDefaults } from '../../src/executor/pipelineLoad.js';
import { evaluateCondition, E, type ConditionContext } from '../../src/executor/conditions.js';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { PipelineError } from '../../src/errors/index.js';
import type { StageResult, StepDefinition } from '../../src/types/pipeline.js';

type Obj = Record<string, any>;
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdl-conformance');
const GROUPS = ['gates', 'decisions', 'conditions', 'steps', 'run-control', 'load-errors'];

const cases: Obj[] = GROUPS.flatMap((g) => YAML.parse(readFileSync(path.join(FIX, 'cases', `${g}.cases.yaml`), 'utf8')).cases);
const expected = new Map<string, Obj>(
  GROUPS.flatMap((g) => YAML.parse(readFileSync(path.join(FIX, 'expected', `${g}.expected.yaml`), 'utf8')).expected).map((e: Obj) => [e.id, e]),
);

/** The README's wrapping rule: `parameters` become the manual trigger's, with `target` prepended. */
function wrap(c: Obj): Obj {
  const declared: Obj[] = c.pipeline.parameters ?? [];
  const parameters = declared.some((p) => p.name === 'target') ? declared : [{ name: 'target', type: 'string', required: true }, ...declared];
  return {
    pipeline: {
      interface: { name: `conf-${c.id.split('/')[1]}`, version: '0.0.0', displayName: `conf ${c.id}`, description: `PDL conformance case ${c.id}`, domain: 'general' },
      triggers: [{ type: 'manual', allowed: true, parameters }],
      stages: c.pipeline.stages.map((s: Obj) => ({ name: s.id, ...s })),
    },
  };
}

const appliesToCore = (c: Obj): boolean => (c.applies_to ?? []).includes('core');

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
