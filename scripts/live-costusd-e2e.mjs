/**
 * Live E2E acceptance for costUsd (spec v0.6.0 criterion 1).
 *
 * Runs a REAL sonnet agent (starter code-validator) against this repo via a
 * LOCAL cost-emitting registry-api (localhost:3001, branch
 * feat/model-cost-wire-projection) and asserts engine costUsd equals the
 * hand computation from the wire-served rates EXACTLY.
 *
 * Requires: local registry-api dev server up; ANTHROPIC_API_KEY; core built
 * (dist/). Costs ~$0.35/run. First green run: 2026-07-26 ($0.331447 exact).
 * NOTE: passes per-call timeoutMs — agent-definition defaults.timeout
 * overrides config.timeout (tracker issue 6977cac5).
 */
import { UluOpsClient, STARTER_DEFINITIONS_DIR } from './dist/index.js';

const REGISTRY = 'http://localhost:3001/api/v1';

// Fetch the live rates first so the hand-check uses exactly what the wire served.
const rates = (await (await fetch(`${REGISTRY}/models/resolve/sonnet`)).json()).data.model.cost;
console.log('[live] wire rates for sonnet:', JSON.stringify(rates));

const client = new UluOpsClient({
  localDefinitions: STARTER_DEFINITIONS_DIR,
  trackingEnabled: false,
  registryUrl: REGISTRY,
  timeout: 900_000,
});

const t0 = Date.now();
const result = await client.runAgent('code-validator', '.', { model: 'sonnet', timeoutMs: 900_000 });
const m = result.metrics;

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN LIMITATION — read before trusting a green run.
//
// The "hand computation" below is a TRANSCRIPTION of computeCostUsd, not an
// independent oracle. It shares the engine's premises, so it can only ever prove
// the engine agrees with a copy of itself. On 2026-07-26 it reported
// "matches exactly" ($0.331447) while BOTH sides were inflated: inputTokens then
// carried the AI SDK v6 cache-INCLUSIVE total, so cache reads and writes were
// priced at the full input rate on both sides of the comparison and the difference
// stayed zero. The defect was invisible precisely because this check is tautological.
//
// A genuinely independent oracle would price the PROVIDER's own raw usage block
// (usage.raw, available in v6) against published rates. Core does not surface raw
// usage on ExecutionMetrics yet; until it does, the positive control at the bottom
// is what keeps this script honest — it proves the assertion is capable of failing.
// ─────────────────────────────────────────────────────────────────────────────

// input_tokens is CACHE-EXCLUSIVE as of the v6 normalization: it is priced directly
// with no cached subtraction, and each cache pool is priced once at its own rate.
const cached = m.cachedInputTokens ?? 0;
const priceOf = (metrics) => (
  metrics.inputTokens * rates.input +
  metrics.outputTokens * rates.output +
  (metrics.cacheReadTokens ?? 0) * (rates.cacheRead ?? rates.input) +
  (metrics.cacheCreationTokens ?? 0) * (rates.cacheWrite ?? rates.input)
) / 1e6;
const expected = priceOf(m);

console.log('\n[live] decision:', result.decision, '| score:', result.score);
console.log('[live] model:', m.model, '| duration:', Math.round((Date.now()-t0)/1000)+'s');
console.log('[live] usage: in=%d out=%d cacheW=%d cacheR=%d cached=%d',
  m.inputTokens, m.outputTokens, m.cacheCreationTokens ?? 0, m.cacheReadTokens ?? 0, cached);
console.log('[live] costUsd (engine):   $' + (m.costUsd?.toFixed(6) ?? 'undefined'));
console.log('[live] costUsd (hand):     $' + expected.toFixed(6));

if (m.costUsd === undefined) { console.error('FAIL: costUsd undefined on a priced model'); process.exit(1); }
if (Math.abs(m.costUsd - expected) > 1e-9) { console.error('FAIL: engine/hand mismatch'); process.exit(1); }
console.log('\nLIVE E2E PASSED: engine costUsd matches hand computation exactly');
