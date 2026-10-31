/**
 * The pre-launch vocabulary check (PDL 1.6.0, build unit P4a; D9, D33).
 *
 * Normative source: `uluops-pdl-spec-v1.6.0.md`, Execution Semantics → Gates → Pre-launch vocabulary
 * check. Before any stage launches, every agent listed in a blocking-gated stage must be able to
 * have its decision classified: it declares a vocabulary (`decisions.vocabulary`, or
 * `completion.vocabulary` for an executor), or it is an explorer, whose only token, EXPLORED, is in
 * the core register. Otherwise the run is refused with `VOCABULARY_MISSING`, naming the agents.
 *
 * Without this, an agent whose verdict word no vocabulary declares reads neutral at every run, so a
 * gate meant to block on its decision decides on the score alone, and nothing says so before money
 * is spent. Core enforces it from the release that carries P4a: it reads the resolved ADL, which no
 * corpus regeneration changes (spec S1). The skill ships it disabled until P6b.
 *
 * **Presence only.** The check does not test that an agent can emit the negative it declares, and
 * does not detect a target repo's agent file shadowing an installed one (spec §5).
 *
 * **Scope.** Inline `agents` of stages whose gate is blocking (`abort`, `fail`, `skip`, or no
 * `on_failure`). A stage with no gate, or a `warn` gate, is not checked; neither are workflow and
 * command refs, which classify through their own definition's decision. An agent that cannot be
 * resolved here is not checked: resolution fails again at dispatch, where the stage records it.
 */

import type { ResolvedDefinition } from '../types/registry.js';
import type { StageDefinition } from '../types/pipeline.js';
import { gateMode, isBlocking } from './stageGate.js';

/** Whether a resolved agent declares a decision vocabulary or is an explorer. */
export function classifiesItsDecisions(resolved: ResolvedDefinition): boolean {
  if (resolved.agentType === 'explorer') return true;
  const body = resolved.type === 'agent' ? (resolved.definition.agent as Record<string, unknown> | undefined) : undefined;
  if ((body?.['interface'] as { agentType?: unknown } | undefined)?.agentType === 'explorer') return true;
  const terms = (v: unknown) =>
    v && typeof v === 'object' ? Object.values(v as Record<string, unknown>).some(t => typeof t === 'string' && t.trim() !== '') : false;
  return terms((body?.['decisions'] as { vocabulary?: unknown } | undefined)?.vocabulary)
    || terms((body?.['completion'] as { vocabulary?: unknown } | undefined)?.vocabulary);
}

/** The inline agent refs of blocking-gated stages, each once, in pipeline order. */
export function blockingGatedAgentRefs(stages: readonly StageDefinition[]): string[] {
  const refs: string[] = [];
  for (const stage of stages) {
    // The gate's own definition of blocking, so a stage the gate judges as blocking is checked here
    // too: an `on_failure` outside the enum reads as `abort` there, and a separate set here let such
    // a stage escape the check (consumer-validate run #122, wittgenstein GI-2).
    if (!stage.gate || !isBlocking(gateMode(stage.gate))) continue;
    for (const a of stage.agents ?? []) if (typeof a?.ref === 'string' && !refs.includes(a.ref)) refs.push(a.ref);
  }
  return refs;
}

/**
 * The agents of blocking-gated stages that neither declare a vocabulary nor are explorers.
 * `resolve` returns the agent's definition, or throws (then the agent is not checked).
 */
export async function agentsMissingVocabulary(
  stages: readonly StageDefinition[],
  resolve: (ref: string) => Promise<ResolvedDefinition>,
  onUnresolved: (ref: string, error: unknown) => void,
): Promise<string[]> {
  const refs = blockingGatedAgentRefs(stages);
  const checked = await Promise.all(refs.map(async ref => {
    try {
      return classifiesItsDecisions(await resolve(ref)) ? undefined : ref;
    } catch (error) {
      onUnresolved(ref, error);
      return undefined;
    }
  }));
  return checked.filter((r): r is string => r !== undefined);
}

/** The refusal message (D33): what is missing, why it matters, and the fix for each case. */
export function vocabularyMissingMessage(agents: readonly string[]): string {
  return `Run refused (VOCABULARY_MISSING): ${agents.map(a => `"${a}"`).join(', ')} sit in a blocking-gated stage ` +
    `and neither declares a decision vocabulary nor is an explorer, so a gate could not classify their decisions ` +
    `and would decide on the score alone. For a corpus agent, regenerate and republish it so its definition ` +
    `carries agent.decisions.vocabulary (or agent.completion.vocabulary); for any other agent, add the vocabulary ` +
    `to its ADL and publish that version, or update the local YAML core resolves.`;
}
