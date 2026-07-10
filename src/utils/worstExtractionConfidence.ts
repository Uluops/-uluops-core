/**
 * Worst (minimum) extraction confidence across child results, or undefined
 * when no child carries one (e.g. structured-output children that never
 * degraded, or synthesized crash placeholders).
 *
 * Composite results (command/workflow/pipeline) carry the worst child's
 * confidence so the SubmissionClient gate can refuse to report
 * allGatesPassed on a composite whose weakest child was regex-parsed below
 * the trust threshold (issue e037aa98) — min, not average, because one
 * untrustworthy child taints the composite's positive verdict the same way
 * one low-confidence agent taints its own.
 */
export function worstExtractionConfidence(
  results: ReadonlyArray<{ extractionConfidence?: number }>,
): number | undefined {
  let worst: number | undefined;
  for (const r of results) {
    if (
      typeof r.extractionConfidence === 'number' &&
      (worst === undefined || r.extractionConfidence < worst)
    ) {
      worst = r.extractionConfidence;
    }
  }
  return worst;
}
