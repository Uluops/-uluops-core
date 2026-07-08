/**
 * Pipeline stage output forwarding — slice + render helpers.
 * (stage-output-forwarding-spec v0.3.1, §3.1–§3.4)
 *
 * `buildUpstreamContext` (PipelineExecutor side) filters a stage's
 * `depends_on` results through the producer/consumer opt-outs and produces
 * structural `UpstreamStageContext` slices. `renderUpstreamSection`
 * (AgentExecutor side) renders them as the `## Upstream Analysis` section of
 * the initial message and enforces the character caps.
 *
 * Both are pure (module-level env read for the kill switch aside) so the
 * slicing policy is unit-testable without executing agents.
 */
import type { StageDefinition, StageResult } from '../types/pipeline.js';
import type { UpstreamStageContext } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';

/**
 * Character caps (spec §3.3). PROVISIONAL defaults pending the Phase 1V
 * calibration step — character-based because core has no token estimator
 * (~4 chars/token heuristic). Exported so tests and future per-pipeline
 * overrides reference one source of truth.
 */
export const UPSTREAM_STAGE_SLICE_CAP = 8_000;
/** Per-stage cap when the producer declared `forward: full`. */
export const UPSTREAM_STAGE_FULL_CAP = 24_000;
/** Head+tail retention split for `forward: full` rawOutput (spec §3.3):
 *  reports put verdict/summary at the top and conclusions at the bottom —
 *  middle detail is the safest loss. */
export const UPSTREAM_FULL_HEAD_CHARS = 16_000;
export const UPSTREAM_FULL_TAIL_CHARS = 8_000;
/** Total `## Upstream Analysis` section cap. */
export const UPSTREAM_TOTAL_CAP = 32_000;
/** Max recommendations forwarded per upstream agent result. */
export const UPSTREAM_MAX_RECOMMENDATIONS = 5;
/** Summary fallback length when the agent emitted no `summary`. */
export const UPSTREAM_SUMMARY_FALLBACK_CHARS = 500;
/** absentReason cap for failed-stage error messages (spec §3.1). */
export const UPSTREAM_ABSENT_REASON_CAP = 200;

/** Global kill switch — fleet-wide off for the forwarding behavior change. */
export const UPSTREAM_KILL_SWITCH_ENV = 'ULUOPS_DISABLE_STAGE_FORWARDING';

/** Severity rank for the slice sort. The engine's flattenRecommendations is
 *  category-declaration-ordered, NOT ranked (run #31 A2/F2) — sorting here is
 *  what keeps a critical finding in a late rubric category inside the top-5. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
const UNKNOWN_SEVERITY_RANK = 5;

function severityRank(severity?: string): number {
  return severity != null ? (SEVERITY_RANK[severity] ?? UNKNOWN_SEVERITY_RANK) : UNKNOWN_SEVERITY_RANK;
}

export function isForwardingDisabled(): boolean {
  const v = process.env[UPSTREAM_KILL_SWITCH_ENV];
  return v === '1' || v === 'true';
}

/**
 * Build the upstream context for a stage from its dependencies' results.
 *
 * - Direct `depends_on` only — one hop, no transitive closure (spec §3.1).
 * - Producer `forward: none` and consumer `receives: none` suppress.
 * - Steps-only upstream stages are skipped silently (their signal flows
 *   through `condition:` expressions, the right channel for exit codes).
 * - A non-completed dependency yields a labeled-absence entry. Under the
 *   current all-deps-completed gate (`checkStageDependencies`) this branch is
 *   reachable only in partial multi-dependency topologies (spec §3.1 v0.3.1);
 *   it is kept as defensive coverage should the gate ever relax.
 * - Ref-based stages forward their structured CommandResult/WorkflowResult
 *   slice; `forward: full` degrades to 'auto' for them (no rawOutput in the
 *   wrap).
 */
export function buildUpstreamContext(
  stage: StageDefinition,
  allStages: StageDefinition[],
  priorResults: StageResult[],
  log?: (msg: string) => void,
): UpstreamStageContext[] {
  if (isForwardingDisabled()) return [];
  if (stage.receives === 'none') return [];
  const deps = stage.depends_on ?? [];
  if (deps.length === 0) return [];

  const entries: UpstreamStageContext[] = [];
  for (const dep of deps) {
    const depDef = allStages.find((s) => s.id === dep);
    const mode = depDef?.forward ?? 'auto';
    if (mode === 'none') continue;

    const result = priorResults.find((r) => r.id === dep);
    if (!result) continue; // not yet run — the dependency gate normally prevents this

    if (result.status !== 'completed') {
      entries.push({
        stageId: dep,
        absent: true,
        absentReason:
          result.status === 'skipped'
            ? (result.skipReason ?? 'stage skipped')
            : (result.skipReason ?? 'stage failed').slice(0, UPSTREAM_ABSENT_REASON_CAP),
      });
      continue;
    }

    if (result.agentResults && result.agentResults.length > 0) {
      for (const ar of result.agentResults) {
        entries.push(sliceAgentResult(dep, ar, mode));
      }
      continue;
    }

    if (result.steps && result.steps.length > 0 && !result.result?.score && !result.result?.recommendations?.length) {
      // Steps-only stage — nothing forwardable; condition expressions are the channel.
      continue;
    }

    if (result.result) {
      if (mode === 'full') {
        log?.(`forward: full on ref stage "${dep}" degrades to auto — CommandResult/WorkflowResult carries no rawOutput`);
      }
      const r = result.result;
      entries.push({
        stageId: dep,
        refLabel: `${result.type}: ${r.name}@${r.version}`,
        decision: r.decision,
        decisionCategory: r.decisionCategory,
        score: r.score ?? null,
        // Discriminant narrowing: only CommandResult carries maxScore (run #57).
        maxScore: r.type === 'command' ? (r.maxScore ?? null) : null,
        recommendations: sliceRecommendations(r.recommendations ?? []),
      });
    }
  }
  return entries;
}

function sliceAgentResult(stageId: string, ar: AgentResult, mode: 'auto' | 'full'): UpstreamStageContext {
  const entry: UpstreamStageContext = {
    stageId,
    agentName: ar.name,
    decision: ar.decision,
    decisionCategory: ar.decisionCategory,
    score: ar.score ?? null,
    maxScore: ar.maxScore ?? null,
    summary: ar.summary ?? (ar.rawOutput ? ar.rawOutput.slice(0, UPSTREAM_SUMMARY_FALLBACK_CHARS) : undefined),
    recommendations: sliceRecommendations(ar.recommendations ?? []),
  };
  if (mode === 'full' && ar.rawOutput) {
    entry.fullText = headTailRetain(ar.rawOutput, UPSTREAM_FULL_HEAD_CHARS, UPSTREAM_FULL_TAIL_CHARS);
  }
  return entry;
}

function sliceRecommendations(
  recs: Array<{ severity?: string; title: string; filePath?: string; lineNumber?: number | null }>,
): UpstreamStageContext['recommendations'] {
  // Stable sort (V8 guarantees stability): severity tier first, original order within.
  return [...recs]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, UPSTREAM_MAX_RECOMMENDATIONS)
    .map((r) => ({ severity: r.severity, title: r.title, filePath: r.filePath, lineNumber: r.lineNumber }));
}

/** Head+tail retention: keep the opening and the conclusions; elide the middle. */
export function headTailRetain(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text;
  const elided = text.length - headChars - tailChars;
  return (
    text.slice(0, headChars) +
    `\n[… elided ${elided} of ${text.length} chars — head+tail retention …]\n` +
    text.slice(text.length - tailChars)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering (AgentExecutor side)
// ─────────────────────────────────────────────────────────────────────────────

interface RenderedEntry {
  header: string; // never dropped (spec §3.3 floor)
  narrative?: string;
  findings: string[];
  fullText?: string;
  readonly entry: UpstreamStageContext;
  /** Truncation bookkeeping — lives here, NOT on the input entry (the context
   *  object may be shared across parallel agents and must stay immutable). */
  truncated?: boolean;
  originalLen?: number;
}

/**
 * Render the `## Upstream Analysis` section, enforcing the per-stage and
 * total caps with the spec §3.3 three-step tie-break:
 *   1. drop findings from the bottom of the severity-sorted list
 *   2. drop narrative lines (largest first)
 *   3. header-only floor — headers/verdicts are never dropped; if they alone
 *      exceed the total cap, the section opens with an overflow marker.
 * Returns '' for an empty context (no section at all — spec §5.4).
 */
export function renderUpstreamSection(context: UpstreamStageContext[] | undefined): string {
  if (!context || context.length === 0) return '';

  const rendered: RenderedEntry[] = context.map((e) => renderEntry(e));

  // Per-stage cap: fullText overage first, then the shared tie-break steps.
  for (const r of rendered) {
    const cap = r.entry.fullText ? UPSTREAM_STAGE_FULL_CAP : UPSTREAM_STAGE_SLICE_CAP;
    capEntry(r, cap);
  }

  // Total cap, three-step tie-break across entries.
  let guard = 100_000;
  while (totalLength(rendered) > UPSTREAM_TOTAL_CAP && guard-- > 0) {
    // Step 0: shrink the largest remaining fullText block.
    const withFull = rendered.filter((r) => r.fullText && r.fullText.length > 0);
    if (withFull.length > 0) {
      const largest = withFull.reduce((a, b) => ((a.fullText?.length ?? 0) >= (b.fullText?.length ?? 0) ? a : b));
      shrinkFullText(largest, Math.floor((largest.fullText?.length ?? 0) / 2));
      continue;
    }
    // Step 1: drop one finding from the entry with the most findings.
    const withFindings = rendered.filter((r) => r.findings.length > 0);
    if (withFindings.length > 0) {
      const most = withFindings.reduce((a, b) => (a.findings.length >= b.findings.length ? a : b));
      most.findings.pop();
      markTruncated(most);
      continue;
    }
    // Step 2: drop the largest narrative.
    const withNarrative = rendered.filter((r) => r.narrative);
    if (withNarrative.length > 0) {
      const largest = withNarrative.reduce((a, b) => ((a.narrative?.length ?? 0) >= (b.narrative?.length ?? 0) ? a : b));
      largest.narrative = undefined;
      markTruncated(largest);
      continue;
    }
    // Step 3: header-only floor — nothing left to drop.
    break;
  }

  const parts: string[] = ['## Upstream Analysis'];
  parts.push(
    'Results from pipeline stages this stage depends on. Weigh them as input;',
    'verify against the codebase where they make load-bearing claims.',
    '',
  );
  if (totalLength(rendered) > UPSTREAM_TOTAL_CAP) {
    parts.unshift(`[upstream context at header-only floor — ${rendered.length} stages, caps exceeded by headers]`);
  }
  for (const r of rendered) {
    parts.push(r.header);
    if (r.narrative) parts.push(`Summary: ${r.narrative}`);
    if (r.findings.length > 0) {
      parts.push('Top recommendations:');
      parts.push(...r.findings);
    }
    if (r.fullText) {
      parts.push('Full output:');
      parts.push(r.fullText);
    }
    if (r.truncated) parts.push(`[upstream context truncated — kept ${entryLength(r)} of ${r.originalLen ?? '?'} chars]`);
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

function renderEntry(e: UpstreamStageContext): RenderedEntry {
  if (e.absent) {
    return {
      header: `### ${e.stageId} — no output (${e.absentReason ?? 'absent'})`,
      findings: [],
      entry: e,
    };
  }
  const who = e.agentName ? `${e.stageId} / ${e.agentName}` : `${e.stageId} (${e.refLabel ?? 'ref'})`;
  const score = e.score != null ? `${e.score}${e.maxScore != null ? `/${e.maxScore}` : ''}` : 'no score';
  const category = e.decisionCategory ?? 'unclassified';
  return {
    header: `### ${who} — ${e.decision ?? 'no decision'} (${score}, category: ${category})`,
    narrative: e.summary,
    findings: (e.recommendations ?? []).map(
      (r) =>
        `- [${r.severity ?? 'unspecified'}] ${r.title}${r.filePath ? ` (${r.filePath}${r.lineNumber != null ? `:${r.lineNumber}` : ''})` : ''}`,
    ),
    fullText: e.fullText,
    entry: e,
  };
}

function entryLength(r: RenderedEntry): number {
  // Label overheads: 9 = 'Summary: ', 21 = 'Top recommendations:\n',
  // 13 = 'Full output:\n'. Keeping these in the accounting means the caps
  // bound the RENDERED size, not just the content (run #57 SEM-COM/L).
  return (
    r.header.length +
    (r.narrative ? r.narrative.length + 9 : 0) +
    (r.findings.length > 0 ? 21 : 0) +
    r.findings.reduce((s, f) => s + f.length + 1, 0) +
    (r.fullText ? r.fullText.length + 13 : 0)
  );
}

function totalLength(rendered: RenderedEntry[]): number {
  return rendered.reduce((s, r) => s + entryLength(r) + 1, 0);
}

function capEntry(r: RenderedEntry, cap: number): void {
  const original = entryLength(r);
  if (original <= cap) return;
  // fullText absorbs the overage first (it is the bulk when present).
  if (r.fullText) {
    const overhead = entryLength(r) - r.fullText.length;
    const budget = Math.max(0, cap - overhead);
    shrinkFullText(r, budget);
  }
  while (entryLength(r) > cap && r.findings.length > 0) r.findings.pop();
  if (entryLength(r) > cap && r.narrative) {
    const overhead = entryLength(r) - r.narrative.length;
    const budget = Math.max(0, cap - overhead);
    r.narrative = budget > 20 ? r.narrative.slice(0, budget) : undefined;
  }
  markTruncated(r, original);
}

function shrinkFullText(r: RenderedEntry, budget: number): void {
  if (!r.fullText) return;
  const original = r.originalLen ?? entryLength(r);
  if (budget < 200) {
    r.fullText = undefined;
  } else {
    const head = Math.floor(budget * (UPSTREAM_FULL_HEAD_CHARS / (UPSTREAM_FULL_HEAD_CHARS + UPSTREAM_FULL_TAIL_CHARS)));
    const tail = budget - head;
    // +100 = headroom for the elision marker headTailRetain inserts.
    r.fullText = headTailRetain(r.fullText, head, tail).slice(0, budget + 100);
  }
  markTruncated(r, original);
}

function markTruncated(r: RenderedEntry, original?: number): void {
  r.truncated = true;
  r.originalLen = r.originalLen ?? original ?? undefined;
}
