/**
 * OpenRouter's `provider.data_collection` value from config, env or a request (plan D7).
 *
 * `'allow'` or `'deny'`, case and surrounding space ignored; anything else is undefined, so every
 * caller falls back toward the safe `'deny'` default rather than sending a malformed value.
 */
export function dataCollectionValue(value: unknown): 'allow' | 'deny' | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'allow' || v === 'deny' ? v : undefined;
}
