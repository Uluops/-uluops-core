/**
 * Step templates: how a run parameter reaches a step's shell (PDL 1.6.0, build unit P3a).
 *
 * Normative source: `uluops-pdl-spec-v1.6.0.md`, Execution Semantics → Steps → Templates in step
 * commands (design spec decisions D15, D20, D38, D39). The conformance fixtures
 * (`test/fixtures/pdl-conformance/`, `steps/*` and `load-errors/placement-*`) are the oracle.
 *
 * Before 1.6.0 core shell-quoted each value into the command (`'value'`). Every corpus site writes
 * the template inside double quotes (`"{{ params.x }}"`), where the single quotes are literal
 * characters, so detectors looked for a file whose name began with a quote, and `$(…)` in a value
 * executed (tracker 2595e1a8; fixture `steps/template-value-with-shell-syntax`). Now:
 *
 * - **Placement (load time).** A template is the whole of a double-quoted word or a whole bare
 *   word, outside single quotes, `$(…)`, backticks, process substitution and heredocs, and not the
 *   command's first word. Anything else is `template_placement`.
 * - **Environment reference.** Core replaces `"{{ params.x }}"` and a bare `{{ params.x }}` with
 *   `"${ULU_P_X}"` and passes the value in the step's environment. The shell expands the variable
 *   inside double quotes without re-parsing it, so a value is data whatever it holds.
 * - **Collisions.** Two declared parameters with the same `ULU_P_<NAME>` are `parameter_env_collision`.
 * - **NUL.** A parameter value containing NUL is refused before launch, `PARAM_NUL`. An environment
 *   value cannot hold NUL, and a truncated value would be a different value.
 *
 * `misplacedTemplate` is a port of the factory's scan (`@uluops/definition-factory`,
 * `src/parser/pdl-load-rules.ts`). Both are held to the same `load-errors/placement-*` fixtures; a
 * fix to one is a fix to the other. P3b's load validator calls the two load checks here.
 */

import type { ExecutionInput } from '../types/execution.js';

/** The `ULU_P_<NAME>` variable a parameter's value is passed in. */
export function parameterEnvName(name: string): string {
  return 'ULU_P_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** A 1.6.0 step template: `{{ params.<name> }}`. The `|| fallback` form is not one (spec). */
export const PARAM_TEMPLATE = /\{\{\s*params\.([A-Za-z][\w-]*)\s*\}\}/g;
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** One nesting level of the placement scan, with its own double-quote state. */
interface Frame {
  kind: 'top' | 'subst' | 'proc' | 'backtick' | 'paren';
  double: boolean;
  openedAt: number;
}

/**
 * The placement rule (D15, D38, D39). Returns the first misplaced `{{ params.<name> }}` template,
 * or undefined when every placement is allowed. Errs toward refusal: a `<<` before a template, or a
 * `case` inside a nested level, refuses it. Command position is checked for the first word only;
 * after `;`, `&&`, `|` or a newline it is the spec's stated residual.
 */
export function misplacedTemplate(command: string): string | undefined {
  const stack: Frame[] = [{ kind: 'top', double: false, openedAt: -1 }];
  let single = false, heredoc = false, uncertain = false;
  let pos = 0;
  const open = (kind: Frame['kind']): void => { stack.push({ kind, double: false, openedAt: -1 }); };
  // A plain subshell `( … )` is not a forbidden context; the levels whose text a nested shell runs are.
  const inForbidden = (): boolean => stack.some(fr => fr.kind === 'subst' || fr.kind === 'proc' || fr.kind === 'backtick');
  const advance = (to: number): void => {
    for (; pos < to; pos++) {
      const c = command[pos]!, next = command[pos + 1];
      const f = stack[stack.length - 1]!;
      if (single) { if (c === "'") single = false; continue; }
      if (c === '\\') { pos++; continue; }
      if (c === '$' && next === '(') { open('subst'); pos++; continue; }
      if (c === '`') { if (f.kind === 'backtick') stack.pop(); else open('backtick'); continue; }
      if (f.double) { if (c === '"') f.double = false; continue; }
      if (c === '"') { f.double = true; f.openedAt = pos; }
      else if (c === "'") single = true;
      else if ((c === '<' || c === '>') && next === '(') { open('proc'); pos++; }
      else if (c === '(') open('paren');
      else if (c === ')' && f.kind !== 'top' && f.kind !== 'backtick') stack.pop();
      else if (c === '<' && next === '<') heredoc = true;
      else if (inForbidden() && /^case\s/.test(command.slice(pos, pos + 5)) && /^$|[\s;&|(]/.test(command[pos - 1] ?? '')) uncertain = true;
    }
  };
  const lead = command.length - command.trimStart().length;
  for (const m of command.matchAll(PARAM_TEMPLATE)) {
    const start = m.index, end = start + m[0].length;
    advance(start);
    const f = stack[stack.length - 1]!;
    const nested = inForbidden() || single || heredoc || uncertain;
    const quoted = f.double && f.openedAt === start - 1 && isSpace(command[start - 2]) && command[end] === '"';
    const bare = !f.double && isSpace(command[start - 1]) && isSpace(command[end]);
    const first = (quoted ? start - 1 : start) === lead;
    if (nested || first || !(quoted || bare)) return m[0];
    pos = end; // the template holds no quote or shell metacharacter; skip it
  }
  return undefined;
}

/** A load error the step-template rules report, in the conformance fixtures' shape. */
export interface StepTemplateLoadError {
  code: 'template_placement' | 'parameter_env_collision';
  /** `stage:<id>/step:<name>` or `param:<name>` (fixtures README, Expected format). */
  at: string;
  message: string;
}

interface StageLike { id?: unknown; steps?: Array<{ name?: unknown; command?: unknown }> }
interface PipelineLike { stages?: StageLike[]; triggers?: Array<{ parameters?: Array<{ name?: unknown }> }> }

/**
 * The two load errors this module owns: misplaced templates in step commands, and parameters whose
 * environment names collide. Reads the definition defensively; it may be registry YAML with no
 * runtime schema behind it.
 */
export function checkStepTemplateRules(pipeline: PipelineLike): StepTemplateLoadError[] {
  const errors: StepTemplateLoadError[] = [];
  const seen = new Set<string>();
  const envNames = new Map<string, string>();
  for (const trigger of pipeline.triggers ?? []) {
    for (const param of trigger?.parameters ?? []) {
      if (typeof param?.name !== 'string' || seen.has(param.name)) continue;
      seen.add(param.name);
      const env = parameterEnvName(param.name);
      const prior = envNames.get(env);
      if (prior !== undefined) {
        errors.push({ code: 'parameter_env_collision', at: `param:${param.name}`, message: `Parameters "${prior}" and "${param.name}" both map to ${env}` });
      } else envNames.set(env, param.name);
    }
  }
  for (const stage of pipeline.stages ?? []) {
    for (const step of stage?.steps ?? []) {
      if (typeof step?.command !== 'string') continue;
      const bad = misplacedTemplate(step.command);
      if (bad) {
        errors.push({
          code: 'template_placement',
          at: `stage:${String(stage.id)}/step:${String(step.name)}`,
          message: `Step "${String(step.name)}" in stage "${String(stage.id)}": ${bad} must be a whole double-quoted string or a whole bare word, not the command's first word, and outside single quotes, $(…), backticks, process substitution and heredocs`,
        });
      }
    }
  }
  return errors;
}

/** The first run parameter whose value holds NUL, or undefined. */
export function nulParameter(params: ExecutionInput['params']): string | undefined {
  for (const [name, value] of Object.entries(params ?? {})) {
    if (String(value).includes('\0')) return name;
  }
  return undefined;
}

/** Matches any `{{ … }}` span. Star-height 1 for safe-regex2; exported for its regex-safety test. */
export const TEMPLATE_RE = /\{\{([^}]*)\}\}/g;
const PARAM_NAME_RE = /^params\.([A-Za-z_][\w-]*)$/;

export type SubstitutedStep =
  | { command: string; env: Record<string, string> }
  | { unresolved: string }
  | { misplaced: string };

/**
 * Rewrite a step command's templates as environment references, and return the variables to pass.
 *
 * `params` is the run's parameters with `target` already set to the absolute, resolved target. A
 * `"{{ params.x }}"` word becomes `"${ULU_P_X}"`, and so does a bare `{{ params.x }}`: one quoted
 * word either way, so a value is never split or re-parsed. `{{ params.x || fallback }}` is not a
 * 1.6.0 template; core still accepts it, with the fallback used when `x` has no value, and passes
 * it the same way. Any other `{{ … }}` is unresolved and fails the step, as before 1.6.0.
 */
export function substituteStepTemplates(command: string, params: Record<string, unknown>): SubstitutedStep {
  const misplaced = misplacedTemplate(command);
  if (misplaced) return { misplaced };
  const env: Record<string, string> = {};
  let unresolved: string | undefined;
  const substituted = command.replace(TEMPLATE_RE, (whole, innerRaw: string, offset: number) => {
    const inner = innerRaw.trim();
    const sep = inner.indexOf('||');
    const pathPart = (sep < 0 ? inner : inner.slice(0, sep)).trim();
    const fallbackPart = sep < 0 ? undefined : inner.slice(sep + 2).trim();
    const nameMatch = PARAM_NAME_RE.exec(pathPart);
    if (!nameMatch) {
      unresolved ??= whole;
      return whole;
    }
    let value = params[nameMatch[1]!];
    if (value === undefined && fallbackPart !== undefined) {
      const quoted = /^(['"])(.*)\1$/.exec(fallbackPart);
      value = quoted ? quoted[2] : fallbackPart;
    }
    if (value === undefined) {
      unresolved ??= whole;
      return whole;
    }
    const name = parameterEnvName(nameMatch[1]!);
    env[name] = String(value);
    // Inside the author's double quotes the reference is already one word; a bare template gets
    // its own quotes. Either way the shell expands it once and never re-parses the value.
    const inQuotes = command[offset - 1] === '"' && command[offset + whole.length] === '"';
    return inQuotes ? `\${${name}}` : `"\${${name}}"`;
  });
  if (unresolved) return { unresolved };
  if (/\{\{.*\}\}/.test(substituted)) {
    return { unresolved: substituted.match(/\{\{.*?\}\}/)?.[0] ?? '{{…}}' };
  }
  return { command: substituted, env };
}
