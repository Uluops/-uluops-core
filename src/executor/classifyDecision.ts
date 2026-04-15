/**
 * Canonical decision register normalization.
 *
 * The system uses four decision vocabularies across its execution layers:
 * - Validators: PASS / WARN / FAIL
 * - Executors:  COMPLETE / PARTIAL / FAILED
 * - Workflows:  SHIP / HOLD / BLOCK
 * - Phases:     passed / warned / blocked / skipped / aborted
 *
 * Additionally, cognitive lens agents (analysts, forecasters, explorers) define
 * custom vocabularies in their ADL definitions (e.g. HARMONIOUS/DISORDERED,
 * CLEAR/BEWITCHED). These are resolved dynamically from the definition's
 * `decisions.vocabulary` or `completion.vocabulary` fields via `DecisionVocabularyMap`.
 *
 * Priority: pre-resolved category > vocabulary map > hardcoded core vocabularies > neutral.
 */

export type DecisionCategory = 'positive' | 'negative' | 'conditional' | 'neutral';

/**
 * Maps decision strings to categories. Built from agent definition vocabularies
 * so that custom decision values (HARMONIOUS, BEWITCHED, etc.) are classified
 * without hardcoding every agent's vocabulary into this module.
 */
export type DecisionVocabularyMap = ReadonlyMap<string, DecisionCategory>;

/**
 * Classify a decision string into a canonical category.
 *
 * @param decision - The raw decision string from an agent result
 * @param vocabularyMap - Optional map built from the agent definition's vocabulary.
 *   When provided, checked before the hardcoded core vocabularies.
 */
export function classifyDecision(
  decision: string | undefined,
  vocabularyMap?: DecisionVocabularyMap,
): DecisionCategory {
  if (!decision) return 'neutral';

  // Dynamic vocabulary from agent definition takes precedence
  if (vocabularyMap) {
    const mapped = vocabularyMap.get(decision);
    if (mapped) return mapped;
  }

  // Core execution layer vocabularies (hardcoded — these are stable)
  switch (decision) {
    case 'PASS': case 'SHIP': case 'COMPLETE': return 'positive';
    case 'FAIL': case 'FAILED': case 'BLOCK': case 'PARTIAL': return 'negative';
    case 'WARN': case 'HOLD': return 'conditional';
    default: return 'neutral';
  }
}

/**
 * Build a DecisionVocabularyMap from an agent definition's vocabulary fields.
 * Handles both validator (decisions.vocabulary) and executor (completion.vocabulary) shapes.
 */
export function buildVocabularyMap(definition: {
  decisions?: { vocabulary?: { positive?: string; negative?: string; conditional?: string | null } };
  completion?: { vocabulary?: { complete?: string; partial?: string; failed?: string } };
}): DecisionVocabularyMap | undefined {
  const map = new Map<string, DecisionCategory>();

  // Validator vocabulary: positive/negative/conditional
  const dv = definition.decisions?.vocabulary;
  if (dv) {
    if (dv.positive) map.set(dv.positive, 'positive');
    if (dv.negative) map.set(dv.negative, 'negative');
    if (dv.conditional) map.set(dv.conditional, 'conditional');
  }

  // Executor vocabulary: complete/partial/failed
  const cv = definition.completion?.vocabulary;
  if (cv) {
    if (cv.complete) map.set(cv.complete, 'positive');
    if (cv.failed) map.set(cv.failed, 'negative');
    if (cv.partial) map.set(cv.partial, 'negative');
  }

  return map.size > 0 ? map : undefined;
}
