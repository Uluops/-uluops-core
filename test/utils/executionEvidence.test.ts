import { describe, it, expect } from 'vitest';
import { verifiedNothingExecuted } from '../../src/utils/executionEvidence.js';
import { makeWorkflowResult, makeCommandResult } from '../executor/fixtures.js';

describe('verifiedNothingExecuted — positive evidence only, never the score', () => {
  it('true for a workflow whose executor counted zero executed phases', () => {
    const wf = makeWorkflowResult({ score: 0, metrics: { ...makeWorkflowResult().metrics, phasesExecuted: 0, phasesSkipped: 3 } });
    expect(verifiedNothingExecuted(wf)).toBe(true);
  });

  it('CONTROL: false for a workflow that ran one phase and scored 0 — a real result, not an absence', () => {
    const wf = makeWorkflowResult({ score: 0, metrics: { ...makeWorkflowResult().metrics, phasesExecuted: 1, phasesBlocked: 1 } });
    expect(verifiedNothingExecuted(wf)).toBe(false);
  });

  it('true for a pipeline with zero executed stages', () => {
    expect(verifiedNothingExecuted({ type: 'pipeline', metrics: { stagesExecuted: 0 } })).toBe(true);
  });

  it('CONTROL: false for a pipeline with one executed stage, whatever its score', () => {
    expect(verifiedNothingExecuted({ type: 'pipeline', metrics: { stagesExecuted: 1 } })).toBe(false);
  });

  it('false for shapes it holds no evidence about: undefined, command, agent, or a workflow with no metrics block', () => {
    expect(verifiedNothingExecuted(undefined)).toBe(false);
    expect(verifiedNothingExecuted(makeCommandResult({ score: 0 }))).toBe(false);
    expect(verifiedNothingExecuted({ type: 'agent', metrics: {} })).toBe(false);
    expect(verifiedNothingExecuted({ type: 'workflow' })).toBe(false);
    // Absence of the count is absence of evidence, not evidence of absence.
    expect(verifiedNothingExecuted({ type: 'workflow', metrics: {} })).toBe(false);
  });
});
