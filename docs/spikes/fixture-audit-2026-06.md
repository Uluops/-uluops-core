# Spike 0c — Test fixture audit (score/maxScore/points literals)

**Spec:** `agent-schema-score-nullability-spec` (Phase 0c)
**Date:** 2026-06-22
**Scope:** `packages/-uluops-core/test/`, `packages/-uluops-ops-sdk/test/`, `packages/-uluops-cli/test/`

## Method

Grepped `maxScore: 100` / `maxScore ?? 100`, `score: 0` / `score ?? 0` (excl. maxScore), `pointsEarned/pointsPossible: 0`. Classified each: **VALIDATOR-SHAPED (keep)** / **GENERATOR-SHAPED (→null)** / **ASSERTION-OF-OLD-BEHAVIOR (rewrite)**.

## Summary

- **VALIDATOR-SHAPED (keep): ~33** — genuine validator/analyst/forecaster scores, category sub-scores, agent-definition `scoring.maxScore` scales, and range/constraint tests. No change.
- **GENERATOR-SHAPED (→null): 7** — fidelity updates (won't go red, but encode the old "fabricate a score" convention):
  - `core/test/parser/outputSchemas.test.ts:117-118, 134-135, 147-148` (COMPLETE + artifacts)
  - `core/test/parser/outputSchemas.test.ts:287-288` (EXPLORED, fabricated score 0)
  - `core/test/analysis/AnalysisSummaryExtractor.test.ts:265, 275` (EXPLORED, score 0)
- **BORDERLINE (human call): 2** — carry both a generator/explorer decision AND a real score; decide whether that agent class legitimately scores before flipping:
  - `outputSchemas.test.ts:258` (COMPLETE + category scores)
  - `outputSchemas.test.ts:367` (EXPLORED + score 78)

## ⚠️ Hazards — must address

1. **`-uluops-ops-sdk/test/types/nullable-score.test.ts:67-91`** — constructs an `AgentSnapshotResponseSchema` payload with `score: null, maxScore: 100` for a generator and asserts `success === true`. **Violates the spec invariant `score === null IFF maxScore === null`.** If/when an IFF refinement lands on the ops-sdk response schema, this goes RED. **This file is ops-sdk (companion-spec scope)** — flag to the companion spec; rewrite to `maxScore: null` + add a negative case asserting the half-null shape is rejected.

2. **`-uluops-core/test/submission/SubmissionClient.test.ts:441, 454`** — fetches a run with `averageScore: null` and asserts `expect(history[0].averageScore).toBe(0); // null → 0`. This codifies the run-level `null → 0` coercion that the spec's **averageScore = OMIT** decision removes. **Must be updated** to assert null-preservation (`.toBeNull()`) once Phase 5 lands, consistent with V16b. In-scope for this spec.

3. **`-uluops-core/test/parser/outputSchemas.test.ts:183-187`** ("rejects missing required fields", `parse({decision:'PASS'}).toThrow()`) — **soft**. Stays green after the change (other required keys still force the throw), but its intent silently shifts. Update the name/comment or split out an explicit "score+maxScore may be null" positive case so the loosening is asserted, not incidentally tolerated.

## Action for Phase 4/6 mutation-test work

- Flip the 7 GENERATOR-SHAPED fixtures to `null` for fidelity (low priority — no breakage).
- Resolve the 2 BORDERLINE cases with a human decision on explorer/COMPLETE scoring.
- Rewrite hazard #2 (`SubmissionClient.test.ts:441/454`) alongside the Phase 5 averageScore change.
- Cross-file hazard #1 to the companion spec.
