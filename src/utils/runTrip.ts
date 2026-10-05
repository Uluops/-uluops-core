/**
 * Stop a running pipeline from inside one of its provider calls (OpenRouter plan D13).
 *
 * A provider 402 (no credit) cannot be fixed by a retry, and every later stage and in-flight
 * sibling would spend a request to learn the same thing. The pipeline's run controller is the
 * only thing that can stop all of them, and it lives on the PipelineHandle, unreachable from
 * AIProvider. This registry bridges the two WITHOUT adding anything to a public type: the
 * pipeline registers its run signal, and AIProvider looks up the signal it was handed.
 *
 * Module-internal and deliberately NOT exported from the package. Keyed by the AbortSignal
 * OBJECT: every executor hop forwards the same object (Pipeline → Workflow → Command → Agent →
 * AIProvider), so the lookup is identity, not configuration. A hop that wraps the signal
 * (`AbortSignal.any([signal])`) makes the lookup miss, and the run then fails with the typed
 * error instead of cancelling — degraded, never wrong. WeakMap, so a run that is never
 * unregistered still cannot pin its signal in memory.
 */
const trips = new WeakMap<AbortSignal, (reason: string) => boolean>();

/**
 * Register a run's stop function under its signal. Called by PipelineExecutor.start(). The
 * function returns whether it stopped the run: false when the run had already ended.
 */
export function registerRunTrip(signal: AbortSignal, trip: (reason: string) => boolean): void {
  trips.set(signal, trip);
}

/** Remove a run's registration. Called when the run's execution settles. */
export function unregisterRunTrip(signal: AbortSignal): void {
  trips.delete(signal);
}

/**
 * Stop the run that owns `signal`, if one is registered and still running. Returns whether
 * THIS call stopped it: false for a standalone agent (no registration), and false for a run that
 * had already ended — a second concurrent 402, or one landing after a user cancel — so the
 * caller never reports a stop it did not cause.
 */
export function tripRunFor(signal: AbortSignal | undefined, reason: string): boolean {
  const trip = signal ? trips.get(signal) : undefined;
  return trip ? trip(reason) : false;
}
