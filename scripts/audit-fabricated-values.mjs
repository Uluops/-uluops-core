#!/usr/bin/env node
/**
 * Enumerate the defect class that aborted the 0.42.0 ship gate four times.
 *
 * THE CLASS
 * ---------
 * A number is reported that nobody measured, or a state is reported that never happened.
 * Concretely, four mechanically-detectable shapes:
 *
 *   A. `?? 0` (or `|| 0`) applied to a token/usage/score/cost value. The nullish
 *      coalescing reads like a numeric guarantee and is not one — it converts "the
 *      provider reported nothing" into "the provider reported zero", and those are
 *      different facts with different prices.
 *   B. A TRUTHY test on a numeric value (`if (tokens)`, `x || undefined`). A measured 0
 *      is falsy, so this reads "reported zero" as "not reported" — the same conflation
 *      pointing the other way.
 *   C. A numeric literal 0 for a score/token/cost field in a SYNTHESIZED result object
 *      (crash placeholders, blocked/skipped phases). Distinct from a measured 0.
 *   D. An external/provider value assigned without passing through a clamp
 *      (`safeTokenCount` / `optionalTokenCount` / `sanitizeModelCost`).
 *
 * WHY THIS EXISTS RATHER THAN A CHECKLIST
 * ---------------------------------------
 * Four code-auditor passes each found this class again, each one ring further out, and
 * each fix was applied at the citation it was reported at. The most expensive instance was
 * two lines below a line that had just been fixed; another was 453 lines away in the same
 * method, reading the same object. Human and LLM review both kept finding instances and
 * neither enumerated the set — an instrument aimed at where you believe the answer is can
 * only confirm.
 *
 * So this script does not judge. It ENUMERATES every site matching the shapes above and
 * requires each to be either fixed or explicitly waived with a reason. New code cannot add
 * an instance without either passing the clamp or writing down why it doesn't need to.
 *
 * USAGE
 *   node scripts/audit-fabricated-values.mjs            # report; exit 1 if unwaived sites exist
 *   node scripts/audit-fabricated-values.mjs --control  # prove the check can FAIL
 *
 * WAIVING
 * Add `// FABRICATION-OK: <reason>` on the line or the line above. A waiver with no reason
 * is rejected — the point is the reason, not the suppression.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** Fields whose value is a measurement — a fabricated one is a lie about the world. */
const MEASURED = String.raw`(?:[a-zA-Z]*[Ss]core|[a-zA-Z]*[Tt]okens|[a-zA-Z]*[Cc]ost[Uu]sd|contextSize|evicted[A-Za-z]*|[a-zA-Z]*[Dd]urationMs|toolCall[A-Za-z]*|confidence|[a-zA-Z]*[Ww]eight|timeoutMs|maxOutputLength|[a-zA-Z]*[Bb]udget)`;

/**
 * Names that LOOK measured but hold an object or a boolean. Testing these for truthiness
 * is correct, and flagging them buries the real hits — a gate nobody can read is a gate
 * nobody runs.
 */
const NOT_NUMERIC = /budgetTracker|providerMetadata|inputTokenDetails|outputTokenDetails|\.forcedWrapUp|\.brakeInert|\.contextEvicted|tokenBudget/;

const RULES = [
  {
    id: 'A-nullish-zero',
    what: '`?? 0` / `|| 0` on a measured value — absent becomes zero',
    re: new RegExp(String.raw`\b${MEASURED}\b[^;\n]{0,80}?(?:\?\?|\|\|)\s*0\b`),
  },
  {
    id: 'B-truthy-numeric',
    what: 'truthy test on a measured value — a reported 0 reads as "not reported"',
    // `x || undefined`, and `if (someTokens)` style guards.
    // Models the whole family, not just `if (x)` and `x || undefined`: negation,
    // `&&` guards, ternary conditions, and `> 0` presence tests all read a measured 0 as
    // "not reported". Each of these hid a real site.
    re: new RegExp([
      String.raw`\b${MEASURED}\b\s*\|\|\s*undefined`,
      String.raw`\bif\s*\(\s*!?[a-zA-Z_.?\[\]']*${MEASURED}[a-zA-Z_.?\[\]']*\s*\)`,
      // `\?\s` — a ternary has whitespace after the `?`. Without that, a TypeScript
      // OPTIONAL PROPERTY (`cacheReadTokens?: number`) matched as a ternary, which is both
      // a false positive and, because the scanner stops at the first matching rule, a way
      // for rule B to mask rule D on the same line. Caught by the control.
      String.raw`[a-zA-Z_.\[\]']*${MEASURED}[a-zA-Z_.\[\]']*\s*(?:\?\s[^?:]{0,60}:|&&)`,
      String.raw`\b${MEASURED}\b[a-zA-Z_.?\[\]']*\s*>\s*0\b`,
    ].join('|')),
    skip: NOT_NUMERIC,
  },
  {
    id: 'C-synthesized-zero',
    what: 'numeric literal 0 for a measured field in a synthesized object',
    // Matches at line start OR after `{`/`,` (inline objects), with or without a trailing
    // comma (last property). Anchoring at `^\s*` with a required comma missed both.
    re: new RegExp(String.raw`(?:^|[{,])\s*${MEASURED}\s*:\s*0\s*(?:,|\}|$)`),
  },
  {
    id: 'D-unclamped-external',
    what: 'provider/registry value assigned without a clamp',
    // Reads an external value AND writes it somewhere. A bare `const x = (m as T)?.y`
    // type-cast declaration is not a write of a measured number and does not fire.
    // `?.` and bracket access included; a bare declaration is no longer skipped (that
    // exemption is exactly how the unified-reasoning defect escaped). "Assignment" now
    // also covers object-literal properties and `return`, which carry a value onward just
    // as surely as `=` does.
    re: /(?:\b(?:meta|gUsage|usage|action|weights|providerMetadata)\s*(?:\??\.\s*[a-zA-Z_]|\[)|\bmodel\??\.cost\b|(?:input|output)TokenDetails\s*\??\.\s*[a-zA-Z_])/,
    requiresAssignment: true,
  },
];

const CLAMPS = /safeTokenCount|optionalTokenCount|sanitizeModelCost|clampModelBound|usableBudget|usableWeight|Number\.isFinite|finite\(|Math\.max\(\s*0\s*,/;

/**
 * True when a line's fabrication-shaped constructs are all inside a clamp call.
 *
 * Previously any line CONTAINING a clamp was skipped entirely, so a guarded value and an
 * unguarded one on the same line were both exempted. Now the clamped call arguments are
 * blanked out first; whatever fabrication shape survives that is genuinely unprotected.
 */
function isFullyClamped(line) {
  if (!CLAMPS.test(line)) return false;
  const stripped = line.replace(new RegExp(String.raw`(?:${CLAMPS.source})\s*\([^)]*\)`, 'g'), 'CLAMPED');
  return !RULES.some(r => r.re.test(stripped));
}
const WAIVER = /FABRICATION-OK:\s*\S+/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function scanFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
    // A waiver covers its own line and the CONTIGUOUS comment block immediately above it —
    // no further. The previous 4-line window bled: a waiver reasoning about tokens and cost
    // silently also suppressed a `durationMs: 0` four lines down, which its reason said
    // nothing about. Walking back only through comment lines means a waiver stops at the
    // first line of real code, so it can never cover a sibling it does not describe.
    const block = [line];
    for (let k = i - 1; k >= 0; k--) {
      const prev = lines[k].trim();
      if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*')) block.unshift(lines[k]);
      else break;
    }
    const context = block.join('\n');
    if (WAIVER.test(context)) continue;
    // The clamp must guard THIS value, not merely appear somewhere on the line. Exempting
    // the whole line let `foo(safeTokenCount(a), b ?? 0)` hide a fabrication beside a
    // clamp — a suppression granted by proximity rather than by protection.
    if (isFullyClamped(line)) continue;

    for (const rule of RULES) {
      if (rule.requiresAssignment
        && !/(?:\+=|\?\?=|(?<![=!<>])=(?!=))\s/.test(line)
        && !/^\s*[a-zA-Z_$][\w$]*\s*:/.test(line)
        && !/\breturn\b/.test(line)) continue;
      if (rule.skip && rule.skip.test(line)) continue;
      if (!rule.re.test(line)) continue;
      if (rule.id === 'D-unclamped-external' && !new RegExp(MEASURED).test(line)) continue;
      hits.push({ file: relative(ROOT, file), line: i + 1, rule: rule.id, what: rule.what, text: line.trim() });
      break;
    }
  }
  return hits;
}

function run() {
  return walk(SRC).flatMap(scanFile);
}

// ── Control: prove the instrument can fail ────────────────────────────────────────────
// A check that has never failed is indistinguishable from one that cannot. Before trusting
// a clean report, plant a known-bad line and confirm each rule fires on it.
if (process.argv.includes('--control')) {
  const probe = join(SRC, '__fabrication_control__.ts');
  // Baseline probes — one per rule — PLUS the adversarial variants that were confirmed to
  // slip past an earlier version of these rules. A control that only plants inputs shaped
  // the way the rules already expect proves the rules run, not that they cover the class;
  // an audit found 13 such blind spots hiding 8 real sites while this control passed.
  // Every line below must be caught by SOMETHING, so a future "simplification" of a regex
  // cannot silently reopen one.
  writeFileSync(probe, [
    // A — nullish coalescing
    'export function a(u: { inputTokens?: number }) { return u.inputTokens ?? 0; }',
    // A variant: cost with a prefix (the old MEASURED had no wildcard on cost)
    'export function a2(x: { totalCostUsd?: number }) { return x.totalCostUsd ?? 0; }',
    // B — truthy family
    'export function b(reasoningTokens?: number) { return reasoningTokens || undefined; }',
    'export function b2(score: number) { if (!score) { return 1; } return 2; }',
    'export function b3(cachedTokens: number) { return cachedTokens > 0 ? cachedTokens : 1; }',
    'export function b4(weight: number) { return weight && 2; }',
    // C — synthesized zero, at line start, inline, and as a last property
    'export const c = {',
    '  score: 0,',
    '};',
    'export const c2 = { inputTokens: 0 };',
    'export const c3 = { model: "m", durationMs: 0 };',
    // D — external read carried onward: assignment, object property, return,
    //     optional chaining, and bracket access
    'export function d(meta: { cacheReadTokens?: number }) { let cacheReadTokens = 0; cacheReadTokens = meta.cacheReadTokens!; return cacheReadTokens; }',
    'export function d2(meta: { outputTokens?: number }) { return meta?.outputTokens; }',
    'export function d3(weights: Record<string, number>, k: string) { const weight = weights[k]; return weight; }',
  ].join('\n'));

  const hits = run().filter(h => h.file.includes('__fabrication_control__'));

  const fired = new Set(hits.map(h => h.rule));
  const missing = RULES.map(r => r.id).filter(id => !fired.has(id));

  // Every planted line that declares a probe function/const must be caught. Checking only
  // "did each rule fire somewhere" would pass while individual adversarial variants slip
  // through — the exact gap this control exists to close.
  const plantedLines = readFileSync(probe, 'utf8').split('\n')
    .map((t, n) => ({ n: n + 1, t }))
    // Exclude a multi-line object's OPENING line: the fabrication is on the property line
    // inside it, which this same filter picks up separately. Counting the opener as
    // known-bad would make the control fail on a shape it actually catches.
    .filter(l => (/^export (?:function|const) [a-z]\d?/.test(l.t) && !l.t.trimEnd().endsWith('{'))
      || /^\s{2}(?:score|inputTokens|durationMs):/.test(l.t));
  const caughtLines = new Set(hits.map(h => h.line));
  const uncaught = plantedLines.filter(l => !caughtLines.has(l.n));

  unlinkSync(probe);
  console.log(`CONTROL: ${plantedLines.length} known-bad lines planted; rules fired: ${[...fired].join(', ') || '(none)'}`);
  if (missing.length || uncaught.length) {
    if (missing.length) console.error(`CONTROL FAILED — rules that never fired: ${missing.join(', ')}`);
    for (const l of uncaught) console.error(`CONTROL FAILED — uncaught known-bad line ${l.n}: ${l.t.trim()}`);
    console.error('A rule that cannot fire proves nothing about a clean report.');
    process.exit(1);
  }
  console.log(`CONTROL PASSED — all ${plantedLines.length} known-bad lines caught; every rule fires.`);
  process.exit(0);
}

const hits = run();
if (hits.length === 0) {
  console.log('audit-fabricated-values: no unwaived sites.');
  process.exit(0);
}

console.log(`audit-fabricated-values: ${hits.length} unwaived site(s)\n`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}  [${h.rule}]`);
  console.log(`    ${h.text}`);
  console.log(`    → ${h.what}`);
}
console.log('\nFix, or annotate with `// FABRICATION-OK: <reason>` stating why this value is measured.');
process.exit(1);
