#!/usr/bin/env node
/**
 * Verify multi-provider connectivity for @uluops/core SDK.
 *
 * Tests OpenAI and Google providers with a simple query each.
 *
 * Usage:
 *   node scripts/verify-providers.mts
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Load .env.local
const envPath = resolve(import.meta.dirname, '../.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
} catch {
  // .env.local not found — rely on shell env
}

const { AIProvider } = await import('../dist/ai/AIProvider.js');

// Mock catalog that resolves model aliases without registry
function mockCatalog() {
  return {
    resolve: async (alias) => {
      const MODELS = {
        'haiku': { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', thinking: false },
        'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini', thinking: false },
        'gemini-2.5-flash': { provider: 'google', modelId: 'gemini-2.5-flash', thinking: false },
      };
      const m = MODELS[alias] ?? { provider: alias.split(':')[0], modelId: alias.split(':')[1] ?? alias, thinking: false };
      return {
        provider: m.provider,
        modelId: m.modelId,
        providerModelId: m.modelId,
        tier: 'standard',
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: m.thinking },
        resolvedFrom: alias,
      };
    },
    refresh: async () => {},
  };
}

const PROVIDERS = [
  { name: 'OpenAI', envVar: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  { name: 'Google', envVar: 'GOOGLE_API_KEY', model: 'gemini-2.5-flash' },
];

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function testProvider(test, aiProvider) {
  const key = process.env[test.envVar];
  if (!key) {
    if (test.name === 'Google' && process.env['GOOGLE_GENERATIVE_AI_API_KEY']) {
      // Key found via alternate var, proceed
    } else {
      return 'SKIP (no API key)';
    }
  }

  const start = Date.now();
  const result = await aiProvider.generate({
    model: test.model,
    system: 'You are a helpful assistant. Reply concisely.',
    prompt: 'What is 2+2? Reply with just the number.',
    maxTokens: 50,
    timeoutMs: 30_000,
  });
  const elapsed = Date.now() - start;

  console.log(`  Response: "${result.text.trim()}"`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Tokens: ${result.usage.input_tokens}in / ${result.usage.output_tokens}out`);
  if (result.usage.cache_read_input_tokens) {
    console.log(`  Cache read: ${result.usage.cache_read_input_tokens}`);
  }
  if (result.usage.thinking_tokens) {
    console.log(`  Thinking: ${result.usage.thinking_tokens}`);
  }
  console.log(`  Duration: ${elapsed}ms`);

  return 'PASS';
}

async function main() {
  console.log('=== Provider Verification ===\n');

  // Build providers config from env
  const providers = {};
  if (process.env['ANTHROPIC_API_KEY']) providers['anthropic'] = { apiKey: process.env['ANTHROPIC_API_KEY'] };
  if (process.env['OPENAI_API_KEY']) providers['openai'] = { apiKey: process.env['OPENAI_API_KEY'] };
  const googleKey = process.env['GOOGLE_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (googleKey) providers['google'] = { apiKey: googleKey };

  console.log(`Configured providers: ${Object.keys(providers).join(', ') || '(none)'}\n`);

  if (Object.keys(providers).length === 0) {
    console.error('No provider API keys found. Set OPENAI_API_KEY and/or GOOGLE_API_KEY in .env.local');
    process.exit(1);
  }

  const config = {
    apiKey: 'unused',
    ai: { providers, defaultProvider: 'anthropic' },
    registryUrl: 'https://api.uluops.ai/api/v1/registry',
    validationUrl: 'https://api.uluops.ai/api/v1/ops',
    dashboardUrl: 'https://app.uluops.ai',
    trackingEnabled: false,
    hashVerificationEnabled: false,
    timeout: 30_000,
    debug: false,
    defaultThinkingBudget: 10_000,
    contextBudget: 200_000,
  };

  const aiProvider = new AIProvider(config, mockCatalog(), noopLogger);

  const results = {};

  for (const test of PROVIDERS) {
    console.log(`--- ${test.name} (${test.model}) ---`);
    try {
      results[test.name] = await testProvider(test, aiProvider);
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      results[test.name] = 'FAIL';
    }
    console.log();
  }

  console.log('=== Results ===');
  for (const [name, status] of Object.entries(results)) {
    const icon = status === 'PASS' ? '✓' : status.startsWith('SKIP') ? '⊘' : '✗';
    console.log(`  ${icon} ${name}: ${status}`);
  }

  const failed = Object.values(results).filter(s => s === 'FAIL').length;
  if (failed > 0) process.exit(1);
}

main();
