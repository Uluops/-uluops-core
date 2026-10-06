/**
 * Did the caller's own deadline fire? `AbortSignal.timeout(ms)` aborts with a DOMException
 * named `TimeoutError`; an explicit `controller.abort()` does not. The reason survives
 * `AbortSignal.any`, so the run's merged signal answers the same as the caller's.
 *
 * A deadline is a TIMEOUT, not a decision to stop (Alex 2026-10-05, after crew #110 P1): the
 * agents still in flight when it fires are the slow ones, plausibly the broken ones, and
 * recording them ABORTED — neutral, no issue — would launder exactly those failures into
 * non-verdicts. Same reasoning as the credit trip ending `failed` rather than `cancelled`.
 */
export function isDeadlineSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
}

/**
 * Is a rejection an abort CAUSED BY a stop of the run that owns `runSignal`?
 * (aborted-agent-recording spec §4.) All three conjuncts are required.
 *
 * - **The error conjunct** (`code === 'CANCELLED'`). By the time a stopped run's children are
 *   classified, the signal is aborted for every child — including one that had already crashed
 *   or timed out for its own reasons. A signal-only rule would launder those crashes into
 *   ABORTED. `ProviderCreditError` (the 402 originator is not innocent), `MaxStepsExhaustedError`
 *   (its billed metrics flow through the crash path), an sdk-core `TimeoutError` and a raw
 *   DOMException (`code` is a number) are crashes.
 * - **The signal conjunct** (`runSignal.aborted`). A `CANCELLED` error while this run's signal is
 *   live is not a stop of this run — a foreign producer, a nested consumer's own signal. Treated as
 *   a crash: the conservative direction is to over-report a failure, never to hide one.
 * - **Not a deadline** ({@link isDeadlineSignal}). A caller deadline is a timeout; its agents are
 *   crashes.
 *
 * Callers on a parallel arm evaluate this AT REJECTION TIME (a per-promise `.catch`), not after
 * `Promise.allSettled` settles: a foreign `CANCELLED` that rejected while the signal was live must
 * not be reclassified because the run stopped later (crew #110 F5).
 *
 * Known limit, not claimed away: `AIProvider.mapError` turns an SDK timeout DOMException into a
 * `CancelledError` whenever the caller signal is already aborted when the error is mapped. So an
 * agent whose own request timeout fires in the same instant as a stop can be recorded ABORTED.
 * The window is the gap between the two events; it is not closed here.
 *
 * Identity-free (`code`, never `instanceof`), for the reason `hasBilledMetrics` gives: two copies of
 * core in one tree are two `CancelledError` classes.
 */
export function isRunStopAbort(reason: unknown, runSignal: AbortSignal | undefined): boolean {
  return runSignal?.aborted === true
    && !isDeadlineSignal(runSignal)
    && typeof reason === 'object' && reason !== null
    && (reason as { code?: unknown }).code === 'CANCELLED';
}
