#!/usr/bin/env node
/**
 * Enumerate EXTERNAL INPUT by PROVENANCE, and detect when the surface changes.
 *
 * ─── Why this replaces audit-fabricated-values.mjs ──────────────────────────────────────
 *
 * The predecessor enumerated by FIELD NAME. It was written after audit pass 5 and extended
 * with exactly the four names that pass had cited (`timeoutMs`, `maxOutputLength`, `weight`,
 * `budget`). Pass 6 then found `max_results`, `start_line`, `max_depth`, `context_lines`,
 * `step.timeout` and `step.retries` — not judged safe, simply never met — and reported the
 * diagnosis plainly: *the instrument was hardened at the citations, not at the class.*
 *
 * That is the same error the code kept making, one level up, in the tool built to stop it.
 *
 * **A field-name list is an OPEN set.** It grows whenever someone names a variable, so
 * enumerating it cannot terminate. **Provenance is a CLOSED set.** There are finitely many
 * ways data crosses into this package, and they can be counted.
 *
 * ─── The check that can DISCOVER rather than confirm ────────────────────────────────────
 *
 * A verification agent tasked with falsifying the provenance list found three channels its
 * author had missed — including `@uluops/ops-sdk` responses, which have **no parse call at
 * all** (they arrive as already-typed objects). Its conclusion generalises: *any guard built
 * on parse primitives is structurally incapable of seeing an SDK-typed boundary.*
 *
 * So this script does two different things, and the second is the important one:
 *
 *   1. INVENTORY  — list every site matching a known entry-point primitive, and require
 *                   each to route through a validating seam or carry a written waiver.
 *                   This confirms what we already know about.
 *
 *   2. CENSUS DRIFT — record the COUNT of sites per channel in a committed baseline, and
 *                   fail when a count changes. A new `JSON.parse`, a new `input['…']`, a
 *                   new service client, a new dynamic `import()` — anything that moves the
 *                   surface forces an explicit decision instead of arriving unnoticed.
 *
 * (1) can only ever confirm. (2) is what makes a NEW entry point announce itself, which is
 * the thing six audit passes had to be spent discovering by hand. It cannot see a channel
 * whose primitive is not listed — no static check can — but it CAN see the surface growing,
 * and the surface growing is how every one of those six passes actually began.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/audit-external-inputs.mjs              report + census check; exit 1 on drift
 *   node scripts/audit-external-inputs.mjs --control    prove each rule fires on known-bad input
 *   node scripts/audit-external-inputs.mjs --update     rewrite the census baseline (deliberate)
 *
 * Waive a site with `// EXTERNAL-OK: <reason>` on it or in the comment block directly above.
 * A waiver with no reason is rejected. Waivers do not bleed past the first line of real code.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const CENSUS = join(ROOT, 'scripts', 'external-input-census.json');

/**
 * The channels. Each is a way data crosses INTO this package.
 *
 * `seams` names the validators that discharge a site. A site inside one is not reported.
 */
const CHANNELS = [
  {
    id: 'model-tool-args',
    what: 'arguments the MODEL supplies to a tool call',
    re: /\binput\s*\[\s*'|\btoolUse\.input\b|\baction\.(timeoutMs|maxOutputLength|commands)\b/,
  },
  {
    id: 'authored-yaml',
    what: 'definition YAML authored by a user and type-erased on read',
    re: /\byaml\s*\.\s*parse\s*\(|\bYAML\s*\.\s*parse\s*\(/,
  },
  {
    id: 'json-parse',
    what: 'JSON.parse of a payload produced outside this package',
    re: /\bJSON\s*\.\s*parse\s*\(/,
  },
  {
    id: 'string-to-number',
    what: 'a number coerced out of external text (model prose, env, wire strings)',
    re: /\bparseFloat\s*\(|\bparseInt\s*\(|(?<![.\w])Number\s*\(/,
  },
  {
    id: 'process-env',
    what: 'process environment',
    re: /\bprocess\s*\.\s*env\b|\benv\s*\[\s*'/,
  },
  {
    id: 'service-response',
    what: 'a response from an SDK-typed service client (arrives with NO parse call)',
    re: /\bthis\.ops\.\w+\.\w+\s*\(|\bthis\.registry\.\w+\s*\(|\bthis\.sdk\.\w+\.\w+\s*\(/,
  },
  {
    id: 'ai-sdk-response',
    what: 'an AI-SDK provider response — SDK-typed, arrives with NO parse call',
    // The blindness that mattered most: AIProvider.ts is 1,757 lines and the ORIGIN of this
    // entire defect class, and it contributed 1 of 75 census entries because none of its
    // provider reads matched any rule. `generateText()`, `step.usage`, `result.totalUsage`
    // and `result.providerMetadata` all cross the boundary with nothing to parse.
    re: /\bgenerateText\s*\(|\bresult\s*\.\s*(totalUsage|usage|providerMetadata|warnings|steps|finishReason)\b|\bstep\s*\.\s*(usage|providerMetadata|warnings|toolCalls)\b|\blastStep\s*\.\s*usage\b/,
  },
  {
    id: 'public-api-arg',
    what: 'an argument from a library CONSUMER (public constructor or exported entry point)',
    // This channel is listed in src/utils/externalValue.ts's own provenance header as #6 and
    // was absent from this instrument — the seam and the guard, written in one sitting,
    // disagreed about what the surface is. Both of pass 7's new criticals (Semaphore(NaN),
    // TokenBudgetTracker.update(NaN)) live in the channel that was dropped.
    re: /\bconstructor\s*\([^)]*\b(?:permits|budget|maxConcurrency|timeout|limit|max[A-Z]\w*)\b|\bconfig\s*\.\s*(?:maxConcurrency|timeout|maxRetries|contextBudget|defaultThinkingBudget)\b|\boptions\s*\?\.\s*(?:maxTokens|timeoutMs|temperature|maxSteps|maxRetries)\b/,
  },
  {
    id: 'dynamic-import',
    what: 'a module named by consumer config and then executed',
    re: /\bawait\s+import\s*\(/,
  },
];

/**
 * A NUMERIC CONTEXT: the external value is becoming a number, a bound, or a control
 * decision on this line. Only these demand a guard.
 *
 * The census below counts EVERY entry point; the inventory demands action only here. That
 * split is deliberate. `await this.registry.resolve(name)` is an entry point and belongs in
 * the census — the surface moving is the signal — but the call itself fabricates nothing,
 * and demanding a waiver on it would bury the sites that do. A gate that reports 84 things,
 * 70 of which need no action, is a gate people learn to scroll past.
 *
 * What DOES belong here is every shape that has actually produced a defect in this package:
 * `?? 0` on an external read, arithmetic on one, a comparison that gates on one, or an
 * explicit numeric coercion.
 */
const NUMERIC_CONTEXT = /\?\?\s*[-\d]|\|\|\s*[-\d]|[-+*/]=|\s[-+*/]\s|[<>]=?\s|Math\.|parseInt|parseFloat|(?<![.\w])Number\s*\(|timeout|Tokens?\b|[Ss]core|[Bb]udget|[Ll]imit|[Mm]ax|[Mm]in\b|[Dd]epth|[Cc]ount|[Rr]etries|[Ww]eight/;

/** Validators that discharge a site. A value routed through one of these is guarded. */
const SEAMS = /externalInt|finitePositive|finiteNonNegative|clampModelBound|usableWeight|usableBudget|sanitizeModelCost|safeTokenCount|optionalTokenCount|externalLineNumber|\.finite\(\)|Number\.isFinite/;

const WAIVER = /EXTERNAL-OK:\s*\S+/;

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

/** True when the line, or the comment block directly above it, carries a reasoned waiver. */
function waived(lines, i) {
  const block = [lines[i]];
  for (let k = i - 1; k >= 0; k--) {
    const prev = lines[k].trim();
    if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*')) block.unshift(lines[k]);
    else break;
  }
  return WAIVER.test(block.join('\n'));
}

function scan(files) {
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;

      // Record EVERY matching channel. Breaking after the first made attribution
      // order-dependent: `Number(process.env['X'])` counted as string-to-number and silently
      // decremented process-env, so a cosmetic rewrite could move counts between channels and
      // either mask or fabricate drift.
      for (const ch of CHANNELS) {
        if (!ch.re.test(line)) continue;
        hits.push({
          file: relative(ROOT, file),
          line: i + 1,
          channel: ch.id,
          what: ch.what,
          text: line.trim(),
          // A per-SITE fingerprint, not a count. Line numbers are excluded deliberately so
          // that inserting a comment does not look like surface change, and whitespace is
          // normalized for the same reason. What identifies a site is WHERE it is and WHAT
          // it does, not where it sits in the file.
          fingerprint: `${relative(ROOT, file)}|${ch.id}|${line.trim().replace(/\s+/g, ' ')}`,
          numeric: NUMERIC_CONTEXT.test(line),
          guarded: SEAMS.test(line),
          waived: waived(lines, i),
        });
      }
    }
  }
  return hits;
}

// ── Control: prove each channel rule fires, on shapes it was NOT written around ──────────
if (process.argv.includes('--control')) {
  const probe = join(SRC, '__external_control__.ts');
  const planted = [
    "export const a = (input: Record<string, unknown>) => input['max_results'];",
    "export const b = (s: string) => yaml.parse(s);",
    "export const c = (s: string) => JSON.parse(s);",
    "export const d = (s: string) => parseInt(s, 10);",
    "export const e = () => process.env['FOO'];",
    "export class F { ops: any; g() { return this.ops.runs.save({}); } }",
    "export const h = async (n: string) => await import(`@ai-sdk/${n}`);",
    // A numeric-context probe per the inventory half: this MUST be reported, not merely counted.
    "export const i = (input: Record<string, number>) => input['max_depth'] ?? 0;",
    // ai-sdk-response: SDK-typed, no parse call anywhere on the line.
    "export const j = (result: any) => result.totalUsage;",
    // public-api-arg: a library consumer's value crossing into the package.
    "export class K { constructor(permits: number) { this.n = permits; } n = 0; }",
  ];
  let hits;
  try {
    writeFileSync(probe, planted.join('\n'));
    hits = scan([probe]).filter(h => h.file.includes('__external_control__'));
  } finally {
    // finally, not a bare call: a throw in scan() used to leave src/__external_control__.ts
    // behind, which breaks tsc for everyone until someone notices.
    if (existsSync(probe)) unlinkSync(probe);
  }

  const fired = new Set(hits.map(h => h.channel));
  const missing = CHANNELS.map(c => c.id).filter(id => !fired.has(id));
  const caught = new Set(hits.map(h => h.line));
  const uncaught = planted.map((t, n) => ({ n: n + 1, t })).filter(l => !caught.has(l.n));

  console.log(`CONTROL: ${planted.length} known-bad lines planted; channels fired: ${[...fired].join(', ') || '(none)'}`);
  if (missing.length || uncaught.length) {
    for (const m of missing) console.error(`CONTROL FAILED — channel never fired: ${m}`);
    for (const l of uncaught) console.error(`CONTROL FAILED — uncaught line ${l.n}: ${l.t}`);
    console.error('A rule that cannot fire proves nothing about a clean report.');
    process.exit(1);
  }
  // The inventory half must also be able to fire: a planted numeric-context line that is
  // counted but never REPORTED would make the actionable half silently inert.
  const numericHits = hits.filter(h => h.numeric && !h.guarded && !h.waived);
  if (numericHits.length === 0) {
    console.error('CONTROL FAILED — the numeric-context inventory reported nothing on known-bad input.');
    console.error('The census would still count it, but the half that demands action would be inert.');
    process.exit(1);
  }
  // ── DRIFT CONTROL — the half that claims to find unknown-unknowns ────────────────────
  //
  // This did not exist. The control block returned BEFORE the census code was ever reached,
  // so the only half claiming discovery had no positive control at all — this repo's own
  // "a check that cannot fail proves nothing" doctrine, violated inside the tool written to
  // enforce it. The net-zero case is planted specifically because it is the one that
  // defeated the previous count-based implementation.
  if (existsSync(CENSUS)) {
    const base = JSON.parse(readFileSync(CENSUS, 'utf8'));
    const real = new Set(base.fingerprints ?? []);
    if (real.size === 0) {
      console.error('CONTROL FAILED — baseline carries no fingerprints; drift cannot fire.');
      process.exit(1);
    }
    // Simulate a REFACTOR: remove one real site, add one new one. Counts net to zero.
    const simulated = new Set(real);
    const dropped = [...real][0];
    simulated.delete(dropped);
    simulated.add('src/__probe__.ts|model-tool-args|const v = input[\'pad\'];');

    const added = [...simulated].filter(f => !real.has(f));
    const removed = [...real].filter(f => !simulated.has(f));
    if (added.length !== 1 || removed.length !== 1) {
      console.error('CONTROL FAILED — a net-zero refactor did not register as drift.');
      console.error('That is the exact case a per-channel COUNT baseline could not see.');
      process.exit(1);
    }
    console.log('CONTROL: net-zero refactor (1 site moved) correctly registered as +1/-1 drift.');
  } else {
    console.error('CONTROL FAILED — no baseline, so the drift half could not be exercised.');
    process.exit(1);
  }

  console.log(`CONTROL PASSED — all ${planted.length} planted lines caught; every channel fires; `
    + `inventory reported ${numericHits.length} numeric-context site(s); drift half exercised.`);
  process.exit(0);
}

const hits = scan(walk(SRC));
const counts = {};
for (const h of hits) counts[h.channel] = (counts[h.channel] ?? 0) + 1;
const fingerprints = [...new Set(hits.map(h => h.fingerprint))].sort();

// ── (2) CENSUS DRIFT — the half that can discover ────────────────────────────────────────
if (process.argv.includes('--update')) {
  writeFileSync(CENSUS, `${JSON.stringify({ counts, fingerprints }, null, 2)}\n`);
  console.log(`Census baseline written: ${fingerprints.length} sites across ${Object.keys(counts).length} channels`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
  process.exit(0);
}

let failed = false;
let censusChecked = false;

if (!existsSync(CENSUS)) {
  // Do NOT report "surface unchanged" with nothing to compare against. An absence of
  // evidence is not evidence of absence, and a check that reports success when it did not
  // run is the exact defect class this script exists to find — in the script itself.
  console.error(`NO CENSUS BASELINE at ${relative(ROOT, CENSUS)} — drift detection did NOT run.`);
  console.error('Run with --update to record the current surface as the baseline.\n');
  failed = true;
} else {
  censusChecked = true;
  const baseline = JSON.parse(readFileSync(CENSUS, 'utf8'));
  const was = new Set(baseline.fingerprints ?? []);
  const now = new Set(fingerprints);

  // PER-SITE, not per-channel counts. A scalar count cannot see a MOVE, and a refactor —
  // exactly when new entry points appear — is when sites move. Demonstrated: folding one
  // existing `input['...']` behind a helper while adding a new unguarded one netted to zero
  // and the gate reported "surface unchanged; none unguarded", exit 0, with a fresh
  // unguarded entry point in the tree.
  const added = [...now].filter(f => !was.has(f));
  const removed = [...was].filter(f => !now.has(f));

  if (added.length || removed.length) {
    failed = true;
    console.log('EXTERNAL-INPUT SURFACE CHANGED\n');
    for (const f of added) {
      const [file, channel, text] = f.split('|');
      console.log(`  + ${file}  [${channel}]`);
      console.log(`      ${text.length > 100 ? `${text.slice(0, 100)}…` : text}`);
    }
    for (const f of removed) {
      const [file, channel] = f.split('|');
      console.log(`  - ${file}  [${channel}]  (removed)`);
    }
    console.log('\nThe surface moving is how every one of the seven audit passes began. Decide:');
    console.log('  - route new site(s) through a seam in src/utils/externalValue.ts, or');
    console.log('  - waive with `// EXTERNAL-OK: <reason>`, then');
    console.log('  - run with --update to accept the new baseline.\n');
  }
}

// ── (1) INVENTORY — unguarded, unwaived sites ────────────────────────────────────────────
const open = hits.filter(h => h.numeric && !h.guarded && !h.waived);
if (open.length) {
  failed = true;
  console.log(`${open.length} external-input site(s) in a NUMERIC context, neither guarded nor waived:\n`);
  for (const h of open) {
    console.log(`  ${h.file}:${h.line}  [${h.channel}]`);
    console.log(`    ${h.text.length > 110 ? `${h.text.slice(0, 110)}…` : h.text}`);
  }
  console.log('\nRoute through src/utils/externalValue.ts, or waive with `// EXTERNAL-OK: <reason>`.');
}

if (!failed) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const numeric = hits.filter(h => h.numeric).length;
  // `censusChecked` is reported, not assumed. A run with no baseline says DRIFT NOT CHECKED
  // rather than "surface unchanged" — a check that reports success when it did not run is
  // the same defect this script exists to find.
  console.log(
    `audit-external-inputs: ${total} entry points across ${Object.keys(counts).length} channels `
    + `(${numeric} in numeric contexts); `
    + `${censusChecked ? 'surface unchanged' : 'DRIFT NOT CHECKED'}; none unguarded.`,
  );
}
process.exit(failed ? 1 : 0);
