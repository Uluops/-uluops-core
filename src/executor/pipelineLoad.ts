/**
 * PDL 1.6.0 load validation for core (build unit P3b): the checks that run before any stage
 * launches, for every pipeline core executes, registry-resolved or local YAML.
 *
 * Normative source: `uluops-pdl-spec-v1.6.0.md`, Execution Semantics → Validation at load time,
 * Dependencies and ordering, Gates → Score, Strictness and declarations, Codes. Design record:
 * pdl-1_6_0 spec §3.3, §3.4, §3.6 (D2, D5, D7, D20, D25). The conformance fixtures' `load-errors/*`
 * cases are the oracle; core reports the same codes at the same locations as the factory's
 * `validatePDL` (`@uluops/definition-factory`, `src/parser/pdl-load-rules.ts`).
 *
 * Core had no load-time validator before 1.6.0. A condition was checked only when the run reached
 * it, and one it could not read made its stage run (fail-open). A stage key core did not know,
 * `condtion:` say, was ignored, so the stage ran unconditionally.
 *
 * **The runtime shape.** Core receives a pipeline after normalization (`registry/normalize.ts`,
 * and the registry API's server-side twin), which stamps `type` on every stage and hoists a single
 * workflow's `ref` onto it. Those two keys are therefore accepted on a stage here, though the
 * 1.6.0 schema does not declare them. The cost: an author who writes `type:` or `ref:` on a stage in
 * local YAML is not refused by core. The schema refuses it wherever a schema validator runs (the
 * factory, so `udl validate` and registry publish).
 */

import type { PipelineLoadError } from '../errors/index.js';
import { MAX_CONDITION_LENGTH, conditionLength, parseCondition } from './conditions.js';
import { checkStepTemplateRules } from './stepTemplates.js';

/** A load warning (spec, Codes → Load warning). */
export interface PipelineLoadWarning {
  code: 'SKIP_DEPRECATED';
  stage: string;
  message: string;
}

/** Keys the PDL 1.6.0 schema declares on a stage, plus the two normalization stamps (above). */
const STAGE_KEYS = new Set([
  'id', 'name', 'description', 'condition', 'depends_on', 'parallel', 'sequential', 'timeout',
  'workflows', 'commands', 'agents', 'steps', 'gate', 'approval', 'inputs', 'outputs', 'env',
  'artifacts', 'artifacts_from', 'forward', 'receives',
  'type', 'ref',
]);
const GATE_KEYS = new Set(['threshold', 'aggregate', 'decision', 'on_failure', 'on_success']);
const AGENT_REF_KEYS = new Set(['ref', 'condition', 'threshold', 'model', 'timeout', 'args']);

interface AgentLike { ref?: unknown; condition?: unknown; threshold?: unknown; [k: string]: unknown }
interface StageLike {
  id?: unknown;
  depends_on?: unknown;
  condition?: unknown;
  agents?: unknown;
  steps?: unknown;
  gate?: unknown;
  [k: string]: unknown;
}
interface PipelineLike {
  stages?: unknown;
  triggers?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Declared parameters: the union over every trigger. No implicit `target` (as the factory). */
function declaredParameters(pipeline: PipelineLike): Array<{ name: string; default?: unknown }> {
  const out: Array<{ name: string; default?: unknown }> = [];
  const seen = new Set<string>();
  for (const trigger of asArray<unknown>(pipeline.triggers)) {
    if (!isRecord(trigger)) continue;
    for (const p of asArray<unknown>(trigger['parameters'])) {
      if (!isRecord(p) || typeof p['name'] !== 'string' || seen.has(p['name'])) continue;
      seen.add(p['name']);
      out.push({ name: p['name'], default: p['default'] });
    }
  }
  return out;
}

/** Stages reachable from `stages[index]` by following `depends_on` transitively. Not the stage itself. */
function ancestorsOf(stages: StageLike[], index: number): Set<string> {
  const byId = new Map(stages.map(s => [s.id, s]));
  const seen = new Set<string>();
  const todo = asArray<string>(stages[index]!.depends_on).slice();
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...asArray<string>(byId.get(id)?.depends_on));
  }
  seen.delete(stages[index]!.id as string);
  return seen;
}

/**
 * One condition, in the spec's order: length, syntax, then each reference in source order through
 * root, path, declared parameter, known stage, ancestor, declared step. Returns the first fault.
 */
function conditionFault(
  condition: string, stages: StageLike[], index: number, declared: Set<string>,
): { code: string; message: string } | undefined {
  if (conditionLength(condition) > MAX_CONDITION_LENGTH) {
    return { code: 'condition_too_long', message: `condition is ${conditionLength(condition)} code points; the limit is ${MAX_CONDITION_LENGTH}` };
  }
  const parsed = parseCondition(condition);
  if (!parsed.ok) return parsed;
  const byId = new Map(stages.map(s => [s.id, s]));
  let ancestors: Set<string> | undefined;
  for (const ref of parsed.refs) {
    if (ref.kind === 'fault') return ref;
    if (ref.kind === 'param') {
      if (!declared.has(ref.name)) return { code: 'undeclared_parameter', message: `params.${ref.name} is not a declared parameter` };
      continue;
    }
    const target = byId.get(ref.stage);
    if (!target) return { code: 'unknown_stage', message: `stage "${ref.stage}" does not exist` };
    ancestors ??= ancestorsOf(stages, index);
    if (!ancestors.has(ref.stage)) {
      return { code: 'non_ancestor_reference', message: `stage "${ref.stage}" is not an ancestor of "${String(stages[index]!.id)}" (reachable through depends_on); a stage is not its own ancestor` };
    }
    if (ref.kind === 'step' && !asArray<unknown>(target.steps).some(s => isRecord(s) && s['name'] === ref.step)) {
      return { code: 'undeclared_step', message: `stage "${ref.stage}" has no step "${ref.step}"` };
    }
  }
  return undefined;
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter(k => !allowed.has(k));
}

/**
 * Validate a pipeline section (`definition.pipeline`) as core loads it. Returns every load error
 * found, each in the fixtures' shape (`code`, `at`, `message`), and the load warnings.
 *
 * Order: parameter declarations, then unique stage ids (an id map built before that check keeps the
 * last of two ids, and reports an earlier stage's dependency on the first as a forward reference:
 * review run #73), then per stage: undeclared keys, forward references, conditions (the stage's,
 * then each agent's), per-agent thresholds, step-template placement.
 */
export function checkPipelineLoadRules(pipeline: PipelineLike): { errors: PipelineLoadError[]; warnings: PipelineLoadWarning[] } {
  const warnings: PipelineLoadWarning[] = [];
  const stages = asArray<unknown>(pipeline.stages).filter(isRecord) as StageLike[];
  const templateErrors = checkStepTemplateRules(pipeline as Parameters<typeof checkStepTemplateRules>[0]);
  const errors: PipelineLoadError[] = templateErrors.filter(e => e.code === 'parameter_env_collision');

  const firstAt = new Map<string, number>();
  for (const [i, stage] of stages.entries()) {
    if (typeof stage.id !== 'string') continue;
    const prior = firstAt.get(stage.id);
    if (prior === undefined) { firstAt.set(stage.id, i); continue; }
    errors.push({ code: 'duplicate_stage_id', at: `stage:${stage.id}`, message: `Stage id "${stage.id}" is already used by stage ${prior}` });
  }
  if (errors.some(e => e.code === 'duplicate_stage_id')) return { errors, warnings };

  const declared = new Set(declaredParameters(pipeline).map(p => p.name));
  const index = new Map(stages.map((s, i) => [s.id, i]));
  for (const [i, stage] of stages.entries()) {
    const sid = String(stage.id);
    const at = `stage:${sid}`;

    // Closed objects (D7). `skip_if` is an undeclared key (D25).
    for (const key of unknownKeys(stage, STAGE_KEYS)) {
      errors.push({ code: 'unknown_key', at, message: `Stage "${sid}" has an undeclared key "${key}"` });
    }
    if (isRecord(stage.gate)) {
      for (const key of unknownKeys(stage.gate, GATE_KEYS)) {
        errors.push({ code: 'unknown_key', at, message: `The gate of stage "${sid}" has an undeclared key "${key}"` });
      }
    }
    const agents = asArray<unknown>(stage.agents).filter(isRecord) as AgentLike[];
    for (const agent of agents) {
      for (const key of unknownKeys(agent, AGENT_REF_KEYS)) {
        errors.push({ code: 'unknown_key', at: `${at}/agent:${String(agent.ref)}`, message: `Agent "${String(agent.ref)}" in stage "${sid}" has an undeclared key "${key}"` });
      }
    }

    for (const dep of asArray<unknown>(stage.depends_on)) {
      const depAt = index.get(dep);
      if (depAt !== undefined && depAt >= i) {
        errors.push({ code: 'forward_reference', at, message: `Stage "${sid}" depends on "${String(dep)}", which is not declared before it; stages run in array order` });
      }
    }

    if (typeof stage.condition === 'string') {
      const f = conditionFault(stage.condition, stages, i, declared);
      if (f) errors.push({ code: f.code, at, message: `Stage "${sid}" condition: ${f.message}` });
    }
    for (const agent of agents) {
      if (typeof agent.condition !== 'string') continue;
      const f = conditionFault(agent.condition, stages, i, declared);
      if (f) errors.push({ code: f.code, at: `${at}/agent:${String(agent.ref)}`, message: `Agent "${String(agent.ref)}" in stage "${sid}" condition: ${f.message}` });
    }

    // Per-agent thresholds (D5). Their gate semantics are stageGate.ts's; the load errors are here.
    const gate = isRecord(stage.gate) ? stage.gate : undefined;
    if (agents.some(a => a.threshold !== undefined)) {
      if (gate?.['aggregate'] !== undefined) {
        errors.push({ code: 'aggregate_with_per_agent', at, message: `Stage "${sid}" has per-agent thresholds, so gate.aggregate does not apply` });
      }
      if (gate?.['threshold'] === undefined) {
        for (const agent of agents) {
          if (agent.threshold === undefined) {
            errors.push({ code: 'missing_threshold', at: `${at}/agent:${String(agent.ref)}`, message: `Agent "${String(agent.ref)}" in stage "${sid}" has no threshold, and the gate has none to fall back to` });
          }
        }
      }
    }

    errors.push(...templateErrors.filter(e => e.code === 'template_placement' && e.at.startsWith(`${at}/step:`)));

    if (gate?.['on_failure'] === 'skip') {
      warnings.push({ code: 'SKIP_DEPRECATED', stage: sid, message: `Stage "${sid}": on_failure: skip is a deprecated alias of fail` });
    }
  }

  return { errors, warnings };
}

/**
 * Stages whose own condition, or an agent's, reads step output (`stages.<id>.steps[...]`). With
 * steps disabled, core refuses such a run before launch (`STEP_OUTPUT_STEPS_DISABLED`). Call after
 * load validation passes; a condition that does not parse reads nothing.
 */
export function stagesReadingStepOutput(pipeline: PipelineLike): string[] {
  const out: string[] = [];
  for (const stage of asArray<unknown>(pipeline.stages).filter(isRecord) as StageLike[]) {
    const conditions = [stage.condition, ...asArray<unknown>(stage.agents).filter(isRecord).map(a => a['condition'])];
    const reads = conditions.some(c => {
      if (typeof c !== 'string') return false;
      const parsed = parseCondition(c);
      return parsed.ok && parsed.refs.some(r => r.kind === 'step');
    });
    if (reads) out.push(String(stage.id));
  }
  return out;
}

/**
 * The parameters a condition reads: the caller's, with each declared default bound where the caller
 * gave no value (spec, Context: "Declared defaults are bound first"). `target` is bound to the run's
 * target when the caller did not pass it as a parameter.
 */
export function bindParameterDefaults(
  pipeline: PipelineLike,
  params: Readonly<Record<string, string | number | boolean>> | undefined,
  target: string | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { ...(params ?? {}) };
  for (const p of declaredParameters(pipeline)) {
    const d = p.default;
    if (Object.hasOwn(out, p.name) || d === undefined || d === null) continue;
    if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') out[p.name] = d;
  }
  if (!Object.hasOwn(out, 'target') && target !== undefined) out['target'] = target;
  return out;
}
