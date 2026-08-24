import { describe, it, expect } from 'vitest';
import { deriveCompleteness, resolutionMarkersFromLegacy } from '../../src/executor/degradationMarkers.js';
import type { DegradationMarker } from '../../src/types/degradation.js';

const m = (severity: DegradationMarker['severity']): DegradationMarker => ({
  code: 'x', phase: 'execution', severity,
});

describe('deriveCompleteness', () => {
  it('returns complete for no markers', () => {
    expect(deriveCompleteness([])).toBe('complete');
  });

  it('returns complete for info-only markers', () => {
    expect(deriveCompleteness([m('info'), m('info')])).toBe('complete');
  });

  it('returns partial when any marker is degraded (and none critical)', () => {
    expect(deriveCompleteness([m('info'), m('degraded')])).toBe('partial');
  });

  it('returns failed when any marker is critical, regardless of others', () => {
    expect(deriveCompleteness([m('degraded'), m('critical'), m('info')])).toBe('failed');
  });
});

describe('resolutionMarkersFromLegacy', () => {
  it('maps each known legacy string to the right code + severity', () => {
    const out = resolutionMarkersFromLegacy([
      'normalization-fallback',
      'empty-definition',
      'render:raw-yaml-fallback',
      'render:api-unavailable',
      'runtime:live-rerender-fallback',
      'prompt-hash-inconsistent',
    ]);
    expect(out.map(x => x.code)).toEqual([
      'normalization.fallback',
      'definition.empty',
      'render.raw-yaml-fallback',
      'render.api-unavailable',
      'runtime.live-rerender-fallback',
      'integrity.prompt-hash-inconsistent',
    ]);
    // All resolution-phase
    expect(out.every(x => x.phase === 'resolution')).toBe(true);
    // Severities
    expect(out.find(x => x.code === 'definition.empty')!.severity).toBe('critical');
    expect(out.find(x => x.code === 'normalization.fallback')!.severity).toBe('info');
    expect(out.find(x => x.code === 'runtime.live-rerender-fallback')!.severity).toBe('info');
    expect(out.find(x => x.code === 'render.raw-yaml-fallback')!.severity).toBe('degraded');
  });

  it('reconstructs the dynamic runtime:missing-<field> form into detail', () => {
    const out = resolutionMarkersFromLegacy(['runtime:missing-promptHash']);
    expect(out[0]).toEqual({
      code: 'runtime.missing-field',
      phase: 'resolution',
      severity: 'degraded',
      detail: 'promptHash',
    });
  });

  it('preserves order and duplicates (e.g. empty-definition twice)', () => {
    const out = resolutionMarkersFromLegacy(['empty-definition', 'normalization-fallback', 'empty-definition']);
    expect(out.map(x => x.code)).toEqual(['definition.empty', 'normalization.fallback', 'definition.empty']);
  });

  it('preserves unknown strings as the code rather than dropping them', () => {
    const out = resolutionMarkersFromLegacy(['some-future-marker']);
    expect(out[0]).toEqual({ code: 'some-future-marker', phase: 'resolution', severity: 'degraded' });
  });

  it('returns empty for empty input', () => {
    expect(resolutionMarkersFromLegacy([])).toEqual([]);
  });
});

/**
 * Withdrawing a false marker must not install silence in its place.
 *
 * POSITIVE CONTROL: delete the `budgetTracker.brakeInert` block from
 * `collectExecutionMarkers` and the first test fails.
 *
 * 0.42.0 correctly stopped emitting `budget.forced-wrap-up` where the Anthropic jsonTool
 * `toolChoice` override makes the brake inert — the run was reporting a wrap-up that never
 * happened. But replacing a false claim with no claim trades one reporting defect for
 * another: `types/degradation.ts` rests the PASS+partial decision on invariant (1),
 * "every coverage reduction emits a marker; nothing degrades silently", and a caller whose
 * configured cost ceiling provably did not apply has something it needs to know.
 *
 * SEVERITY IS `info`, DELIBERATELY, and this is the judgment call: nothing was cut short,
 * so the run is genuinely `complete` and must NOT be downgraded to `partial`. What failed
 * is the caller's cost ceiling, not the agent's coverage. Marking it `degraded` would
 * re-introduce exactly the false `partial` that was just removed.
 */
describe('budget.brake-inert marker', () => {
  it('does not downgrade completeness — the run really is complete', () => {
    const completeness = deriveCompleteness([
      { code: 'budget.brake-inert', phase: 'execution', severity: 'info',
        detail: 'brake could not engage' },
    ]);
    expect(completeness).toBe('complete');
  });

  it('is distinguishable from the forced-wrap-up marker it replaced', () => {
    // The two must not be conflated: one says "coverage was cut short", the other says
    // "your cost ceiling did not apply". Only the first is a degradation.
    expect(deriveCompleteness([
      { code: 'budget.forced-wrap-up', phase: 'execution', severity: 'degraded',
        detail: 'wrap-up forced' },
    ])).toBe('partial');
  });
});
