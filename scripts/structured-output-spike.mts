#!/usr/bin/env tsx
/**
 * Phase 0a spike — agent-schema-score-nullability-spec.
 *
 * Question: does each provider, via the SAME structured-output path core uses
 * (`generateText` + `Output.object({ schema })`), ACCEPT the relaxed schema
 *   score:    z.number().min(0).max(100).nullable()
 *   maxScore: z.number().nullable()
 * and let `null` flow through — or does it reject the schema (constrained+nullable)
 * or silently coerce null → 0/100?
 *
 * If the constrained shape is rejected, we retry the fallback shape
 *   score: z.number().nullable()   (no .min/.max)
 * per the spec's "drop .min(0).max(100)" decision.
 *
 * Run:  npx tsx scripts/structured-output-spike.mts
 * Needs: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)
 */
import { generateText, Output } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const constrained = z.object({
  decision: z.string(),
  score: z.number().min(0).max(100).nullable(),
  maxScore: z.number().nullable(),
});
const fallback = z.object({
  decision: z.string(),
  score: z.number().nullable(),
  maxScore: z.number().nullable(),
});

const GEN_PROMPT =
  "You are a GENERATOR agent that produced an artifact, not an evaluation. " +
  "You did not score anything and there is no score. " +
  "Return decision='COMPLETE', score=null, maxScore=null. Do NOT invent numbers — null means null.";
const VAL_PROMPT =
  "You are a VALIDATOR. You scored the artifact 85 out of 100. " +
  "Return decision='PASS', score=85, maxScore=100.";

const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;

const providers = [
  { name: 'openai (gpt-4o-2024-08-06, strict)', key: process.env.OPENAI_API_KEY,
    model: () => createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-4o-2024-08-06') },
  { name: 'anthropic (claude-haiku-4-5)', key: process.env.ANTHROPIC_API_KEY,
    model: () => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-haiku-4-5-20251001') },
  { name: 'google (gemini-2.5-flash)', key: googleKey,
    model: () => createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.5-flash') },
];

async function probe(model: any, schema: z.ZodTypeAny, prompt: string) {
  const start = Date.now();
  try {
    const res = await generateText({
      model,
      prompt,
      output: Output.object({ schema }),
      maxOutputTokens: 300,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(45_000),
    });
    return { ok: true, out: (res as any).output, ms: Date.now() - start };
  } catch (e: any) {
    return { ok: false, err: String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 400), ms: Date.now() - start };
  }
}

function classifyGen(r: any): string {
  if (!r.ok) return `REJECTED (${r.err})`;
  const s = r.out?.score, m = r.out?.maxScore;
  if (s === null && m === null) return `ACCEPTED — null preserved (decision=${r.out?.decision})`;
  if (s === null && m !== null) return `PARTIAL — score null but maxScore=${m} (invariant!)`;
  return `COERCED — score=${JSON.stringify(s)}, maxScore=${JSON.stringify(m)} (model/provider filled a value)`;
}
function classifyVal(r: any): string {
  if (!r.ok) return `REJECTED (${r.err})`;
  return `score=${JSON.stringify(r.out?.score)}, maxScore=${JSON.stringify(r.out?.maxScore)}`;
}

console.log('# Phase 0a — nullable structured-output spike\n');
for (const p of providers) {
  console.log(`\n## ${p.name}`);
  if (!p.key) { console.log('  SKIP — no API key'); continue; }
  const model = p.model();

  // constrained schema
  const gen = await probe(model, constrained, GEN_PROMPT);
  const val = await probe(model, constrained, VAL_PROMPT);
  console.log(`  [constrained] generator: ${classifyGen(gen)}  (${gen.ms}ms)`);
  console.log(`  [constrained] validator: ${classifyVal(val)}  (${val.ms}ms)`);

  // fallback only if constrained rejected at schema level
  const constrainedRejected = !gen.ok || !val.ok;
  if (constrainedRejected) {
    const fgen = await probe(model, fallback, GEN_PROMPT);
    const fval = await probe(model, fallback, VAL_PROMPT);
    console.log(`  [fallback ] generator: ${classifyGen(fgen)}  (${fgen.ms}ms)`);
    console.log(`  [fallback ] validator: ${classifyVal(fval)}  (${fval.ms}ms)`);
  }
}
console.log('\n# done');
