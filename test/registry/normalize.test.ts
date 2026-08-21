import { describe, it, expect } from 'vitest';
import {
  normalizePipelineSection,
  normalizeWorkflowSection,
  normalizeCommandSection,
} from '../../src/registry/normalize.js';

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

  // Every rule in this file is guarded on the target field's absence — that is what
  // makes re-running the port over already-normalized (e.g. server-normalized) output
  // safe rather than redundant (tracker aafb93c2). These pin that each guard is a true
  // no-op, not just "doesn't crash": re-normalizing already-typed stages must not
  // touch a value a prior normalization pass (local or factory) already set.
  it('idempotence: already-typed stages (agents, command, workflow) are unchanged by a second pass', () => {
    const input = section([
      { id: 's1', name: 'S1', type: 'agents', agents: [{ ref: 'a@1' }] },
      { id: 's2', name: 'S2', type: 'command', ref: 'cmd@1' },
      { id: 's3', name: 'S3', type: 'workflow', ref: 'ship@1.0.0', workflows: [{ ref: 'ship@1.0.0' }] },
    ]);
    const out = normalizePipelineSection(input);
    expect(out).toEqual(input);
  });
});

// WDL orchestration.phases normalization (steps[] → commands[]/agentRefs[], condition →
// skip_if, gate.aggregate default).
describe('normalizeWorkflowSection', () => {
  it('idempotence: a phase already carrying commands[], skip_if, and gate.aggregate is unchanged', () => {
    const input = {
      orchestration: {
        phases: [
          {
            id: 'p1',
            commands: ['code-validator@1.0.0'],
            skip_if: 'NOT (true)',
            gate: { threshold: 70, aggregate: 'average' },
          },
        ],
      },
    };
    const out = normalizeWorkflowSection(input);
    expect(out).toEqual(input);
  });

  it('still maps steps[] → commands[]/agentRefs[] when absent (control: the guard can fail)', () => {
    const input = {
      orchestration: {
        phases: [{ id: 'p1', steps: [{ command: 'code-validator@1.0.0', agent: 'reviewer@1.0.0' }] }],
      },
    };
    const out = normalizeWorkflowSection(input);
    const phase = (out['orchestration'] as Record<string, unknown>)['phases'] as Array<Record<string, unknown>>;
    expect(phase[0]!['commands']).toEqual(['code-validator@1.0.0']);
    expect(phase[0]!['agentRefs']).toEqual(['reviewer@1.0.0']);
  });
});

// CDL invokes.agent(s) → agents[] normalization.
describe('normalizeCommandSection', () => {
  it('idempotence: agents[] already present is unchanged', () => {
    const input = { agents: ['code-validator@1.0.0'], invokes: { agent: 'code-validator@1.0.0' } };
    const out = normalizeCommandSection(input);
    expect(out).toEqual(input);
  });

  it('still maps invokes.agent → agents[] when absent (control: the guard can fail)', () => {
    const input = { invokes: { agent: 'code-validator@1.0.0' } };
    const out = normalizeCommandSection(input);
    expect(out['agents']).toEqual(['code-validator@1.0.0']);
  });
});
