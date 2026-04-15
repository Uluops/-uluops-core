/**
 * Canonical decision register normalization.
 *
 * The system uses four decision vocabularies across its execution layers:
 * - Validators: PASS / WARN / FAIL
 * - Executors:  COMPLETE / PARTIAL / FAILED
 * - Workflows:  SHIP / HOLD / BLOCK
 * - Phases:     passed / warned / blocked / skipped / aborted
 *
 * This helper maps any decision string to a category so that pipeline-level
 * counting and classification use the same logic. New decision values MUST
 * be registered here — see docs/adr/adr-001-decision-vocabulary.md.
 */

export type DecisionCategory = 'positive' | 'negative' | 'conditional' | 'neutral';

export function classifyDecision(decision: string | undefined): DecisionCategory {
  if (!decision) return 'neutral';
  switch (decision) {
    case 'PASS': case 'SHIP': case 'COMPLETE': return 'positive';
    case 'FAIL': case 'FAILED': case 'BLOCK': case 'PARTIAL': return 'negative';
    case 'WARN': case 'HOLD': return 'conditional';
    default: return 'neutral';
  }
}
