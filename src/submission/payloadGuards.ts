import { AnalysisSummaryEntrySchema } from '@uluops/ops-sdk';
import type { AnalysisSummaryInput, AnalysisRecordInput } from '@uluops/ops-sdk';

/**
 * Guards that keep one agent's analysis from costing a whole run's save (submission-analysis-
 * fidelity spec v0.2.1, D4, D5, D7). Each one changes the payload by the least it can, counts what
 * it changed, and leaves the warning text to the caller (SubmissionClient), which owns the logger.
 */

/** Same cap as the ops-sdk and API schemas (`recordId: z.string().max(100)`). */
const RECORD_ID_MAX_LENGTH = 100;

/** Under the API's `express.json({ limit: '2mb' })` (ops-uluops-api src/index.ts:72), with margin for headers and rounding. */
export const MAX_PAYLOAD_BYTES = Math.floor(1.9 * 1024 * 1024);

// ─── D4: per-summary isolation ─────────────────────────────────────────────

/**
 * Validate each summary on its own against ops-sdk's `AnalysisSummaryEntrySchema`, the schema
 * that otherwise throws for the WHOLE payload client-side. A summary that fails is removed; its
 * agent's row and records are kept. Runs after apiOnlyBounds repair, so it catches only what repair
 * cannot fix. The returned position is a schema path (`categoryScores[3].name`), never a value.
 */
export function isolateSummaries(summaries: AnalysisSummaryInput[]): {
  valid: AnalysisSummaryInput[];
  invalid: Array<{ agentName: string; position: string }>;
} {
  const valid: AnalysisSummaryInput[] = [];
  const invalid: Array<{ agentName: string; position: string }> = [];
  for (const summary of summaries) {
    const parsed = AnalysisSummaryEntrySchema.safeParse(summary);
    if (parsed.success) {
      valid.push(summary);
    } else {
      invalid.push({
        agentName: typeof summary.agentName === 'string' ? summary.agentName : 'unknown',
        position: schemaPosition(parsed.error.issues[0]?.path ?? []),
      });
    }
  }
  return { valid, invalid };
}

/**
 * A zod issue path as a schema position: array indices in brackets, and only the first two named
 * segments, so a model-authored key inside a free-form record (systemMetrics.<key>) is never echoed.
 */
function schemaPosition(path: readonly PropertyKey[]): string {
  let out = '';
  let named = 0;
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      if (named >= 2) { out += '…'; break; }
      out += (out ? '.' : '') + String(seg).replace(/[^A-Za-z0-9_]/g, '');
      named++;
    }
  }
  return out || '(root)';
}

// ─── D5: record key guard ──────────────────────────────────────────────────

/**
 * The server's duplicate key for a record: `foldAnalysisKey(agentName) + ' ' + foldAnalysisKey(recordId)`
 * (ops-uluops-api src/services/run/analysis-write.ts:65-66, 165-170), plus `trim()`. The server's
 * fold is NFD, strip combining marks, lowercase; adding trim() can only make this guard find MORE
 * collisions than the server does, which costs an unneeded suffix and never a rejected update.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function key(agentName: string | undefined, recordId: string): string {
  return `${fold(agentName ?? '')} ${fold(recordId)}`;
}

/**
 * Make every (agent, recordId) key unique before the payload leaves core. Pass 1 reserves the key
 * of every FIRST occurrence; pass 2 gives each later duplicate the lowest `~n` free against that
 * reserved set and the suffixes already assigned. So `x, x, x~2` becomes `x, x~3, x~2`: an agent's
 * own `x~2` keeps its id. The base is cut to fit before the free-check, so the check covers the id
 * actually sent. Input order is the walk order, so the result is deterministic for a given run.
 * Returns the guarded records and the per-agent count of renamed records.
 */
export function guardRecordKeys(records: AnalysisRecordInput[]): {
  records: AnalysisRecordInput[];
  renamedByAgent: Map<string, number>;
} {
  const used = new Set<string>();
  const firstIndex = new Map<string, number>();
  records.forEach((r, i) => {
    const k = key(r.agentName, r.recordId);
    if (!firstIndex.has(k)) {
      firstIndex.set(k, i);
      used.add(k);
    }
  });

  const renamedByAgent = new Map<string, number>();
  const out = records.map((r, i) => {
    const k = key(r.agentName, r.recordId);
    if (firstIndex.get(k) === i) return r;
    for (let n = 2; ; n++) {
      const suffix = `~${n}`;
      const base = r.recordId.length + suffix.length > RECORD_ID_MAX_LENGTH
        ? r.recordId.slice(0, RECORD_ID_MAX_LENGTH - suffix.length)
        : r.recordId;
      const candidate = base + suffix;
      const ck = key(r.agentName, candidate);
      if (!used.has(ck)) {
        used.add(ck);
        const agent = r.agentName ?? 'unknown';
        renamedByAgent.set(agent, (renamedByAgent.get(agent) ?? 0) + 1);
        return { ...r, recordId: candidate };
      }
    }
  });
  return { records: out, renamedByAgent };
}

// ─── D7: byte guard ────────────────────────────────────────────────────────

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Keep the serialized payload under {@link MAX_PAYLOAD_BYTES}. Each summary and record is bounded
 * on its own, but they add up: 20 summaries with two 64 KiB blobs each is about 2.5 MiB, and 100
 * records with 64 KiB of data reach 6.25 MiB, against the API's 2 MB body limit, past which it
 * answers 413 for the whole save. Over the limit, summaries are dropped from the tail, then records
 * from the tail, until it fits. Mutates `input` in place; returns how many of each were dropped.
 */
export function enforcePayloadBudget(input: {
  analysisSummary?: AnalysisSummaryInput | AnalysisSummaryInput[];
  analysisRecords?: AnalysisRecordInput[];
}): { droppedSummaries: number; droppedRecords: number; bytes: number } {
  let bytes = byteLength(input);
  let droppedSummaries = 0;
  let droppedRecords = 0;

  while (bytes > MAX_PAYLOAD_BYTES) {
    const summary = input.analysisSummary;
    if (Array.isArray(summary) && summary.length > 0) {
      const last = summary.pop()!;
      bytes -= byteLength(last) + 1;
      droppedSummaries++;
      if (summary.length === 0) input.analysisSummary = undefined;
    } else if (summary && !Array.isArray(summary)) {
      bytes -= byteLength(summary);
      input.analysisSummary = undefined;
      droppedSummaries++;
    } else if (input.analysisRecords && input.analysisRecords.length > 0) {
      const last = input.analysisRecords.pop()!;
      bytes -= byteLength(last) + 1;
      droppedRecords++;
      if (input.analysisRecords.length === 0) input.analysisRecords = undefined;
    } else {
      break;
    }
  }
  return { droppedSummaries, droppedRecords, bytes };
}
