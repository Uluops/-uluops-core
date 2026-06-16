/**
 * Degradation markers and execution completeness.
 *
 * Two orthogonal axes describe an agent run:
 *  - DECISION (existing): what the agent concluded — PASS/FAIL/EXAMINED/… → DecisionCategory.
 *  - COMPLETENESS (this module): whether the run actually finished its work.
 *
 * A run can be PASS + partial (a positive verdict on incomplete evidence — the
 * case worth surfacing) or FAIL + complete (a confident negative). Completeness
 * is OBSERVED by the engine from degradation markers; agents never self-report it.
 *
 * Scope: this is a property of the core execution engine running an agent through
 * its tool loop. External-harness recordings have no completeness.
 */

/** Phase of execution where a degradation occurred. */
export type DegradationPhase = 'resolution' | 'execution';

/**
 * Severity drives completeness derivation:
 *  - info:     noted, no completeness impact (a benign fallback producing equivalent output)
 *  - degraded: result is usable but coverage/quality is reduced  → contributes 'partial'
 *  - critical: result cannot be trusted as a finished work        → contributes 'failed'
 */
export type DegradationSeverity = 'info' | 'degraded' | 'critical';

/**
 * A typed degradation marker. `code` is the stable, namespaced machine token —
 * the contract consumers match on. `detail` is human-readable context and is
 * explicitly NOT a contract (never match on it).
 */
export interface DegradationMarker {
  /** Stable, namespaced machine token, e.g. 'budget.forced-wrap-up'. THE contract. */
  code: string;
  phase: DegradationPhase;
  severity: DegradationSeverity;
  /** Human-readable context. NOT a contract — consumers must not match on this. */
  detail?: string;
}

/**
 * Derived completeness of a run. Absent on a result ⇒ treat as 'complete'.
 *
 * NOTE: these tokens coincide with the executor *decision* completion vocabulary
 * (`completion.vocabulary: { complete, partial, failed }` in classifyDecision).
 * They are orthogonal: decision = what the agent concluded; completeness =
 * whether the run finished its work. Do not conflate the two enums.
 */
export type Completeness = 'complete' | 'partial' | 'failed';
