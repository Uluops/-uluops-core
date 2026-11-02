import type { AnalysisSummaryInput, AnalysisRecordInput } from '@uluops/ops-sdk';

/**
 * Limits the tracker API enforces on analysis data that ops-sdk's client-side schema does NOT
 * (submission-analysis-fidelity spec v0.2.1, §1.7 and D6). ops-sdk passes each of these, and the
 * API then answers 400 for the whole save: the run, every agent and every recommendation. Core
 * repairs them here, before submission, keeping the data rather than dropping it.
 *
 * Read from ops-uluops-api at commit e5532bc2 (2026-11-01):
 *   - categoryScores weight int >= 1, score int >= 0 ... src/controllers/run-transformers.ts:151-155
 *   - explorationMaps <= 20 .............................. src/controllers/run-transformers.ts:167
 *   - sections per map <= 50, items are objects ......... src/business-objects/analysis-summary.ts:21-63, 85
 *   - systemMetrics / epistemicAssessment / record data,
 *     <= 64 KiB serialized and <= 8 levels deep ........ src/controllers/run-transformers.ts:21-49, 132, 163, 165
 * and ops-sdk's per-implication cap of 500 characters (stricter than the API's 2000), repaired here
 * by truncation rather than by dropping the summary.
 *
 * This is a client copy of server limits: it does not track changes to them. When ops-api changes
 * any of the above, this file must change in the same release, or the whole-save failure returns.
 * The durable fix is server-side per-entry acceptance (spec §8).
 */
export const API_ONLY_BOUNDS = {
  maxExplorationMaps: 20,
  maxSectionsPerMap: 50,
  maxBlobBytes: 64 * 1024,
  maxBlobDepth: 8,
  maxCategoryWeight: 100,
  maxAuditImplicationChars: 500,
} as const;

const SECTION_ITEM_FIELDS = ['items', 'entities', 'relationships', 'clusters', 'findings', 'hierarchy', 'translations', 'patterns', 'archetypes', 'blindSpots', 'questions'] as const;

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > API_ONLY_BOUNDS.maxBlobDepth) return depth;
  if (value === null || typeof value !== 'object') return depth;
  let max = depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    max = Math.max(max, jsonDepth(child, depth + 1));
    if (max > API_ONLY_BOUNDS.maxBlobDepth) return max;
  }
  return max;
}

/** True when a blob is over the API's 64 KiB / depth-8 bound. A value that cannot serialize counts as over. */
export function blobExceedsBound(value: unknown): boolean {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return true;
  }
  return bytes > API_ONLY_BOUNDS.maxBlobBytes || jsonDepth(value) > API_ONLY_BOUNDS.maxBlobDepth;
}

/**
 * Repair one summary to the API-only bounds. Returns the repaired summary and a list of what was
 * repaired (field positions, never values or model-authored keys), for the caller's one warning.
 */
export function repairSummary(summary: AnalysisSummaryInput): { summary: AnalysisSummaryInput; repairs: string[] } {
  const repairs: string[] = [];
  const out: AnalysisSummaryInput = { ...summary };

  if (Array.isArray(out.categoryScores)) {
    const n = out.categoryScores.length;
    const equalShare = n > 0 ? Math.max(1, Math.round(100 / n)) : 1;
    const repaired: NonNullable<AnalysisSummaryInput['categoryScores']> = [];
    out.categoryScores.forEach((cat, i) => {
      const rawScore: unknown = cat?.score;
      const rawWeight: unknown = cat?.weight;
      if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
        repairs.push(`categoryScores[${i}] dropped (score not a finite number)`);
        return;
      }
      const score = Math.max(0, Math.round(rawScore));
      const weight = typeof rawWeight === 'number' && Number.isFinite(rawWeight)
        ? Math.min(API_ONLY_BOUNDS.maxCategoryWeight, Math.max(1, Math.round(rawWeight)))
        : equalShare;
      if (score !== rawScore || weight !== rawWeight) repairs.push(`categoryScores[${i}] rounded to integers`);
      repaired.push({ ...cat, score, weight });
    });
    out.categoryScores = repaired;
  }

  if (Array.isArray(out.explorationMaps)) {
    let maps = out.explorationMaps;
    if (maps.length > API_ONLY_BOUNDS.maxExplorationMaps) {
      repairs.push(`explorationMaps capped ${maps.length}→${API_ONLY_BOUNDS.maxExplorationMaps}`);
      maps = maps.slice(0, API_ONLY_BOUNDS.maxExplorationMaps);
    }
    out.explorationMaps = maps.map((map, m) => {
      let sections = Array.isArray(map.sections) ? map.sections : [];
      if (sections.length > API_ONLY_BOUNDS.maxSectionsPerMap) {
        repairs.push(`explorationMaps[${m}].sections capped ${sections.length}→${API_ONLY_BOUNDS.maxSectionsPerMap}`);
        sections = sections.slice(0, API_ONLY_BOUNDS.maxSectionsPerMap);
      }
      sections = sections.map((section, s) => {
        const copy = { ...section } as Record<string, unknown>;
        for (const field of SECTION_ITEM_FIELDS) {
          const items = copy[field];
          if (!Array.isArray(items)) continue;
          const objects = items.filter(item => !!item && typeof item === 'object' && !Array.isArray(item));
          if (objects.length !== items.length) {
            repairs.push(`explorationMaps[${m}].sections[${s}].${field}: ${items.length - objects.length} non-object item(s) dropped`);
            copy[field] = objects;
          }
        }
        return copy as unknown as typeof section;
      });
      return { ...map, sections };
    });
  }

  if (Array.isArray(out.auditImplications)) {
    out.auditImplications = out.auditImplications.map((text, i) => {
      if (typeof text === 'string' && text.length > API_ONLY_BOUNDS.maxAuditImplicationChars) {
        repairs.push(`auditImplications[${i}] truncated ${text.length}→${API_ONLY_BOUNDS.maxAuditImplicationChars} chars`);
        return `${text.slice(0, API_ONLY_BOUNDS.maxAuditImplicationChars - 1)}…`;
      }
      return text;
    });
  }

  for (const field of ['systemMetrics', 'epistemicAssessment'] as const) {
    const blob = out[field];
    if (blob != null && blobExceedsBound(blob)) {
      repairs.push(`${field} dropped (over ${API_ONLY_BOUNDS.maxBlobBytes / 1024} KiB or ${API_ONLY_BOUNDS.maxBlobDepth} levels deep)`);
      out[field] = null;
    }
  }

  return { summary: out, repairs };
}

/** Repair one record's `data` to the API's blob bound: over it, the data becomes a stub. */
export function repairRecord(record: AnalysisRecordInput): { record: AnalysisRecordInput; repaired: boolean } {
  if (record.data == null || !blobExceedsBound(record.data)) return { record, repaired: false };
  return {
    record: { ...record, data: { omitted: `exceeds ${API_ONLY_BOUNDS.maxBlobBytes / 1024} KiB or ${API_ONLY_BOUNDS.maxBlobDepth} levels of nesting` } },
    repaired: true,
  };
}
