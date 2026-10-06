/**
 * OpenRouter's `provider.data_collection` value from config, env or a request (plan D7).
 *
 * `'allow'` or `'deny'`, case and surrounding space ignored; anything else is undefined. Callers
 * resolve layers with {@link firstDataCollection}, never by chaining this with `??` — a chain lets a
 * malformed value at one layer fall through to an `'allow'` at a lower one.
 */
export function dataCollectionValue(value: unknown): 'allow' | 'deny' | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'allow' || v === 'deny' ? v : undefined;
}

/**
 * The first layer that SET a value decides: a valid value is used, a malformed one is `'deny'`.
 * A layer is unset when it is `undefined`, `null` or a blank string (an exported-but-empty env var).
 * Fail-closed per layer (D7 fold, perverse-outcome P6): a typo meant to pin one project to deny must
 * not silently inherit an `'allow'` from the shell.
 */
export function firstDataCollection(...layers: unknown[]): { value: 'allow' | 'deny'; layer: number } | undefined {
  for (let i = 0; i < layers.length; i++) {
    const raw = layers[i];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue;
    return { value: dataCollectionValue(raw) ?? 'deny', layer: i };
  }
  return undefined;
}
