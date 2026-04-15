/**
 * Run a single agent against a target directory.
 *
 * Prerequisites:
 *   export ULUOPS_API_KEY=ulr_your_key
 *   export ANTHROPIC_API_KEY=your_key
 *
 * Usage:
 *   npx tsx examples/run-agent.ts ./src
 */
import { UluOpsClient, STARTER_DEFINITIONS_DIR } from '@uluops/core';

const target = process.argv[2] ?? './src';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
  localDefinitions: STARTER_DEFINITIONS_DIR,
});

const result = await client.runAgent('code-validator', target, {
  model: 'sonnet',
  thresholds: { pass: 80, warn: 60 },
});

console.log(`Agent:    ${result.name} v${result.version}`);
console.log(`Decision: ${result.decision}`);
console.log(`Score:    ${result.score}`);
console.log(`Duration: ${result.durationMs}ms`);
console.log(`Recommendations (${result.recommendations.length}):`);
for (const rec of result.recommendations.slice(0, 5)) {
  console.log(`  - [${rec.severity}] ${rec.title} ${rec.filePath ?? ''}`);
}
