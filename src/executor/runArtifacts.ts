/**
 * Run-artifact facts about an agent instance (effectiveness-analytics spec §4.2; checklist P3-5).
 * Kept apart from AgentExecutor so SubmissionClient can read them without loading the executor's
 * AI-provider dependencies.
 */
import type { AgentType } from '../types/execution.js';
import type { ResolvedDefinition } from '../types/registry.js';

/** Archetypes whose instances are `stageRole: 'review'` (D58): they judge a target rather than change or make one. */
export const REVIEW_ARCHETYPES: ReadonlySet<AgentType> = new Set<AgentType>(['validator', 'analyst', 'explorer', 'forecaster']);

/**
 * A definition's own pass threshold (D55): the lowest `min_score` of its `decisions.thresholds`
 * positive bands, when one is declared and lies in [0, 100]. Rounded to two decimals, because the
 * tracker stores DECIMAL(5,2) and refuses a third decimal with a 400 that would abort the whole save.
 */
export function definitionPassThreshold(resolved: ResolvedDefinition): number | undefined {
  if (resolved.type !== 'agent') return undefined;
  const bands = resolved.definition.agent?.decisions?.thresholds ?? [];
  const mins = bands.filter((b) => b.decision === 'positive' && typeof b.min_score === 'number' && Number.isFinite(b.min_score)).map((b) => b.min_score as number);
  if (mins.length === 0) return undefined;
  const t = Math.min(...mins);
  return t >= 0 && t <= 100 ? Math.round(t * 100) / 100 : undefined;
}
