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
const MEASURED = String.raw`(?:score|maxScore|[a-zA-Z]*[Tt]okens|cost[Uu]sd|contextSize|evictedTokens|durationMs|toolCallCount|confidence)`;

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
    re: new RegExp(String.raw`(?:\b${MEASURED}\b\s*\|\|\s*undefined)|(?:\bif\s*\(\s*[a-zA-Z_.\[\]']*${MEASURED}[a-zA-Z_.\[\]']*\s*\))`),
    skip: NOT_NUMERIC,
  },
  {
    id: 'C-synthesized-zero',
    what: 'numeric literal 0 for a measured field in a synthesized object',
    re: new RegExp(String.raw`^\s*${MEASURED}\s*:\s*0\s*,`),
  },
  {
    id: 'D-unclamped-external',
    what: 'provider/registry value assigned without a clamp',
    // Reads an external value AND writes it somewhere. A bare `const x = (m as T)?.y`
    // type-cast declaration is not a write of a measured number and does not fire.
    re: /(?:\bmeta\.[a-zA-Z]|gUsage\.[a-zA-Z]|model\.cost\b|usage\.(?:inputTokens|outputTokens)\b|inputTokenDetails\.[a-zA-Z]|outputTokenDetails\.[a-zA-Z])/,
    requiresAssignment: true,
    skip: /^\s*(?:const|let|var)\s/,
  },
];

const CLAMPS = /safeTokenCount|optionalTokenCount|sanitizeModelCost|Number\.isFinite|finite\(/;
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
    // Look back a few lines: a real rationale is usually a multi-line comment, and a
    // waiver mechanism that only accepts one-liners pushes people toward terse
    // suppressions — the opposite of the point.
    const context = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (WAIVER.test(context)) continue;
    if (CLAMPS.test(line)) continue;

    for (const rule of RULES) {
      if (rule.requiresAssignment && !/(?:\+=|\?\?=|(?<![=!<>])=(?!=))\s/.test(line)) continue;
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
  writeFileSync(probe, [
    'export function a(u: { inputTokens?: number }) { return u.inputTokens ?? 0; }',
    'export function b(reasoningTokens?: number) { return reasoningTokens || undefined; }',
    'export const c = {',
    '  score: 0,',
    '};',
    'export function d(meta: { cacheReadTokens?: number }) { let cacheReadTokens = 0; cacheReadTokens = meta.cacheReadTokens!; return cacheReadTokens; }',
  ].join('\n'));

  const hits = run().filter(h => h.file.includes('__fabrication_control__'));
  unlinkSync(probe);

  const fired = new Set(hits.map(h => h.rule));
  const expected = RULES.map(r => r.id);
  const missing = expected.filter(id => !fired.has(id));

  console.log(`CONTROL: planted 4 known-bad lines; rules that fired: ${[...fired].join(', ') || '(none)'}`);
  if (missing.length) {
    console.error(`CONTROL FAILED — these rules did not fire on known-bad input: ${missing.join(', ')}`);
    console.error('A rule that cannot fire proves nothing about a clean report.');
    process.exit(1);
  }
  console.log('CONTROL PASSED — every rule fires on known-bad input.');
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
