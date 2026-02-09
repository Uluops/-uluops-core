#!/usr/bin/env node
/**
 * Smoke test for @uluops/core SDK.
 *
 * Usage:
 *   node --env-file=.env.local scripts/smoke-test.mts
 *
 * Layers:
 *   1. Local definition resolution (no network calls)
 *   2. AI provider connectivity (calls Anthropic via haiku)
 *   3. Full agent execution (end-to-end with real LLM)
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Load .env.local, overriding shell env (--env-file doesn't override existing vars)
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

const DEFINITIONS_DIR = resolve(
  import.meta.dirname,
  '../../../uluops-agent-workflows/udl/adl/v3',
);
const TARGET_DIR = resolve(import.meta.dirname, '../src');

// ──────────────────────────────────────────────────────────────────────────────
// Layer 1: Local definition resolution
// ──────────────────────────────────────────────────────────────────────────────

async function testLocalResolution() {
  console.log('\n=== Layer 1: Local Definition Resolution ===\n');

  const apiKey = process.env['ULUOPS_API_KEY'];
  if (!apiKey) {
    console.log('  SKIP: ULUOPS_API_KEY not set');
    return null;
  }

  const { RegistryClient } = await import('../dist/registry/RegistryClient.js');

  const config = {
    apiKey,
    ai: { providers: {}, defaultProvider: 'anthropic' },
    registryUrl: process.env['ULUOPS_REGISTRY_URL'] ?? 'http://localhost:3001/api/v1',
    validationUrl: 'https://ops.uluops.ai/api',
    dashboardUrl: 'https://app.uluops.ai',
    localDefinitions: DEFINITIONS_DIR,
    trackingEnabled: false,
    hashVerificationEnabled: false,
    timeout: 30000,
  };

  const registry = new RegistryClient(config);

  // Test resolve
  console.log('Resolving code-validator...');
  const resolved = await registry.resolve('code-validator', undefined, 'agent');
  console.log(`  Name: ${resolved.name}`);
  console.log(`  Version: ${resolved.version}`);
  console.log(`  Type: ${resolved.type}`);
  console.log(`  Hash: ${resolved.hash?.slice(0, 30)}...`);
  console.log(`  Domain: ${resolved.domain}`);
  console.log(`  AgentType: ${resolved.agentType}`);

  const runtime = resolved.runtime as { prompt?: string; defaults?: Record<string, unknown>; config?: Record<string, unknown> };
  console.log(`  Prompt length: ${runtime.prompt?.length ?? 'N/A'} chars`);
  if (runtime.prompt) {
    console.log(`  Prompt preview: "${runtime.prompt.slice(0, 120).replace(/\n/g, ' ')}..."`);
  }
  if (runtime.defaults) {
    console.log(`  Defaults: model=${runtime.defaults.model}, timeout=${runtime.defaults.timeout}`);
  }
  if (runtime.config) {
    console.log(`  Config: maxScore=${runtime.config.maxScore}, threshold=${runtime.config.threshold}`);
  }

  // Test list
  console.log('\nListing local agents...');
  const agents = await registry.list({ type: 'agent' });
  console.log(`  Found ${agents.length} agents`);
  for (const a of agents.slice(0, 5)) {
    console.log(`    - ${a.name} v${a.version} (${a.domain})`);
  }

  console.log('\n✓ Layer 1 PASSED');
  return resolved;
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer 2: AI provider connectivity
// ──────────────────────────────────────────────────────────────────────────────

async function testAIConnectivity() {
  console.log('\n=== Layer 2: AI Provider Connectivity ===\n');

  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicKey) {
    console.log('  SKIP: ANTHROPIC_API_KEY not set');
    return false;
  }

  console.log(`  ANTHROPIC_API_KEY: ${anthropicKey.slice(0, 12)}...`);

  // Pre-validate key with a lightweight API call
  const checkResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  if (checkResp.status === 401) {
    console.log('  SKIP: ANTHROPIC_API_KEY is invalid/expired (401)');
    return false;
  }

  const { AIProvider } = await import('../dist/ai/AIProvider.js');

  // Mock catalog that returns static model info (skip registry)
  const mockCatalog = {
    resolve: async (alias: string) => {
      const modelId = alias === 'haiku'
        ? 'claude-haiku-4-5-20251001'
        : alias === 'sonnet'
          ? 'claude-sonnet-4-5-20250929'
          : alias === 'opus'
            ? 'claude-opus-4-6'
            : alias;
      return {
        provider: 'anthropic',
        modelId,
        providerModelId: modelId,
        tier: alias === 'opus' ? 'premium' : alias === 'haiku' ? 'fast' : 'standard',
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false },
        resolvedFrom: alias,
      };
    },
    refresh: async () => {},
  };

  const config = {
    apiKey: 'unused',
    ai: {
      providers: { anthropic: { apiKey: anthropicKey } },
      defaultProvider: 'anthropic',
    },
    registryUrl: process.env['ULUOPS_REGISTRY_URL'] ?? 'http://localhost:3001/api/v1',
    validationUrl: 'https://ops.uluops.ai/api',
    dashboardUrl: 'https://app.uluops.ai',
    trackingEnabled: false,
    hashVerificationEnabled: false,
    timeout: 30000,
  };

  const aiProvider = new AIProvider(config, mockCatalog);

  console.log('Sending test prompt to Anthropic (haiku for speed)...');
  const start = Date.now();

  const result = await aiProvider.generate({
    prompt: 'You are a test validator.',
    model: 'haiku',
    messages: [{ role: 'user', content: 'Reply with exactly: {"status":"ok"}' }],
    maxTokens: 100,
    timeoutMs: 30000,
  });

  const elapsed = Date.now() - start;

  console.log(`  Response: ${result.text.slice(0, 200)}`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Tokens: in=${result.usage?.input_tokens}, out=${result.usage?.output_tokens}`);
  console.log(`  Duration: ${elapsed}ms`);

  console.log('\n✓ Layer 2 PASSED');
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer 3: Full agent execution (lightweight)
// ──────────────────────────────────────────────────────────────────────────────

async function testFullExecution() {
  console.log('\n=== Layer 3: Full Agent Execution ===\n');

  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const uluopsKey = process.env['ULUOPS_API_KEY'];
  if (!anthropicKey || !uluopsKey) {
    console.log('  SKIP: Missing API keys');
    return false;
  }

  const { RegistryClient } = await import('../dist/registry/RegistryClient.js');
  const { AgentExecutor } = await import('../dist/executor/AgentExecutor.js');
  const { AIProvider } = await import('../dist/ai/AIProvider.js');

  const config = {
    apiKey: uluopsKey,
    ai: {
      providers: { anthropic: { apiKey: anthropicKey } },
      defaultProvider: 'anthropic',
    },
    registryUrl: process.env['ULUOPS_REGISTRY_URL'] ?? 'http://localhost:3001/api/v1',
    validationUrl: 'https://ops.uluops.ai/api',
    dashboardUrl: 'https://app.uluops.ai',
    localDefinitions: DEFINITIONS_DIR,
    trackingEnabled: false,
    hashVerificationEnabled: false,
    timeout: 120000,
  };

  // Mock catalog (skip registry for model resolution)
  const mockCatalog = {
    resolve: async (alias: string) => {
      const modelId = alias === 'haiku'
        ? 'claude-haiku-4-5-20251001'
        : alias === 'sonnet'
          ? 'claude-sonnet-4-5-20250929'
          : alias === 'opus'
            ? 'claude-opus-4-6'
            : alias;
      return {
        provider: 'anthropic',
        modelId,
        providerModelId: modelId,
        tier: alias === 'opus' ? 'premium' : alias === 'haiku' ? 'fast' : 'standard',
        capabilities: { tools: true, vision: true, streaming: true, extendedThinking: false },
        resolvedFrom: alias,
      };
    },
    refresh: async () => {},
  };

  const registry = new RegistryClient(config);
  const aiProvider = new AIProvider(config, mockCatalog);
  const executor = new AgentExecutor(config, aiProvider);

  // Resolve a small, fast agent
  console.log('Resolving code-validator agent...');
  const resolved = await registry.resolve('code-validator', undefined, 'agent');
  console.log(`  Resolved: ${resolved.name} v${resolved.version}`);

  // Execute against SDK src (small codebase)
  console.log(`\nExecuting against: ${TARGET_DIR}`);
  console.log('  Using model: haiku (for speed)');
  console.log('  This will take 30-60 seconds...\n');

  const start = Date.now();
  const result = await executor.execute(
    resolved,
    { target: TARGET_DIR },
    { model: 'haiku', maxTokens: 8192, timeoutMs: 120000 },
  );
  const elapsed = Date.now() - start;

  console.log(`  Result type: ${result.type}`);
  console.log(`  Agent type: ${result.agentType}`);
  console.log(`  Decision: ${result.decision}`);
  if (result.agentType === 'validator') {
    console.log(`  Score: ${result.score}/${result.maxScore}`);
    console.log(`  Categories: ${result.categories?.length ?? 0}`);
    if (result.categories) {
      for (const cat of result.categories) {
        console.log(`    - ${cat.name}: ${cat.score}/${cat.maxScore}`);
      }
    }
  }
  console.log(`  Recommendations: ${result.recommendations.length}`);
  for (const rec of result.recommendations.slice(0, 3)) {
    console.log(`    - [${rec.priority}] ${rec.title}`);
  }
  console.log(`  Duration: ${elapsed}ms`);
  console.log(`  Tokens: in=${result.metrics.inputTokens}, out=${result.metrics.outputTokens}`);
  console.log(`  Model: ${result.metrics.model}`);

  console.log('\n✓ Layer 3 PASSED');
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== @uluops/core Smoke Test ===');
  console.log(`Definitions: ${DEFINITIONS_DIR}`);
  console.log(`Target: ${TARGET_DIR}`);

  const results: Record<string, string> = {};

  try {
    // Layer 1
    const resolved = await testLocalResolution();
    results['Layer 1 (Local Resolution)'] = resolved ? '✓ PASS' : '⊘ SKIP';

    // Layer 2
    const aiOk = await testAIConnectivity();
    results['Layer 2 (AI Connectivity)'] = aiOk ? '✓ PASS' : '⊘ SKIP';

    // Layer 3
    if (resolved && aiOk) {
      const fullOk = await testFullExecution();
      results['Layer 3 (Full Execution)'] = fullOk ? '✓ PASS' : '⊘ SKIP';
    } else {
      results['Layer 3 (Full Execution)'] = '⊘ SKIP (deps failed)';
    }

    console.log('\n=== Summary ===');
    for (const [name, status] of Object.entries(results)) {
      console.log(`  ${name}: ${status}`);
    }
  } catch (err) {
    console.error('\n✗ FAILED:', err);
    process.exit(1);
  }
}

main();
