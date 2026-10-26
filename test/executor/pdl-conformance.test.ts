/**
 * PDL 1.6.0 conformance fixtures, the parts build unit P3a owns (StepsExecutor and the step-template
 * load rules). The fixtures are vendored under `test/fixtures/pdl-conformance/` (`SOURCE` names the
 * corpus commit); their README is the harness contract.
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
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { PipelineError } from '../../src/errors/index.js';
import type { StepDefinition } from '../../src/types/pipeline.js';

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
