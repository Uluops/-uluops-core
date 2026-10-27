/**
 * The `./types` entry point is a deliberate SUBSET of `.` (types only, for tree-shaking; README
 * "Type-only imports"). Two properties keep it usable, and both drifted before 0.53.0
 * (consumer-validate, public-interface-validator):
 *
 * 1. Subset: every name `./types` exports is also exported from `.`. `GateDefinition` was
 *    `./types`-only, so a consumer importing from the root could not name `StageDefinition.gate`.
 * 2. Closure for the pipeline and cost surface: `./types` exports `StageDefinition`,
 *    `StageResult` and `ExecutionMetrics`, whose fields are typed `StepDefinition[]`,
 *    `StepResult[]` and `CostBasis`. Without those, a `./types`-only consumer cannot annotate the
 *    fields of types the subpath hands them.
 *
 * Names are read from the source export lists (`export { … }` / `export type { … }` blocks), the
 * same text tsc emits into dist/index.d.ts and dist/types/index.d.ts. Control: on 0.52.0's export
 * lists both describes fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const exported = (rel: string): Set<string> => {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const out = new Set<string>();
  for (const block of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of block[1]!.split(',')) {
      const name = raw.replace(/\/\/.*$/gm, '').trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (name) out.add(name);
    }
  }
  return out;
};

const root = exported('../src/index.ts');
const types = exported('../src/types/index.ts');

describe('./types is a subset of .', () => {
  it('reads both export lists (the check is not vacuous)', () => {
    expect(root.size).toBeGreaterThan(100);
    expect(types.size).toBeGreaterThan(50);
  });
  it('exports nothing from ./types that . does not', () => {
    expect([...types].filter(n => !root.has(n))).toEqual([]);
  });
});

describe('./types closes over the field types of what it exports', () => {
  it.each([
    ['StepDefinition', 'StageDefinition.steps'],
    ['StepResult', 'StageResult.steps'],
    ['CostBasis', 'ExecutionMetrics.costBasis'],
    ['GateDefinition', 'StageDefinition.gate'],
    // PDL 1.6.0 (P4a, P4b): named in the CHANGELOG as new exports and, until the 0.54.0 Verdaccio
    // check, exported from neither entry point.
    ['StageOutcome', 'StageResult.outcome'],
    ['GateMode', 'StageResult.gateMode'],
    ['ErroredReason', 'StageResult.erroredReasons'],
    ['PipelineWarning', 'PipelineResult.warnings'],
    ['AgentVerdictRecord', 'AgentResult.verdict'],
    ['DecisionClass', 'AgentVerdictRecord.class'],
    ['VerdictWarning', 'AgentVerdictRecord.warnings'],
  ])('%s (for %s) is exported from both entry points', name => {
    expect(types.has(name)).toBe(true);
    expect(root.has(name)).toBe(true);
  });
});
