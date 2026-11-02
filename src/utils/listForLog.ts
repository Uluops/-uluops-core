/**
 * Model-authored names in a warning line: control characters stripped, each capped at 100
 * characters, at most 10 listed then `+k more` (spec v0.2.1 D8, CWE-117).
 */
export function listForLog(names: readonly string[]): string {
  const shown = names.slice(0, 10).map(n => {
    const clean = String(n).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean;
  });
  const more = names.length > 10 ? `, +${names.length - 10} more` : '';
  return `${shown.map(n => `"${n}"`).join(', ')}${more}`;
}
