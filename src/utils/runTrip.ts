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
const trips = new WeakMap<AbortSignal, (reason: string) => void>();

/** Register a run's stop function under its signal. Called by PipelineExecutor.start(). */
export function registerRunTrip(signal: AbortSignal, trip: (reason: string) => void): void {
  trips.set(signal, trip);
}

/** Remove a run's registration. Called when the run's execution settles. */
export function unregisterRunTrip(signal: AbortSignal): void {
  trips.delete(signal);
}

/**
 * Stop the run that owns `signal`, if one is registered. Returns whether a run was stopped, so
 * the caller can say so; a standalone agent (no pipeline) has no registration and is untouched.
 */
export function tripRunFor(signal: AbortSignal | undefined, reason: string): boolean {
  const trip = signal ? trips.get(signal) : undefined;
  if (!trip) return false;
  trip(reason);
  return true;
}
