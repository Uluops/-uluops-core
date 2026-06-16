import type { DegradationMarker, Completeness, DegradationSeverity } from '../types/degradation.js';

/**
 * Derive a run's completeness from its degradation markers.
 *
 *   any critical → 'failed'
 *   any degraded → 'partial'
 *   else (none, or info-only) → 'complete'
 *
 * Pure and deterministic — identical across agent / workflow / pipeline.
 */
export function deriveCompleteness(markers: readonly DegradationMarker[]): Completeness {
  let sawDegraded = false;
  for (const m of markers) {
    if (m.severity === 'critical') return 'failed';
    if (m.severity === 'degraded') sawDegraded = true;
  }
  return sawDegraded ? 'partial' : 'complete';
}

/**
 * Mapping between legacy resolution-phase degradation strings (emitted by
 * RegistryClient) and the typed marker form. The legacy `degradations: string[]`
 * field on ResolvedDefinition / AgentResult remains the source of truth for
 * resolution-phase markers; this table derives the typed `degradationMarkers`
 * from it without changing the legacy field (byte-exact compatibility).
 *
 * `runtime:missing-<field>` is dynamic and handled specially below.
 */
const RESOLUTION_MARKER_TABLE: Record<string, { code: string; severity: DegradationSeverity }> = {
  'normalization-fallback': { code: 'normalization.fallback', severity: 'info' },
  'empty-definition': { code: 'definition.empty', severity: 'critical' },
  'render:raw-yaml-fallback': { code: 'render.raw-yaml-fallback', severity: 'degraded' },
  'render:api-unavailable': { code: 'render.api-unavailable', severity: 'degraded' },
  'runtime:live-rerender-fallback': { code: 'runtime.live-rerender-fallback', severity: 'info' },
  'prompt-hash-inconsistent': { code: 'integrity.prompt-hash-inconsistent', severity: 'degraded' },
};

const RUNTIME_MISSING_PREFIX = 'runtime:missing-';

/**
 * Convert legacy resolution-phase degradation strings into typed markers.
 * Order and duplicates are preserved (the typed array mirrors the legacy array
 * element-for-element). Unknown strings degrade gracefully to a `degraded`
 * marker carrying the raw string as its code, so nothing is silently dropped.
 */
export function resolutionMarkersFromLegacy(legacy: readonly string[]): DegradationMarker[] {
  return legacy.map((s): DegradationMarker => {
    if (s.startsWith(RUNTIME_MISSING_PREFIX)) {
      return {
        code: 'runtime.missing-field',
        phase: 'resolution',
        severity: 'degraded',
        detail: s.slice(RUNTIME_MISSING_PREFIX.length),
      };
    }
    const mapped = RESOLUTION_MARKER_TABLE[s];
    if (mapped) {
      return { code: mapped.code, phase: 'resolution', severity: mapped.severity };
    }
    // Unknown legacy marker — preserve as-is rather than drop.
    return { code: s, phase: 'resolution', severity: 'degraded' };
  });
}
