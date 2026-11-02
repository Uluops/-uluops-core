import type { AgentDefinition, AgentResult } from '../types/agent.js';
import type { ResolvedDefinition } from '../types/registry.js';

/**
 * The two facts analysis extraction needs from an agent's definition (submission-analysis-fidelity
 * spec v0.2.1, D1). Everything else in an analysis summary and its records is read from the result
 * itself, so these two values are the whole of the definition's contribution.
 *
 * `null` means the definition declares none (a scoreless executor has no categories; an agent may
 * declare no decision vocabulary). That is different from a result that was never stamped, whose
 * fields are absent: the first is a correct, complete result and must not warn; the second came from
 * outside core's executors (hand-built, or serialized by core <= 0.56.2) and does.
 */
export interface DefinitionFacts {
  /** Declared decision tokens joined with '/' (positive/conditional/negative, or complete/partial/failed). */
  decisionVocabulary: string | null;
  /** Declared category weights by category name, finite numbers only. */
  categoryWeights: Record<string, number> | null;
}

/**
 * Compute {@link DefinitionFacts} from an agent definition. Exported so a caller that builds an
 * `AgentResult` by hand can stamp it the way core's executors do:
 * `{ ...result, ...definitionFacts(definition) }`.
 */
export function definitionFacts(definition: AgentDefinition | undefined): DefinitionFacts {
  const agent = definition?.agent;
  return {
    decisionVocabulary: vocabularyOf(agent),
    categoryWeights: weightsOf(agent),
  };
}

/** {@link definitionFacts} for a resolved definition; absent facts when it is not an agent. */
export function definitionFactsFromResolved(resolved: ResolvedDefinition | undefined): DefinitionFacts | undefined {
  if (!resolved || resolved.type !== 'agent') return undefined;
  const def = resolved.definition;
  if (!def || typeof def !== 'object' || !('agent' in def)) return undefined;
  return definitionFacts(def as AgentDefinition);
}

function vocabularyOf(agent: AgentDefinition['agent'] | undefined): string | null {
  if (!agent) return null;
  const decisions = agent.decisions?.vocabulary;
  if (decisions) {
    const parts = [decisions.positive, decisions.conditional, decisions.negative].filter(Boolean);
    return parts.length > 0 ? parts.join('/') : null;
  }
  const completion = agent.completion?.vocabulary;
  if (completion) {
    const parts = [completion.complete, completion.partial, completion.failed].filter(Boolean);
    return parts.length > 0 ? parts.join('/') : null;
  }
  return null;
}

function weightsOf(agent: AgentDefinition['agent'] | undefined): Record<string, number> | null {
  const categories = agent?.scoring?.categories;
  if (!Array.isArray(categories) || categories.length === 0) return null;
  const weights: Record<string, number> = {};
  for (const cat of categories) {
    if (cat && typeof cat.name === 'string' && typeof cat.weight === 'number' && Number.isFinite(cat.weight)) {
      weights[cat.name] = cat.weight;
    }
  }
  return Object.keys(weights).length > 0 ? weights : null;
}

/**
 * The facts carried on a result, validated (D2). A result can arrive from JSON or be built by hand,
 * so the stamp is untrusted: a vocabulary must be a string or null; weights must be a plain object,
 * read through own entries only (no prototype keys) and keeping finite numbers only. Anything else
 * reads as unstamped (`undefined`), never as a value.
 */
export function stampedFacts(result: Pick<AgentResult, 'decisionVocabulary' | 'categoryWeights'>): {
  decisionVocabulary: string | null | undefined;
  categoryWeights: Map<string, number> | null | undefined;
} {
  const rawVocab: unknown = result.decisionVocabulary;
  const decisionVocabulary = rawVocab === null || typeof rawVocab === 'string' ? rawVocab : undefined;

  const rawWeights: unknown = result.categoryWeights;
  let categoryWeights: Map<string, number> | null | undefined;
  if (rawWeights === null) {
    categoryWeights = null;
  } else if (rawWeights && typeof rawWeights === 'object' && !Array.isArray(rawWeights)
    && Object.getPrototypeOf(rawWeights) === Object.prototype) {
    categoryWeights = new Map();
    for (const [name, weight] of Object.entries(rawWeights as Record<string, unknown>)) {
      if (typeof weight === 'number' && Number.isFinite(weight)) categoryWeights.set(name, weight);
    }
  } else {
    categoryWeights = undefined;
  }
  return { decisionVocabulary, categoryWeights };
}
