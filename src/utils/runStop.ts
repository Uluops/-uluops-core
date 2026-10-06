/**
 * Is a rejection an abort CAUSED BY a stop of the run that owns `runSignal`?
 * (aborted-agent-recording spec §4.) Both conjuncts are required; neither alone is sufficient.
 *
 * - **The error conjunct** (`code === 'CANCELLED'`). Executors classify after `Promise.allSettled`
 *   settles, by which time a stopped run's signal is aborted for EVERY child — including one that
 *   had already crashed or timed out for its own reasons. A signal-only rule would launder those
 *   crashes into ABORTED. A `TimeoutError` (`TIMEOUT`) is always a crash, even inside a stopped
 *   run; so are `ProviderCreditError` (the 402 originator is not innocent), `MaxStepsExhaustedError`
 *   (its billed metrics flow through the crash path) and a raw DOMException (`code` is a number).
 * - **The signal conjunct** (`runSignal.aborted`). A `CANCELLED` error while this run's signal is
 *   live is not a stop of this run — a foreign producer, a nested consumer's own signal. Treated as
 *   a crash: the conservative direction is to over-report a failure, never to hide one.
 *
 * Identity-free (`code`, never `instanceof`), for the reason `hasBilledMetrics` gives: two copies of
 * core in one tree are two `CancelledError` classes.
 *
 * Accepted false crash: an abort surfacing as anything other than a mapped `CancelledError` (a tool
 * callback that throws its own error on abort) is still recorded as a crash. Over-reporting is the
 * safe direction.
 */
export function isRunStopAbort(reason: unknown, runSignal: AbortSignal | undefined): boolean {
  return runSignal?.aborted === true
    && typeof reason === 'object' && reason !== null
    && (reason as { code?: unknown }).code === 'CANCELLED';
}
