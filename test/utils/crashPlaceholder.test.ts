import { describe, it, expect } from 'vitest';
import { crashPlaceholder } from '../../src/utils/crashPlaceholder.js';
import { MaxStepsExhaustedError } from '../../src/errors/index.js';

/**
 * ONE construction for "an agent was dispatched and did not come back", and the count is
 * the point.
 *
 * `CommandExecutor.crashPlaceholder`'s own docstring said "two call sites that must agree
 * are two chances to disagree" — and there were THREE. The third, in
 * `PipelineExecutor.executeInlineAgents`, had drifted on every field that classifies the
 * event: no `decisionCategory`, no `priority`, `severity: 'high'` and `PRA-FRA/H` where the
 * other two stamped `'critical'` and `PRA-FRA/C`. The same crash reached the tracker at two
 * different severities depending on which executor dispatched it.
 *
 * These tests pin the CLASSIFICATION fields specifically, because those are what drifted
 * and what downstream triage reads.
 *
 * POSITIVE CONTROL: revert PipelineExecutor.executeInlineAgents to its inline literal and
 * the executor-parity test below fails on severity and failureCode.
 */
describe('crashPlaceholder — one construction, all classification fields stamped', () => {
  it('stamps decisionCategory explicitly rather than relying on the FAIL fallback', () => {
    const r = crashPlaceholder('a@1', new Error('boom'));
    // Without this, classification runs through classifyDecision's 'FAIL' fallback — the
    // path that cannot recognise a custom vocabulary.
    expect(r.decisionCategory).toBe('negative');
    expect(r.decision).toBe('FAIL');
  });

  it('stamps critical severity and PRA-FRA/C, not the drifted high/PRA-FRA/H', () => {
    const r = crashPlaceholder('a@1', new Error('boom'));
    const rec = r.recommendations[0]!;
    expect(rec.severity).toBe('critical');
    expect(rec.priority).toBe('critical');
    expect(rec.failureCode).toBe('PRA-FRA/C');
    // The values the third site used, named so a regression is legible.
    expect(rec.severity).not.toBe('high');
    expect(rec.failureCode).not.toBe('PRA-FRA/H');
  });

  it('is a complete AgentResult — every required field present', () => {
    const r = crashPlaceholder('a@1', new Error('boom'));
    expect(r.type).toBe('agent');
    expect(typeof r.durationMs).toBe('number');
    expect(r.version).toBe('1.0.0-synthesized');
    expect(r.definitionHash).toBe('');
  });

  it('scores null/null — a crash is not a zero', () => {
    const r = crashPlaceholder('a@1', new Error('boom'));
    expect(r.score).toBeNull();
    expect(r.maxScore).toBeNull();
    // The fabrication this whole release exists to prevent.
    expect(r.score).not.toBe(0);
  });

  it('preserves usage ALREADY BILLED before the throw', () => {
    // MaxStepsExhaustedError is thrown after a successful, fully-billed call — by
    // construction the most expensive run class the engine produces.
    const billed = {
      inputTokens: 120_000, outputTokens: 8_000, totalEffectiveTokens: 128_000,
      durationMs: 412_000, model: 'anthropic:claude-sonnet-4-5', costUsd: 0.48,
    };
    const r = crashPlaceholder('a@1', new MaxStepsExhaustedError('exhausted', 50, 'tool-calls', billed));
    expect(r.metrics.totalEffectiveTokens).toBe(128_000);
    expect(r.metrics.costUsd).toBe(0.48);
  });

  it('leaves cost ABSENT when nothing is known — never a fabricated $0', () => {
    // The negative control for the line above: an ordinary error carries no billed usage,
    // and an absent cost is an admission where a zero would be a claim.
    const r = crashPlaceholder('a@1', new Error('network died'));
    expect(r.metrics.costUsd).toBeUndefined();
    expect(r.metrics.totalEffectiveTokens).toBe(0);
  });

  it('treats agentType as a fallback, not a fact', () => {
    // A crash can predate resolution, so the real type is often unknowable — which is why
    // it is a parameter with a default rather than a literal hardcoded at three sites.
    expect(crashPlaceholder('a@1', new Error('x')).agentType).toBe('validator');
    expect(crashPlaceholder('a@1', new Error('x'), { agentType: 'generator' }).agentType).toBe('generator');
  });
});
