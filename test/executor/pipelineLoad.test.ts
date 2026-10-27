/**
 * Core's PDL 1.6.0 load validator (P3b), unit level. The conformance fixtures hold each load-error
 * code at its location (`pdl-conformance.test.ts`); these tests pin what the fixtures do not reach:
 * self-dependency, the runtime shape core receives after normalization, collecting every error, the
 * steps-disabled reader scan, and default binding.
 */
import { describe, it, expect } from 'vitest';
import { checkPipelineLoadRules, stagesReadingStepOutput, bindParameterDefaults } from '../../src/executor/pipelineLoad.js';
import { normalizePipelineSection } from '../../src/registry/normalize.js';

const codes = (pipeline: unknown) => checkPipelineLoadRules(pipeline as never).errors.map(e => [e.code, e.at]);

describe('checkPipelineLoadRules', () => {
  it('refuses a stage that depends on itself as a forward reference, and it is still not its own ancestor', () => {
    expect(codes({
      stages: [{ id: 'a', depends_on: ['a'], steps: [{ name: 'n', command: 'true' }], agents: [{ ref: 'x', condition: "stages.a.steps['n'].output" }] }],
    })).toEqual([['forward_reference', 'stage:a'], ['non_ancestor_reference', 'stage:a/agent:x']]);
  });

  it('accepts the keys normalization stamps on a stage (type, ref), so a registry-resolved pipeline loads', () => {
    const authored = {
      stages: [
        { id: 'pre', steps: [{ name: 'n', command: 'true' }] },
        { id: 'review', depends_on: ['pre'], agents: [{ ref: 'architect' }] },
        { id: 'wf', depends_on: ['review'], workflows: [{ ref: 'post-implementation' }] },
      ],
    };
    const normalized = normalizePipelineSection(authored);
    expect((normalized['stages'] as Array<Record<string, unknown>>).map(s => s['type'])).toEqual(['steps', 'agents', 'workflow']);
    expect(codes(normalized)).toEqual([]);
  });

  it('refuses a stage `options` key: core typed it, PDL 1.6.0 does not declare it', () => {
    expect(codes({ stages: [{ id: 'a', options: {} }] })).toEqual([['unknown_key', 'stage:a']]);
  });

  it('collects every error, not only the first, and reports one fault per condition', () => {
    expect(codes({
      stages: [
        { id: 'a', condition: "params.x == 'y' && trigger.type", gate: { thresold: 1 } },
        { id: 'b', depends_on: ['c'] },
        { id: 'c', agents: [{ ref: 'r', threshold: 80 }, { ref: 's' }] },
      ],
    })).toEqual([
      ['unknown_key', 'stage:a'],
      ['undeclared_parameter', 'stage:a'],
      ['forward_reference', 'stage:b'],
      ['missing_threshold', 'stage:c/agent:s'],
    ]);
  });

  it('reads declared parameters from every trigger', () => {
    expect(codes({
      triggers: [{ type: 'manual', parameters: [{ name: 'a' }] }, { type: 'webhook', parameters: [{ name: 'b' }] }],
      stages: [{ id: 's', condition: 'params.a && params.b' }],
    })).toEqual([]);
  });

  it('warns SKIP_DEPRECATED on on_failure: skip', () => {
    const { errors, warnings } = checkPipelineLoadRules({ stages: [{ id: 'a', gate: { on_failure: 'skip' } }] });
    expect(errors).toEqual([]);
    expect(warnings.map(w => [w.code, w.stage])).toEqual([['SKIP_DEPRECATED', 'a']]);
  });

  it('tolerates a malformed definition without throwing (registry YAML has no runtime schema behind it)', () => {
    expect(() => checkPipelineLoadRules({ stages: [null, 3, { id: 'a', depends_on: 'x', agents: 'y', gate: [] }] } as never)).not.toThrow();
  });
});

describe('stagesReadingStepOutput', () => {
  it('names each stage whose own or agent condition reads step output', () => {
    expect(stagesReadingStepOutput({
      stages: [
        { id: 'pre', steps: [{ name: 'n', command: 'true' }] },
        { id: 'a', condition: "stages.pre.steps['n'].output == 'X'" },
        { id: 'b', agents: [{ ref: 'r', condition: "params.p || stages.pre.steps['n'].output" }] },
        { id: 'c', condition: 'stages.pre.passed' },
      ],
    })).toEqual(['a', 'b']);
  });
});

describe('bindParameterDefaults', () => {
  const pipeline = { triggers: [{ parameters: [{ name: 'mode', default: 'fast' }, { name: 'n', default: 3 }, { name: 'none' }, { name: 'obj', default: { a: 1 } }] }] };

  it('binds declared scalar defaults where the caller gave no value, and the target', () => {
    expect(bindParameterDefaults(pipeline, { mode: 'deep' }, '/t')).toEqual({ mode: 'deep', n: 3, target: '/t' });
  });

  it('keeps a caller-supplied target parameter', () => {
    expect(bindParameterDefaults(pipeline, { target: '/given' }, '/t')['target']).toBe('/given');
  });
});
