import { describe, it, expect } from 'vitest';
import { zodSchema } from '@ai-sdk/provider-utils';
import { agentOutputSchema } from '../../src/parser/outputSchemas.js';

/**
 * ANTHROPIC UNION-PARAMETER BUDGET.
 *
 * Anthropic's tool-schema compiler rejects a schema with more than 16 union-typed
 * parameters, with HTTP 400 *before the model runs*:
 *
 *   "Schemas contains too many parameters with union types (29 parameters with type
 *    arrays or anyOf). This causes exponential compilation cost. Reduce the number of
 *    nullable or union-typed parameters (limit: 16 parameters with unions)."
 *
 * Zod renders every `.nullable()` as a JSON-Schema union, so the count is a direct
 * function of how many nullable fields the schema carries. OpenAI accepts the same
 * schema, which is why this was invisible until a live Anthropic run.
 *
 * This converts the schema through the SAME path the AI SDK uses to build the request,
 * so the number here is the number Anthropic sees — not an approximation. It reproduced
 * 29 exactly, matching the provider's own error text.
 */
const ANTHROPIC_UNION_LIMIT = 16;

function countUnionNodes(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  const n = node as Record<string, unknown>;
  let count = 0;
  if (Array.isArray(n.type) && n.type.length > 1) count++;
  if (Array.isArray(n.anyOf) || Array.isArray(n.oneOf)) count++;
  for (const key of Object.keys(n)) count += countUnionNodes(n[key]);
  return count;
}

describe('agentOutputSchema union budget', () => {
  it('stays under Anthropic’s union-parameter limit', () => {
    const jsonSchema = zodSchema(agentOutputSchema).jsonSchema;
    const unions = countUnionNodes(jsonSchema);
    expect(unions).toBeLessThan(ANTHROPIC_UNION_LIMIT);
  });

  it('the counter is not vacuous — it finds unions in a schema that has them', () => {
    // Positive control: a hand-built schema with a known union count. Without this,
    // a counter that always returned 0 would satisfy the assertion above.
    const withUnions = { properties: { a: { type: ['string', 'null'] }, b: { anyOf: [{}, {}] } } };
    expect(countUnionNodes(withUnions)).toBe(2);
    expect(countUnionNodes({ properties: { a: { type: 'string' } } })).toBe(0);
  });
});
