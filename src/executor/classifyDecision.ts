/**
 * Re-export of the canonical decision-classification module.
 *
 * The implementation moved to @uluops/sdk-core/decisions (2026-07-22, OQ-1b of
 * ops-uluops-api's save-run-decision-semantics spec v0.2.1): the module is pure
 * and dependency-free, and consumers like the ops API need the canonical
 * register without this package's AI-SDK dependency stack. This re-export
 * preserves every existing @uluops/core import path unchanged.
 *
 * Register note: sdk-core 0.16.0 extends the core register with
 * APPROVED/PROCEED (positive) and BLOCKED (negative) — issue 44a7a67c. For
 * this package that means SubmissionClient's isPositiveDecision now reports
 * allGatesPassed=true for APPROVED/PROCEED results (previously neutral →
 * fail-closed false), and executor gates treat BLOCKED as negative. Both are
 * intended corrections: these are genuine gate verdicts in the corpus.
 */
export {
  classifyDecision,
  resolveDecisionCategory,
  buildVocabularyMap,
  type DecisionCategory,
  type DecisionVocabularyMap,
} from '@uluops/sdk-core/decisions';
