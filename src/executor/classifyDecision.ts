/**
 * Canonical decision register normalization.
 *
 * The system uses five decision vocabularies across its execution layers:
 * - Validators: PASS / WARN / FAIL
 * - Executors:  COMPLETE / PARTIAL / FAILED
 * - Explorers:  EXPLORED (always positive — discovery, not gating)
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
 * @returns The canonical category: `'positive'`, `'negative'`, `'conditional'`, or `'neutral'`.
 * @example
 * ```typescript
 * classifyDecision('PASS');        // 'positive'
 * classifyDecision('FAIL');        // 'negative'
 * classifyDecision('WARN');        // 'conditional'
 *
 * // Custom agent vocabulary:
 * const vocab = buildVocabularyMap(agentDefinition);
 * classifyDecision('BEWITCHED', vocab); // 'negative'
 * ```
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
  // PARTIAL is 'conditional' (not negative) — partial completion is progress,
  // not failure. Downstream consumers can gate on decisionCategory if needed.
  switch (decision) {
    case 'PASS': case 'SHIP': case 'COMPLETE': case 'EXPLORED': return 'positive';
    case 'FAIL': case 'FAILED': case 'BLOCK': return 'negative';
    case 'WARN': case 'HOLD': case 'PARTIAL': return 'conditional';
    default: return 'neutral';
  }
}

/**
 * Build a DecisionVocabularyMap from an agent definition's vocabulary fields.
 * Handles both validator (decisions.vocabulary) and executor (completion.vocabulary) shapes.
 *
 * @param definition - Partial agent definition carrying either (or both) vocabulary
 *   sections. Validator terms map positive/negative/conditional; executor terms map
 *   complete→positive, failed→negative, partial→conditional.
 * @returns A {@link DecisionVocabularyMap} from decision string to category, or
 *   `undefined` if neither section is present or populated. Pass it as the second
 *   argument to {@link classifyDecision}.
 * @example
 * ```typescript
 * const vocab = buildVocabularyMap(agentDefinition.agent);
 * classifyDecision('HARMONIOUS', vocab); // resolves via the agent's custom vocabulary
 * ```
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
    if (cv.partial) map.set(cv.partial, 'conditional');
  }

  return map.size > 0 ? map : undefined;
}
