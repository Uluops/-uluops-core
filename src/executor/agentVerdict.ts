/**
 * How core reads an agent's decision and score for gating (PDL 1.6.0, build unit P4a).
 *
 * Normative source: `uluops-pdl-spec-v1.6.0.md`, Execution Semantics → Gates → Reading the decision
 * and the score, The token rule, Classification, Neutral, absent and saved decisions. Design record:
 * pdl-1_6_0 spec §3.2 items 1-5 (D6, D16, D17, D18, D23, D24). The conformance fixtures'
 * `decisions/*` cases are the oracle.
 *
 * **One contract on agent output.** The decision is the string at `result.decision`, else the
 * top-level `decision` (in whichever JSON core extracted), else the value of the agent's
 * `Decision:` line. The score is `result.score`, else `score`, else the number on the `Score:`
 * line. Nothing else in the output gates. Core's `OutputNormalizer` searches seven containers, key
 * aliases, `status` and summary-word fallbacks, and sums breakdowns: those stay for display, and
 * when the contract finds nothing they are named in a warning (`FALLBACK_DECISION_SOURCE`,
 * `FALLBACK_SCORE_SOURCE`) so a value there is visible though it does not gate.
 *
 * **One token rule, one table.** A value is cut to 200 characters, leading non-letters are dropped,
 * and the token is the first run of letters, digits and underscores, upper-cased; it counts only if
 * what follows is the end, closing punctuation, or whitespace before a non-letter. Anything else
 * makes the value neutral, so the rule fails toward neutral, never toward the wrong class
 * (`NOT SECURE` is neutral, not SECURE). The token is classified through the agent's declared
 * vocabulary, then the core register, via sdk-core's `classifyDecision`; nothing else classifies.
 * `OutputNormalizer.normalizeDecision`'s synonyms (`REJECT` → FAIL, `OK` → PASS) no longer gate.
 *
 * Two readings the spec leaves open, chosen here and stated: when several lines carry `Decision:`
 * (or `Score:`), the FIRST is read, since a report states its verdict before its per-category
 * detail; and a non-string value at a decision path (an object, say) counts as nothing at that
 * path, so the next path is read.
 */

import { classifyDecision, type DecisionCategory, type DecisionVocabularyMap } from './classifyDecision.js';
import type { DecisionClass, VerdictWarning } from '../types/agent.js';

export type { DecisionClass, VerdictWarning };

/** What a gate reads from one agent's output. */
export interface AgentVerdict {
  /** The decision's class. `absent` is handled as neutral: the score decides. */
  class: DecisionClass;
  /** The saved decision (D18): the token when it classifies; else the value as written, whitespace
   *  collapsed, cut to 50 characters; `UNKNOWN` when absent. */
  saved: string;
  /** The gating score: a number from 0 to 100, or null when the contract holds none. */
  score: number | null;
  warnings: VerdictWarning[];
}

/** Where the wide resolvers found values the contract did not (`OutputNormalizer.locateDisplaySources`). */
export interface DisplaySources {
  decision?: { value: string; source: string };
  score?: { value: number | string; source: string };
}

const TOKEN_CUT = 200;
const SAVED_CUT = 50;
const CLOSING = new Set([')', ']', '.', ',', ':', ';', '!', '*']);
const isLetter = (c: string): boolean => /\p{L}/u.test(c);
const isWordChar = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string): boolean => /\s/u.test(c);

/**
 * The token rule (spec, The token rule). Returns the upper-cased token, or undefined when the value
 * holds none or what follows it makes the value neutral. Linear in the value's length.
 */
export function decisionToken(value: string): string | undefined {
  const chars = Array.from(value).slice(0, TOKEN_CUT);
  let i = 0;
  while (i < chars.length && !isLetter(chars[i]!)) i++;
  if (i === chars.length) return undefined;
  let j = i;
  while (j < chars.length && isWordChar(chars[j]!)) j++;
  const token = chars.slice(i, j).join('').toUpperCase();
  if (j === chars.length || CLOSING.has(chars[j]!)) return token;
  if (!isSpace(chars[j]!)) return undefined;
  let k = j;
  while (k < chars.length && isSpace(chars[k]!)) k++;
  return k === chars.length || !isLetter(chars[k]!) ? token : undefined;
}

/** The saved form of a value that does not classify (D18): whitespace collapsed, cut to 50. */
function asWritten(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  const cps = Array.from(collapsed);
  return cps.length <= SAVED_CUT ? collapsed : cps.slice(0, SAVED_CUT - 1).join('') + '…';
}

/** A vocabulary map that matches tokens case-insensitively (tokens are upper-cased). */
export function upperVocabulary(map: DecisionVocabularyMap | undefined): DecisionVocabularyMap | undefined {
  if (!map) return undefined;
  return new Map([...map].map(([k, v]) => [k.toUpperCase(), v]));
}

interface Classified { value: string; token?: string; category: DecisionCategory }
function classify(value: string, vocabulary: DecisionVocabularyMap | undefined): Classified {
  const token = decisionToken(value);
  return token === undefined ? { value, category: 'neutral' } : { value, token, category: classifyDecision(token, vocabulary) };
}
const classifies = (c: Classified | undefined): c is Classified & { token: string } =>
  c !== undefined && c.token !== undefined && c.category !== 'neutral';

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The value of the first line labelled `<label>:` (markdown emphasis or a heading marker allowed). */
function labelledLine(text: string, label: 'Decision' | 'Score'): string | undefined {
  // Linear: anchored per line, no nested quantifiers.
  const re = label === 'Decision'
    ? /^[ \t>#*_]*Decision[ \t]*:[ \t]*(.*)$/im
    : /^[ \t>#*_]*Score[ \t]*:[ \t]*(.*)$/im;
  const m = re.exec(text);
  return m ? m[1]!.trim() : undefined;
}

const NUMERIC = /^\d+(?:\.\d+)?$/;
/** A score value as the contract accepts it: a number from 0 to 100, or a string that is exactly one. */
function contractScore(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
  if (typeof v === 'string' && NUMERIC.test(v)) {
    // EXTERNAL-OK: the string matched NUMERIC (digits, optional decimals) on the line above.
    const n = Number(v);
    return n <= 100 ? n : undefined;
  }
  return undefined;
}

/**
 * Read an agent's decision and score as a gate reads them.
 *
 * @param input.json - the JSON core extracted from the output (structured output, a fence, or inline
 *   JSON); undefined when it found none.
 * @param input.text - the agent's raw text, read for the `Decision:` and `Score:` lines.
 * @param input.vocabulary - the agent's declared vocabulary (`buildVocabularyMap`); register remaps
 *   are already dropped there.
 * @param input.display - where the wide resolvers found a decision and a score, for the fallback warnings.
 */
export function readAgentVerdict(input: {
  agent: string;
  json: unknown;
  text: string;
  vocabulary?: DecisionVocabularyMap;
  display?: DisplaySources;
}): AgentVerdict {
  const { agent } = input;
  const vocabulary = upperVocabulary(input.vocabulary);
  const warnings: VerdictWarning[] = [];
  const obj = asRecord(input.json);
  const result = asRecord(obj?.['result']);

  // ── Decision ─────────────────────────────────────────────────────────────
  const jsonValue = typeof result?.['decision'] === 'string' ? result['decision'] as string
    : typeof obj?.['decision'] === 'string' ? obj['decision'] as string
    : undefined;
  const lineValue = labelledLine(input.text, 'Decision');
  const fromJson = jsonValue !== undefined ? classify(jsonValue, vocabulary) : undefined;
  const fromLine = lineValue !== undefined ? classify(lineValue, vocabulary) : undefined;

  let chosen: Classified | undefined;
  if (fromJson && fromLine && classifies(fromJson) && classifies(fromLine)) {
    chosen = fromJson;
    if (fromJson.category !== fromLine.category) {
      warnings.push({ code: 'DECISION_CONFLICT', agent, json: fromJson.token, line: fromLine.token });
    }
  } else if (fromJson && !classifies(fromJson) && classifies(fromLine)) {
    // A JSON value that does not classify never overrides a classifiable line.
    chosen = fromLine;
  } else {
    chosen = fromJson ?? fromLine;
  }

  let cls: DecisionClass;
  let saved: string;
  if (!chosen) {
    cls = 'absent';
    saved = 'UNKNOWN';
    warnings.push({ code: 'ABSENT_DECISION', agent });
    if (input.display?.decision) warnings.push({ code: 'FALLBACK_DECISION_SOURCE', agent, source: input.display.decision.source });
  } else if (classifies(chosen)) {
    cls = chosen.category;
    saved = chosen.token;
  } else {
    cls = 'neutral';
    saved = asWritten(chosen.value);
    warnings.push({ code: 'NEUTRAL_DECISION', agent, value: saved });
  }

  // ── Score ────────────────────────────────────────────────────────────────
  let score: number | null = null;
  const present = (v: unknown) => v !== undefined && v !== null;
  const named = present(result?.['score']) ? result!['score'] : present(obj?.['score']) ? obj!['score'] : undefined;
  if (named !== undefined) {
    const v = contractScore(named);
    if (v === undefined) warnings.push({ code: 'SCORE_INVALID', agent, value: typeof named === 'string' ? named : JSON.stringify(named) });
    else score = v;
  } else {
    const line = labelledLine(input.text, 'Score');
    if (line !== undefined) {
      // `85`, `85/100`, `**85**`: the first number on the line.
      const m = /^[*_\s]*(\d+(?:\.\d+)?)/.exec(line);
      const v = m ? contractScore(m[1]) : undefined;
      if (v === undefined) warnings.push({ code: 'SCORE_INVALID', agent, value: line.slice(0, SAVED_CUT) });
      else score = v;
    } else if (input.display?.score) {
      warnings.push({ code: 'FALLBACK_SCORE_SOURCE', agent, source: input.display.score.source });
    }
  }

  return { class: cls, saved, score, warnings };
}

/**
 * Whether an agent is unjudgeable (D24): no score and no classifiable decision; or, at a gate with a
 * threshold (aggregate or per-agent), no score at all. A classifiable decision does not stand in
 * for a score a threshold was never measured against. At a decision-only gate it suffices.
 */
export function isUnjudgeable(verdict: { class: DecisionClass; score: number | null }, gateHasThreshold: boolean): boolean {
  if (verdict.score !== null) return false;
  if (gateHasThreshold) return true;
  return verdict.class === 'neutral' || verdict.class === 'absent';
}
