import { describe, it, expect } from 'vitest';
import { normalizePipelineSection } from '../../src/registry/normalize.js';

// Stage-type inference for PDL sections (pdl-steps-execution-spec D6/D7).
describe('normalizePipelineSection', () => {
  const section = (stages: Array<Record<string, unknown>>) => ({ stages });
  const stagesOf = (out: Record<string, unknown>) => out['stages'] as Array<Record<string, unknown>>;

  it('infers type agents for agents-array stages (existing behavior)', () => {
    const out = normalizePipelineSection(section([
      { id: 's', name: 'S', agents: [{ ref: 'a@1' }] },
    ]));
    expect(stagesOf(out)[0]!['type']).toBe('agents');
  });

  it('infers type command for ref stages (existing behavior)', () => {
    const out = normalizePipelineSection(section([
      { id: 's', name: 'S', ref: 'a@1' },
    ]));
    expect(stagesOf(out)[0]!['type']).toBe('command');
  });

  it('infers type steps for steps-only stages', () => {
    const out = normalizePipelineSection(section([
      { id: 'preflight', name: 'Preflight', steps: [{ name: 'Check', command: 'true' }] },
    ]));
    expect(stagesOf(out)[0]!['type']).toBe('steps');
    // steps preserved verbatim — nothing mapped away
    expect(stagesOf(out)[0]!['steps']).toEqual([{ name: 'Check', command: 'true' }]);
  });

  it('hoists a single-entry workflows array to ref with type workflow', () => {
    const out = normalizePipelineSection(section([
      { id: 'validate', name: 'Validate', workflows: [{ ref: 'ship@1.0.0', args: { target: '.' } }] },
    ]));
    const stage = stagesOf(out)[0]!;
    expect(stage['type']).toBe('workflow');
    expect(stage['ref']).toBe('ship@1.0.0');
  });

  it('does not hoist multi-entry workflows arrays', () => {
    const out = normalizePipelineSection(section([
      { id: 'multi', name: 'Multi', workflows: [{ ref: 'a@1' }, { ref: 'b@1' }] },
    ]));
    const stage = stagesOf(out)[0]!;
    expect(stage['type']).toBeUndefined();
    expect(stage['ref']).toBeUndefined();
  });

  it('does not override an explicit type or ref', () => {
    const out = normalizePipelineSection(section([
      { id: 's', name: 'S', type: 'command', ref: 'a@1', workflows: [{ ref: 'b@1' }] },
    ]));
    const stage = stagesOf(out)[0]!;
    expect(stage['type']).toBe('command');
    expect(stage['ref']).toBe('a@1');
  });

  it('prefers agents inference when a stage carries both agents and steps', () => {
    const out = normalizePipelineSection(section([
      { id: 's', name: 'S', agents: [{ ref: 'a@1' }], steps: [{ name: 'Check', command: 'true' }] },
    ]));
    expect(stagesOf(out)[0]!['type']).toBe('agents');
  });
});
