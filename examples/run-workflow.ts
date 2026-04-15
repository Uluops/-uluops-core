/**
 * Run a DAG-based workflow with parallel phase execution.
 *
 * Prerequisites:
 *   export ULUOPS_API_KEY=ulr_your_key
 *   export ANTHROPIC_API_KEY=your_key
 *
 * Usage:
 *   npx tsx examples/run-workflow.ts ./src
 */
import { UluOpsClient } from '@uluops/core';

const target = process.argv[2] ?? './src';

const client = new UluOpsClient({
  apiKey: process.env.ULUOPS_API_KEY!,
});

const result = await client.runWorkflow('post-implementation', { target });

console.log(`Workflow: ${result.decision} (score: ${result.score})`);
console.log();

for (const phase of result.phases) {
  const icon = phase.decision === 'passed' ? '+' : phase.decision === 'blocked' ? 'x' : '~';
  console.log(`  [${icon}] ${phase.name}: ${phase.decision} (${phase.score})`);
}

console.log();
const m = result.metrics;
console.log(`Phases: ${m.phasesExecuted} executed, ${m.phasesPassed} passed, ${m.phasesBlocked} blocked, ${m.phasesAborted} aborted`);
