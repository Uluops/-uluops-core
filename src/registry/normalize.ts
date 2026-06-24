/**
 * Definition normalization — authoring (UDL YAML) → runtime shape.
 *
 * Transforms the ergonomic UDL authoring format into the structure the
 * executors expect at runtime (e.g. WDL `steps[]` → `commands[]`/`agentRefs[]`,
 * CDL `invokes.agent` → `agents[]`, PDL stage-type inference).
 *
 * ── WHY THIS LIVES HERE (and is not imported) ──────────────────────────────
 * The canonical implementation is `@uluops/definition-factory`
 * (`src/normalization/`). That package is **private IP** (rendering engine,
 * Nunjucks templates, scoring/translation) and MUST NOT become a dependency of
 * `@uluops/core`, which publishes publicly to npm — a dep edge would force the
 * factory (or its install tree) public.
 *
 * Remote resolution normalizes server-side (the registry API runs the factory).
 * This is the LOCAL/offline resolution path: without it, locally-resolved
 * workflows hand un-normalized `steps[]` to WorkflowExecutor, whose
 * `phase.commands.map()` throws → every phase BLOCKs (silent score-0 run).
 *
 * This file is a FAITHFUL PORT of the factory's normalization module —
 * intentionally a near-verbatim copy so the two can be diffed for drift. The
 * only transforms exposed publicly here are the mundane authoring→runtime field
 * mappings; none of the factory's IP (templates/rendering/scoring) is involved.
 * Keep in sync with `packages/-uluops-definition-factory/src/normalization/`.
 *
 * Pure functions — every function returns a new object and never mutates input.
 */

export type DefinitionTopKey = 'agent' | 'command' | 'workflow' | 'pipeline';

export interface NormalizeResult {
  topKey: DefinitionTopKey;
  definition: Record<string, unknown>;
}

/** Thrown when a definition has no known top key or a malformed required section. */
export class DefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionValidationError';
  }
}

const KNOWN_TOP_KEYS: readonly DefinitionTopKey[] = ['agent', 'command', 'workflow', 'pipeline'];

/**
 * CDL YAML → runtime shape: `invokes.agent`/`invokes.agents` → `agents[]`,
 * top-level pre/postflight → `execution.*`, `overrides.threshold` →
 * `execution.thresholds.pass`.
 */
export function normalizeCommandSection(section: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(section);

  // invokes.agent / invokes.agents → agents[]
  if (!out['agents']) {
    const invokes = out['invokes'] as Record<string, unknown> | undefined;
    if (invokes) {
      const agent = invokes['agent'];
      const agents = invokes['agents'];
      if (Array.isArray(agents)) {
        out['agents'] = agents;
      } else if (typeof agent === 'string') {
        out['agents'] = [agent];
      }
    }
  }

  // top-level preflight → execution.preflight ({ banner?, checks } → PreflightCheck[])
  const execution = (out['execution'] ?? {}) as Record<string, unknown>;
  if (out['preflight'] && !execution['preflight']) {
    const preflight = out['preflight'] as Record<string, unknown>;
    execution['preflight'] = Array.isArray(preflight['checks']) ? preflight['checks'] : preflight;
    out['execution'] = execution;
  }

  // top-level postflight → execution.postflight
  if (out['postflight'] && !execution['postflight']) {
    execution['postflight'] = out['postflight'];
    out['execution'] = execution;
  }

  // overrides.threshold → execution.thresholds.pass
  const overrides = out['overrides'] as Record<string, unknown> | undefined;
  if (overrides?.['threshold'] && !execution['thresholds']) {
    execution['thresholds'] = { pass: overrides['threshold'] };
    out['execution'] = execution;
  }

  return out;
}

/**
 * WDL YAML → runtime shape: `steps[].command` → `commands[]`,
 * `steps[].agent` → `agentRefs[]`, `condition` → negated `skip_if`,
 * default `gate.aggregate` to `'average'`.
 */
export function normalizeWorkflowSection(section: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(section);

  const orchestration = out['orchestration'] as Record<string, unknown> | undefined;
  if (!orchestration) return out;

  const phases = orchestration['phases'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(phases)) return out;

  for (const phase of phases) {
    // steps[].command → commands[], steps[].agent → agentRefs[]
    if (!phase['commands'] && Array.isArray(phase['steps'])) {
      const steps = phase['steps'] as Array<Record<string, unknown>>;
      phase['commands'] = steps
        .map(s => s['command'] as string)
        .filter(Boolean);
      const agents = steps
        .map(s => s['agent'] as string)
        .filter(Boolean);
      if (agents.length > 0) {
        phase['agentRefs'] = agents;
      }
      delete phase['steps'];
    }

    // condition → skip_if (negated: "run when true" → "skip when NOT true")
    if (phase['condition'] && !phase['skip_if']) {
      phase['skip_if'] = `NOT (${phase['condition']})`;
      delete phase['condition'];
    }

    // Ensure gate.aggregate has a default
    const gate = phase['gate'] as Record<string, unknown> | undefined;
    if (gate && !gate['aggregate']) {
      gate['aggregate'] = 'average';
    }
  }

  return out;
}

/**
 * PDL YAML → runtime shape: infer stage `type` from structural cues
 * (`agents[]` but no ref → `'agents'`; explicit `ref` but no type → `'command'`).
 */
export function normalizePipelineSection(section: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(section);

  const stages = out['stages'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(stages)) return out;

  for (const stage of stages) {
    if (Array.isArray(stage['agents']) && !stage['ref'] && !stage['type']) {
      stage['type'] = 'agents';
    }
    if (stage['ref'] && !stage['type']) {
      stage['type'] = 'command';
    }
  }

  return out;
}

/**
 * Verify a workflow section has the nested structure WorkflowExecutor reads
 * directly (`orchestration.phases`). Catches malformed YAML that would
 * otherwise crash deep in execution.
 */
export function validateWorkflowStructure(section: Record<string, unknown>): void {
  const orchestration = section['orchestration'] as Record<string, unknown> | undefined;
  if (!orchestration || typeof orchestration !== 'object') {
    throw new DefinitionValidationError(
      'Invalid workflow definition: missing "orchestration" section',
    );
  }
  if (!Array.isArray(orchestration['phases'])) {
    throw new DefinitionValidationError(
      'Invalid workflow definition: "orchestration.phases" must be an array',
    );
  }
}

/** Verify a pipeline section has the `stages` array PipelineExecutor iterates. */
export function validatePipelineStructure(section: Record<string, unknown>): void {
  if (!Array.isArray(section['stages'])) {
    throw new DefinitionValidationError(
      'Invalid pipeline definition: "stages" must be an array',
    );
  }
}

/**
 * Detect the top-level definition key, dispatch to the type-specific normalizer,
 * and run structural validation. Returns a new object — input is never mutated.
 * Agent definitions pass through unchanged (no authoring→runtime transform).
 *
 * @throws {DefinitionValidationError} when no known top key is found or a
 *   required section is malformed.
 */
export function normalizeDefinition(parsed: Record<string, unknown>): NormalizeResult {
  const topKey = KNOWN_TOP_KEYS.find(k => k in parsed);
  if (!topKey) {
    throw new DefinitionValidationError(
      `Invalid definition: expected a top-level key of ${KNOWN_TOP_KEYS.join(', ')}, ` +
      `found: ${Object.keys(parsed).join(', ')}`,
    );
  }

  const section = parsed[topKey];
  if (typeof section !== 'object' || section === null) {
    throw new DefinitionValidationError(
      `Invalid definition: "${topKey}" must be an object`,
    );
  }

  const definition = structuredClone(parsed);

  if (topKey === 'command') {
    definition[topKey] = normalizeCommandSection(section as Record<string, unknown>);
  }

  if (topKey === 'workflow') {
    const normalized = normalizeWorkflowSection(section as Record<string, unknown>);
    validateWorkflowStructure(normalized);
    definition[topKey] = normalized;
  }

  if (topKey === 'pipeline') {
    const normalized = normalizePipelineSection(section as Record<string, unknown>);
    validatePipelineStructure(normalized);
    definition[topKey] = normalized;
  }

  return { topKey, definition };
}
