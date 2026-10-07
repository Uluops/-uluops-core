/**
 * Randomized differential fuzzer for executor stop-verdict semantics (aborted-agent-recording
 * spec v0.5.1 §15: OD-12 crash decides, OD-13 failure beats cancel, OD-14 finished keeps verdict,
 * OD-15 a phase whose every step crashed is not softened by on_failure: warn, OD-16 "stopped"
 * means a stop REACHED something). Built by the code-auditor in tracker run #114 (the run #113
 * fuzzer lived only in that agent's context and was lost); kept in the suite since then. The
 * report test FAILS on any oracle mismatch except the known, deferred [fcancel] class (a foreign
 * CANCELLED laundered by a same-microtask stop at the step/stage layer — run #114 F4).
 * Mutation record: reverting OD-14, OD-15, OD-16, the eligibility-first halt order, the D1
 * empty-phase guard, OD-13, or the deadline classification each fails it.
 *
 * Real CommandExecutor / WorkflowExecutor / PipelineExecutor over a mocked AgentExecutor and
 * registry. Every stop is fired from INSIDE a chosen agent's execution (no timers), and agents
 * that wait on a stop that never comes are released at quiescence (setImmediate with no
 * progress), so every case replays exactly from its seed.
 *
 * The oracle takes only scheduling FACTS from the run (which agents were called, how each
 * settled, whether/when the stop fired, and which phases the code says were kept from starting —
 * the latter consistency-checked) and derives every verdict from the rules.
 *
 * Env:
 *   FUZZ_WF=20000 FUZZ_PL=4000 FUZZ_SEED0=1   case counts and first seed
 *   FUZZ_ONLY_UNSTOPPED=1                      run only stop:none cases (for the main@fdb33b3 differential)
 *   FUZZ_OUT=<dir>                             write unstopped.jsonl + summary.json there
 *   FUZZ_CASE=wf:<seed> | pl:<seed>            replay one case verbosely
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PipelineExecutor } from '../../src/executor/PipelineExecutor.js';
import { WorkflowExecutor } from '../../src/executor/WorkflowExecutor.js';
import { CommandExecutor } from '../../src/executor/CommandExecutor.js';
import { CancelledError, ProviderCreditError, TimeoutError } from '../../src/errors/index.js';
import { tripRunFor } from '../../src/utils/runTrip.js';

// ─── PRNG ────────────────────────────────────────────────────────────────────────────────────
class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed * 2654435761) >>> 0; this.next(); this.next(); }
  next(): number { // mulberry32
    let t = (this.s = (this.s + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
  weighted<T extends string>(w: Record<T, number>): T {
    const entries = Object.entries(w) as [T, number][];
    let r = this.next() * entries.reduce((s, [, v]) => s + v, 0);
    for (const [k, v] of entries) { if ((r -= v) < 0) return k; }
    return entries[entries.length - 1]![0];
  }
}

// ─── Spec ────────────────────────────────────────────────────────────────────────────────────
type Cat = 'positive' | 'conditional' | 'negative' | 'neutral';
type Beh = 'pass' | 'mid' | 'low' | 'lens' | 'sless' | 'slessneg' | 'boom' | 'tmo' | 'wait'
  | 'trigWait' | 'trigFinish' | 'trigBoom' | 'credit' | 'fcancel';
type StopMode = 'none' | 'abort' | 'deadline' | 'cancel' | 'credit';
interface AgentSpec { name: string; beh: Beh }
type CmdStep =
  | { kind: 'cmd1'; name: string; agent: AgentSpec }
  | { kind: 'cmdN'; name: string; agents: AgentSpec[]; sequential: boolean; pass: number; warn: number; method: 'average' | 'min' | 'max' | 'sum' };
type StepSpec = CmdStep | { kind: 'agentRef'; agent: AgentSpec };
interface PhaseGate { threshold: number; aggregate: 'average' | 'min' | 'max'; on_fail: 'abort' | 'stop' | 'warn' }
interface PhaseSpec { id: string; steps: StepSpec[]; parallel: boolean; gate?: PhaseGate; depends_on?: string[]; skip_if?: string }
interface WfSpec { name: string; phases: PhaseSpec[]; on_failure: 'continue' | 'warn' | 'stop' | 'abort'; max_parallel?: number; vocab?: { SHIP: string; HOLD: string; BLOCK: string } }
interface StageGate { on_failure?: 'abort' | 'warn' | 'skip'; threshold?: number; aggregate?: 'min' | 'average' | 'max'; on_success?: 'skip_remaining' }
type StageSpec = { id: string; gate?: StageGate; depends_on?: string[] } & (
  | { kind: 'agents'; agents: AgentSpec[] }
  | { kind: 'command'; step: CmdStep }
  | { kind: 'workflow'; wf: WfSpec }
  | { kind: 'steps' });
interface WfCase { seed: number; wf: WfSpec; options: Record<string, boolean>; stop: StopMode; layout: boolean }
interface PlCase { seed: number; stages: StageSpec[]; options: Record<string, boolean>; stop: StopMode }

const RES: Record<string, { score: number | null; decision: string; cat: Cat }> = {
  pass: { score: 90, decision: 'PASS', cat: 'positive' },
  mid: { score: 60, decision: 'WARN', cat: 'conditional' },
  low: { score: 20, decision: 'FAIL', cat: 'negative' },
  lens: { score: 82, decision: 'DISORDERED', cat: 'negative' },
  sless: { score: null, decision: 'COMPLETE', cat: 'positive' },
  slessneg: { score: null, decision: 'FAILED', cat: 'negative' },
};

// ─── Generator ───────────────────────────────────────────────────────────────────────────────
class Gen {
  n = 0; agents: AgentSpec[] = []; cmds = 0; wfs = 0;
  constructor(public r: Rng) {}
  agent(): AgentSpec {
    const beh = this.r.weighted<Beh>({ pass: 30, mid: 9, low: 11, lens: 7, sless: 5, slessneg: 5, boom: 10, tmo: 3, fcancel: 2, wait: 14 } as Record<Beh, number>);
    const a = { name: `a${this.n++}`, beh };
    this.agents.push(a);
    return a;
  }
  cmdStep(): CmdStep {
    const r = this.r;
    if (r.chance(0.62)) return { kind: 'cmd1', name: `c${this.cmds++}`, agent: this.agent() };
    const t = r.pick([{ pass: 75, warn: 50 }, { pass: 60, warn: 40 }, { pass: 85, warn: 70 }, { pass: 150, warn: 100 }]);
    return { kind: 'cmdN', name: `c${this.cmds++}`, agents: Array.from({ length: 2 + r.int(2) }, () => this.agent()), sequential: r.chance(0.5), ...t, method: r.pick(['average', 'average', 'min', 'max', 'sum'] as const) };
  }
  phase(i: number, prior: string[], layout: boolean): PhaseSpec {
    const r = this.r;
    const nSteps = r.chance(0.04) ? 0 : 1 + r.int(3);
    const steps: StepSpec[] = [];
    for (let k = 0; k < nSteps; k++) steps.push(r.chance(0.14) ? { kind: 'agentRef', agent: this.agent() } : this.cmdStep());
    // executePhase runs command refs first, then agentRefs: keep authored order consistent with that.
    steps.sort((a, b) => Number(a.kind === 'agentRef') - Number(b.kind === 'agentRef'));
    const p: PhaseSpec = { id: `p${i}`, steps, parallel: r.chance(0.5) };
    if (r.chance(0.7)) p.gate = { threshold: r.pick([0, 50, 70, 80]), aggregate: r.pick(['average', 'min', 'max'] as const), on_fail: r.pick(['abort', 'stop', 'warn'] as const) };
    if (!layout && prior.length && r.chance(0.25)) p.depends_on = [...new Set([r.pick(prior), ...(r.chance(0.3) ? [r.pick(prior)] : [])])];
    if (!layout && r.chance(0.08)) p.skip_if = `k${i}`;
    return p;
  }
  workflow(maxPhases: number, layout: boolean): WfSpec {
    const r = this.r;
    const n = 1 + r.int(maxPhases);
    const phases: PhaseSpec[] = [];
    for (let i = 0; i < n; i++) phases.push(this.phase(i, phases.map(p => p.id), layout));
    const wf: WfSpec = {
      name: `w${this.wfs++}`, phases,
      on_failure: layout ? r.pick(['continue', 'warn'] as const) : r.pick(['continue', 'warn', 'stop', 'abort'] as const),
    };
    if (layout) { if (n > 1) wf.max_parallel = 1; }
    else if (r.chance(0.3)) wf.max_parallel = r.pick([1, 2]);
    if (r.chance(0.3)) wf.vocab = r.pick([{ SHIP: 'GO', HOLD: 'WAIT', BLOCK: 'STOP' }, { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'ABORTED' }]);
    return wf;
  }
  setTrigger(stop: StopMode) {
    if (stop === 'none' || this.agents.length === 0) return;
    const a = this.r.pick(this.agents);
    a.beh = stop === 'credit' ? 'credit' : this.r.weighted<Beh>({ trigWait: 60, trigFinish: 25, trigBoom: 15 } as Record<Beh, number>);
  }
}

function genWfCase(seed: number): WfCase {
  const r = new Rng(seed);
  const g = new Gen(r);
  const layout = r.chance(0.35);
  const wf = g.workflow(4, layout);
  const stop = r.weighted<StopMode>({ none: 30, abort: 35, deadline: 35 } as Record<StopMode, number>);
  g.setTrigger(stop);
  const options: Record<string, boolean> = {};
  for (const p of wf.phases) if (p.skip_if) options[p.skip_if] = r.chance(0.5);
  return { seed, wf, options, stop, layout };
}

function genPlCase(seed: number): PlCase {
  const r = new Rng(seed ^ 0x5bd1e995);
  const g = new Gen(r);
  const n = 1 + r.int(4);
  const stages: StageSpec[] = [];
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    const kind = r.weighted({ agents: 35, command: 25, workflow: 30, steps: 10 });
    let st: StageSpec;
    if (kind === 'agents') st = { id, kind, agents: Array.from({ length: 1 + r.int(3) }, () => g.agent()) };
    else if (kind === 'command') st = { id, kind, step: g.cmdStep() };
    else if (kind === 'workflow') st = { id, kind, wf: g.workflow(3, false) };
    else st = { id, kind: 'steps' };
    if (r.chance(0.5)) {
      st.gate = {};
      const of = r.pick(['abort', 'warn', 'skip', undefined] as const);
      if (of) st.gate.on_failure = of;
      if (r.chance(0.5)) st.gate.threshold = r.pick([50, 70, 80]);
      if (r.chance(0.5)) st.gate.aggregate = r.pick(['min', 'average', 'max'] as const);
      if (r.chance(0.1)) st.gate.on_success = 'skip_remaining';
    }
    if (i > 0 && r.chance(0.15)) st.depends_on = [`s${r.int(i)}`];
    stages.push(st);
  }
  const stop = r.weighted<StopMode>({ none: 25, cancel: 20, abort: 20, deadline: 20, credit: 15 } as Record<StopMode, number>);
  g.setTrigger(stop);
  const options: Record<string, boolean> = {};
  for (const s of stages) if (s.kind === 'workflow') for (const p of s.wf.phases) if (p.skip_if) options[p.skip_if] = r.chance(0.5);
  return { seed, stages, options, stop };
}

// ─── Definitions + registry ──────────────────────────────────────────────────────────────────
const iface = (name: string) => ({ name, version: '1.0.0', displayName: name, description: 'd', domain: 'software' });
function agentDef(name: string) {
  return { type: 'agent', name, version: '1.0.0', hash: `sha256:${name}`, yaml: '', domain: 'software', agentType: 'validator', definition: {},
    runtime: { prompt: 'p', defaults: { model: 'sonnet', timeout: 30000 }, config: { maxScore: 100, threshold: 75, categories: [], outputSchema: 'json' } } };
}
function cmdDef(s: CmdStep) {
  const agents = s.kind === 'cmd1' ? [s.agent.name] : s.agents.map(a => a.name);
  const execution = s.kind === 'cmd1'
    ? { model: { default: 'sonnet' }, timeout: 30000, thresholds: { pass: 75, warn: 50 } }
    : { model: { default: 'sonnet' }, timeout: 30000, thresholds: { pass: s.pass, warn: s.warn }, sequential: s.sequential };
  return { type: 'command', name: s.name, version: '1.0.0', hash: `sha256:${s.name}`, yaml: '', domain: 'software', runtime: {},
    definition: { command: { interface: iface(s.name), agents, execution, ...(s.kind === 'cmdN' ? { aggregation: { method: s.method } } : {}) } } };
}
function wfDef(w: WfSpec) {
  return { type: 'workflow', name: w.name, version: '1.0.0', hash: `sha256:${w.name}`, yaml: '', domain: 'software', runtime: {},
    definition: { workflow: { interface: iface(w.name),
      orchestration: {
        phases: w.phases.map(p => ({
          id: p.id, name: p.id,
          commands: p.steps.filter((s): s is CmdStep => s.kind !== 'agentRef').map(s => s.name),
          ...(p.steps.some(s => s.kind === 'agentRef') ? { agentRefs: p.steps.filter(s => s.kind === 'agentRef').map(s => (s as { agent: AgentSpec }).agent.name) } : {}),
          parallel: p.parallel,
          ...(p.gate ? { gate: p.gate } : {}),
          ...(p.depends_on ? { depends_on: p.depends_on } : {}),
          ...(p.skip_if ? { skip_if: `{{ input.${p.skip_if} }}` } : {}),
        })),
        on_failure: w.on_failure,
        ...(w.max_parallel !== undefined ? { max_parallel: w.max_parallel } : {}),
      },
      aggregation: { score: { method: 'average' }, decision: w.vocab ?? { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' } },
    } } };
}
function plDef(stages: StageSpec[]) {
  return { type: 'pipeline', name: 'pl', version: '1.0.0', hash: 'sha256:pl', yaml: '', domain: 'software', runtime: {},
    definition: { pipeline: { interface: iface('pl'), stages: stages.map(s => {
      const base = { id: s.id, name: s.id, ...(s.gate ? { gate: s.gate } : {}), ...(s.depends_on ? { depends_on: s.depends_on } : {}) };
      if (s.kind === 'agents') return { ...base, type: 'agents', agents: s.agents.map(a => ({ ref: a.name })) };
      if (s.kind === 'command') return { ...base, type: 'command', ref: s.step.name };
      if (s.kind === 'workflow') return { ...base, type: 'workflow', ref: s.wf.name };
      return { ...base, type: 'steps', steps: [{ name: 'x', run: 'true' }] };
    }) } } };
}
function stepAgents(s: StepSpec): AgentSpec[] { return s.kind === 'cmdN' ? s.agents : [s.agent]; }
function wfAgents(w: WfSpec): AgentSpec[] { return w.phases.flatMap(p => p.steps.flatMap(stepAgents)); }
function registryFor(defs: Map<string, unknown>) {
  return { resolve: async (name: string) => { const d = defs.get(name); if (!d) throw new Error(`no def ${name}`); return d; } };
}
function collectDefs(wfs: WfSpec[], cmds: CmdStep[], agents: AgentSpec[], defs = new Map<string, unknown>()) {
  for (const a of agents) defs.set(a.name, agentDef(a.name));
  for (const c of cmds) defs.set(c.name, cmdDef(c));
  for (const w of wfs) {
    defs.set(w.name, wfDef(w));
    for (const p of w.phases) for (const s of p.steps) { if (s.kind !== 'agentRef') defs.set(s.name, cmdDef(s)); for (const a of stepAgents(s)) defs.set(a.name, agentDef(a.name)); }
  }
  return defs;
}

// ─── Mock agent executor + run context ───────────────────────────────────────────────────────
type Outcome = { t: 'res'; beh: string } | { t: 'crash' } | { t: 'cancel'; pre: boolean };
const CREDIT = 'Out of credit with provider "openrouter" (HTTP 402).';
class Ctx {
  trace = new Map<string, Outcome>();
  callSeq = new Map<string, number>();
  seq = 0; stopSeq: number | undefined; stopFired = false; trigger: string | undefined;
  waiters: Array<() => void> = [];
  anomalies: string[] = [];
  caller = new AbortController();
  handle: { cancel(): Promise<void> } | undefined;
  readyResolve!: () => void;
  ready = new Promise<void>(r => { this.readyResolve = r; });
  constructor(public mode: StopMode, public beh: Map<string, Beh>) {}
}
const agentResult = (name: string, k: string) => {
  const r = RES[k]!;
  return { type: 'agent', agentType: 'validator', name, version: '1.0.0', definitionHash: `sha256:${name}`, decision: r.decision, decisionCategory: r.cat,
    score: r.score, maxScore: r.score === null ? null : 100, recommendations: [{ agent: name, title: `${name} finding`, priority: 'suggested' }],
    durationMs: 1, metrics: { inputTokens: 1, outputTokens: 1, totalEffectiveTokens: 2, durationMs: 1, model: 'm', costUsd: 0.001, costBasis: 'estimated' } };
};
function mockAgentExecutor(ctx: Ctx) {
  return {
    execute: async (resolved: { name: string }, _input: unknown, options?: { abortSignal?: AbortSignal }) => {
      const name = resolved.name;
      const sig = options?.abortSignal;
      if (ctx.callSeq.has(name)) ctx.anomalies.push(`agent ${name} called twice`);
      ctx.callSeq.set(name, ctx.seq++);
      const beh = ctx.beh.get(name)!;
      const set = (o: Outcome) => { ctx.trace.set(name, o); };
      if (sig?.aborted) { set({ t: 'cancel', pre: true }); throw new CancelledError('Execution was cancelled by the caller'); }
      const fire = async (): Promise<void> => {
        ctx.trigger = name;
        if (ctx.mode === 'abort') { ctx.caller.abort(); ctx.stopFired = true; }
        else if (ctx.mode === 'deadline') { ctx.caller.abort(new DOMException('deadline', 'TimeoutError')); ctx.stopFired = true; }
        else if (ctx.mode === 'cancel') { await ctx.ready; await ctx.handle!.cancel(); ctx.stopFired = true; }
        ctx.stopSeq = ctx.seq++;
      };
      const wait = () => new Promise((res, rej) => {
        const onAbort = () => { set({ t: 'cancel', pre: false }); rej(new CancelledError('Execution was cancelled by the caller')); };
        sig?.addEventListener('abort', onAbort, { once: true });
        ctx.waiters.push(() => { sig?.removeEventListener('abort', onAbort); set({ t: 'res', beh: 'pass' }); res(agentResult(name, 'pass')); });
      });
      switch (beh) {
        case 'boom': set({ t: 'crash' }); throw new Error(`boom ${name}`);
        case 'tmo': set({ t: 'crash' }); throw new TimeoutError(1000);
        case 'fcancel': set({ t: 'crash' }); throw new CancelledError('foreign producer');
        case 'wait': return wait();
        case 'credit': {
          ctx.trigger = name;
          ctx.stopFired = tripRunFor(sig, CREDIT);
          ctx.stopSeq = ctx.seq++;
          set({ t: 'crash' });
          throw new ProviderCreditError(CREDIT, 'openrouter');
        }
        case 'trigWait':
          await fire();
          if (sig?.aborted) { set({ t: 'cancel', pre: false }); throw new CancelledError('Execution was cancelled by the caller'); }
          return wait();
        case 'trigFinish': await fire(); set({ t: 'res', beh: 'pass' }); return agentResult(name, 'pass');
        case 'trigBoom': await fire(); set({ t: 'crash' }); throw new Error(`boom ${name}`);
        default: set({ t: 'res', beh }); return agentResult(name, beh);
      }
    },
  };
}
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function drive<T>(p: Promise<T>, ctx: Ctx): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> {
  let settled: { ok: true; v: T } | { ok: false; e: unknown } | undefined;
  p.then(v => { settled = { ok: true, v }; }, (e: unknown) => { settled = { ok: false, e }; });
  let idle = 0;
  while (!settled) {
    await new Promise(r => setImmediate(r));
    if (settled) break;
    if (ctx.waiters.length) { idle = 0; for (const w of ctx.waiters.splice(0)) w(); }
    else if (++idle > 20) { ctx.anomalies.push('HANG'); return { ok: false, e: new Error('HANG') }; }
  }
  return settled;
}

function behMap(agents: AgentSpec[]) { return new Map(agents.map(a => [a.name, a.beh])); }

async function runWorkflow(c: WfCase) {
  const agents = wfAgents(c.wf);
  const ctx = new Ctx(c.stop, behMap(agents));
  const defs = collectDefs([c.wf], [], agents);
  const reg = registryFor(defs);
  const ae = mockAgentExecutor(ctx);
  const ce = new CommandExecutor(ae as never, reg as never, noopLogger);
  const we = new WorkflowExecutor(ce, reg as never, ae as never, noopLogger);
  const out = await drive(we.execute(defs.get(c.wf.name) as never, { target: '/tmp', options: c.options } as never, { abortSignal: ctx.caller.signal }), ctx);
  return { ctx, out };
}
async function runPipeline(stages: StageSpec[], options: Record<string, boolean>, stop: StopMode, agents: AgentSpec[]) {
  const ctx = new Ctx(stop, behMap(agents));
  const defs = collectDefs(stages.flatMap(s => s.kind === 'workflow' ? [s.wf] : []), stages.flatMap(s => s.kind === 'command' ? [s.step] : []), agents);
  defs.set('pl', plDef(stages));
  const reg = registryFor(defs);
  const ae = mockAgentExecutor(ctx);
  const ce = new CommandExecutor(ae as never, reg as never, noopLogger);
  const we = new WorkflowExecutor(ce, reg as never, ae as never, noopLogger);
  const pe = new PipelineExecutor(we, ce, ae as never, reg as never, noopLogger as never);
  const handle = await pe.start(defs.get('pl') as never, { target: '/tmp', options, params: {} } as never, { abortSignal: ctx.caller.signal } as never);
  ctx.handle = handle; ctx.readyResolve();
  const out = await drive(handle.wait(), ctx);
  return { ctx, out };
}
function plAgents(stages: StageSpec[]): AgentSpec[] {
  return stages.flatMap(s => s.kind === 'agents' ? s.agents : s.kind === 'command' ? stepAgents(s.step) : s.kind === 'workflow' ? wfAgents(s.wf) : []);
}

// ─── Normalization ───────────────────────────────────────────────────────────────────────────
type AnyRes = { decision: string; decisionCategory?: string; score?: number | null; degradationMarkers?: Array<{ code: string }>; [k: string]: unknown };
interface NWf { threw: boolean; decision?: string; cat?: string; score?: number | null; phases?: Record<string, { d: string; sbs: boolean }>; markers?: string[]; executed?: number; costOk?: boolean }
const codes = (r: { degradationMarkers?: Array<{ code: string }> }) => (r.degradationMarkers ?? []).map(m => m.code).sort();
function normWf(r: unknown): NWf {
  const w = r as AnyRes & { metrics: { phasesExecuted: number; costUsd?: number; costBasis?: string }; phases: Array<{ id: string; decision: string; stoppedBeforeStart?: boolean; commands: Array<{ metrics: { costUsd?: number } }> }> };
  // Rule 5 "no cost": a phase a stop kept from starting adds nothing to the cost roll-up, so the
  // roll-up is priced iff every command that ran is priced and no non-stopped blocked phase lost its commands.
  const expPriced = w.phases.every(p => p.stoppedBeforeStart ? p.commands.length === 0
    : p.commands.every(c => c.metrics.costUsd !== undefined) && !(p.decision === 'blocked' && p.commands.length === 0));
  return { threw: false, decision: w.decision, cat: w.decisionCategory, score: w.score ?? null,
    phases: Object.fromEntries(w.phases.map(p => [p.id, { d: p.decision, sbs: p.stoppedBeforeStart === true }])), markers: codes(w),
    executed: w.metrics.phasesExecuted, costOk: expPriced === !(w.metrics.costUsd === undefined && w.metrics.costBasis !== 'none') };
}
interface NStage { status: string; decision?: string; cat?: string; score?: number | null; markers?: string[]; wf?: NWf }
interface NPl { threw: boolean; decision: string; status: string; score: number | null; stages: Record<string, NStage> }
function normPl(out: { ok: boolean; v?: unknown; e?: unknown }): NPl | { hang: true } {
  const r = (out.ok ? out.v : (out.e as { context?: { partialResult?: unknown } })?.context?.partialResult) as
    (AnyRes & { status: string; stages: Array<{ id: string; status: string; result?: AnyRes }> }) | undefined;
  if (!r) return { hang: true };
  return { threw: !out.ok, decision: r.decision, status: r.status, score: r.score ?? null,
    stages: Object.fromEntries(r.stages.map(s => [s.id, {
      status: s.status, decision: s.result?.decision, cat: s.result?.decisionCategory, score: s.result?.score ?? null,
      markers: s.result ? codes(s.result) : [], ...(s.result?.type === 'workflow' ? { wf: normWf(s.result) } : {}),
    }])) };
}

// ─── ORACLE (derived from the rules, not from the aggregate functions) ───────────────────────
interface Rec { score: number | null; cat: Cat; stop: boolean; crash: boolean; crashRec: boolean }
const RUN_STOPPED = 'execution.run-stopped', PARTIAL = 'execution.run-stopped-partial', CHILD = 'execution.child-crashed';
const deadline = (ctx: Ctx) => ctx.mode === 'deadline';
/** Rule 1: an explicit stop's victim is an ABORTED placeholder; a deadline's victim is a crash. */
function agentRec(o: Outcome, ctx: Ctx): Rec {
  if (o.t === 'res') { const r = RES[o.beh]!; return { score: r.score, cat: r.cat, stop: false, crash: false, crashRec: false }; }
  if (o.t === 'crash') return { score: null, cat: 'negative', stop: false, crash: true, crashRec: true };
  return deadline(ctx) ? { score: null, cat: 'negative', stop: true, crash: true, crashRec: true } : { score: null, cat: 'neutral', stop: true, crash: false, crashRec: false };
}
const ABORTED_REC: Rec = { score: null, cat: 'neutral', stop: true, crash: false, crashRec: false };
const DEADLINE_REC: Rec = { score: null, cat: 'negative', stop: true, crash: true, crashRec: true };
const CRASH_REC: Rec = { score: null, cat: 'negative', stop: false, crash: true, crashRec: true };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function agg(xs: number[], m: string, round: boolean): number {
  if (m === 'min') return Math.min(...xs);
  if (m === 'max') return Math.max(...xs);
  if (m === 'sum') return xs.reduce((a, b) => a + b, 0);
  return round ? Math.round(mean(xs)) : mean(xs);
}

type CmdOut = { k: 'ok'; rec: Rec; decision: string; markers: string[] } | { k: 'throw'; err: 'crash' | 'cancel' } | { k: 'missing'; agent: string };
function cmdModel(s: StepSpec, ctx: Ctx): CmdOut {
  if (s.kind !== 'cmdN') {
    const o = ctx.trace.get(s.agent.name);
    if (!o) return { k: 'missing', agent: s.agent.name };
    if (o.t === 'res') return { k: 'ok', rec: agentRec(o, ctx), decision: RES[o.beh]!.decision, markers: [] };
    return { k: 'throw', err: o.t === 'crash' ? 'crash' : 'cancel' };
  }
  const recs: Rec[] = [];
  for (const a of s.agents) {
    const o = ctx.trace.get(a.name);
    if (!o) return { k: 'missing', agent: a.name };
    recs.push(agentRec(o, ctx));
    if (s.sequential && o.t !== 'res') break; // sequential panel is fail-fast
  }
  const reached = recs.some(r => r.stop), crash = recs.some(r => r.crash);
  if (!reached && recs.every(r => r.crashRec)) return { k: 'throw', err: 'crash' };
  const scored = recs.filter(r => r.score !== null).map(r => r.score!);
  const score = scored.length ? agg(scored, s.method, true) : null;
  let decision: string, cat: Cat;
  if (score !== null) {
    if (score >= s.pass) { decision = 'PASS'; cat = 'positive'; } else if (score >= s.warn) { decision = 'WARN'; cat = 'conditional'; } else { decision = 'FAIL'; cat = 'negative'; }
    if (cat !== 'negative' && recs.some(r => r.score === null && r.cat === 'negative')) { decision = 'FAIL'; cat = 'negative'; }
    if (cat === 'positive' && recs.some(r => r.score !== null && r.cat === 'negative')) { decision = 'WARN'; cat = 'conditional'; }
  } else {
    cat = recs.some(r => r.cat === 'negative') ? 'negative' : recs.some(r => r.cat === 'conditional') ? 'conditional' : 'positive';
    decision = cat === 'negative' ? 'FAILED' : cat === 'conditional' ? 'PARTIAL' : 'COMPLETE';
  }
  // Rule 2 (OD-12): a panel a stop reached is negative iff something inside crashed, else ABORTED.
  if (reached) { if (crash) { decision = score !== null ? 'FAIL' : 'FAILED'; cat = 'negative'; } else { decision = 'ABORTED'; cat = 'neutral'; } }
  const markers = [...(reached ? [crash ? PARTIAL : RUN_STOPPED] : []), ...(crash ? [CHILD] : [])].sort();
  return { k: 'ok', rec: { score, cat, stop: reached, crash, crashRec: false }, decision, markers };
}

interface PhaseOut { d: string; sbs: boolean; reached: boolean; crash: boolean; score: number | null; thrown?: boolean; empty?: boolean }
function phaseModel(p: PhaseSpec, ctx: Ctx): (PhaseOut & { thrown: boolean }) | { missing: string } {
  const recs: Rec[] = []; let errors = 0;
  for (const s of p.steps) {
    const m = cmdModel(s, ctx);
    if (m.k === 'missing') return { missing: m.agent };
    if (m.k === 'ok') recs.push(m.rec);
    else if (m.err === 'cancel') { if (deadline(ctx)) { recs.push(DEADLINE_REC); errors++; } else recs.push(ABORTED_REC); }
    else { recs.push(CRASH_REC); errors++; }
    if (!p.parallel && m.k === 'throw') break;
  }
  const reached = recs.some(r => r.stop), crash = recs.some(r => r.crash);
  if (errors > 0 && errors === recs.length && !reached) return { thrown: true, d: 'blocked', sbs: false, reached: false, crash: true, score: null };
  const scored = recs.filter(r => r.score !== null).map(r => r.score!);
  const score = recs.length === 0 ? 0 : scored.length ? agg(scored, p.gate?.aggregate ?? 'average', false) : null;
  let d = !p.gate || score === null || score >= p.gate.threshold ? 'passed' : p.gate.on_fail === 'warn' ? 'warned' : 'blocked';
  if (d === 'passed' && recs.some(r => r.score === null && r.cat === 'negative')) d = p.gate?.on_fail === 'warn' ? 'warned' : 'blocked';
  if (d === 'passed' && recs.some(r => r.score !== null && r.cat === 'negative')) d = 'warned';
  // Rule 2 at the phase: postures and gates do not apply to a phase a stop reached.
  if (reached) d = crash ? 'blocked' : 'aborted';
  return { thrown: false, d, sbs: false, reached, crash, score, empty: recs.length === 0 };
}

function levelsOf(w: WfSpec): PhaseSpec[][] {
  const placed = new Set<string>(); const out: PhaseSpec[][] = [];
  while (placed.size < w.phases.length) {
    const lvl = w.phases.filter(p => !placed.has(p.id) && (p.depends_on ?? []).every(d => placed.has(d)));
    lvl.forEach(p => placed.add(p.id)); out.push(lvl);
  }
  return out;
}

interface WfOut { threw: boolean; decision?: string; cat?: Cat; score?: number | null; phases?: Record<string, PhaseOut>; markers?: string[]; executed?: number; stopUnreached?: boolean; anyStop?: boolean }
/** `actualSbs`: the code's stoppedBeforeStart flags — a scheduling fact, consistency-checked here. */
function wfModel(w: WfSpec, ctx: Ctx, actualSbs: Record<string, boolean> | undefined, problems: string[]): WfOut {
  const levels = levelsOf(w);
  const agentsOf = (p: PhaseSpec) => p.steps.flatMap(stepAgents).map(a => a.name);
  const trigLevel = ctx.stopFired && ctx.trigger ? levels.findIndex(l => l.some(p => agentsOf(p).includes(ctx.trigger!))) : -1;
  const stopHere = trigLevel >= 0; // the stop fired inside this workflow
  const res: Record<string, PhaseOut> = {};
  let halt = false;
  const blockedLike = (d: string) => d === 'blocked' || d === 'aborted';
  const eligible = (p: PhaseSpec) => !(p.skip_if && ctx_options(ctx)[p.skip_if]) && (p.depends_on ?? []).every(d => res[d] && !blockedLike(res[d]!.d));
  const stopped = (): PhaseOut => ({ d: deadline(ctx) ? 'blocked' : 'aborted', sbs: true, reached: true, crash: deadline(ctx), score: null });
  const skipped = (): PhaseOut => ({ d: 'skipped', sbs: false, reached: false, crash: false, score: null });
  for (let L = 0; L < levels.length; L++) {
    const level = levels[L]!;
    // F3 (fold): an on_failure halt is checked before the stop relabel — halted levels stay skipped.
    if (halt) { if (stopHere && L > trigLevel && level.some(eligible)) HALT_THEN_STOP.n++; for (const p of level) res[p.id] = skipped(); continue; }
    if (stopHere && L > trigLevel) { for (const p of level) res[p.id] = eligible(p) ? stopped() : skipped(); continue; }
    const elig: PhaseSpec[] = [];
    for (const p of level) { if (eligible(p)) elig.push(p); else res[p.id] = skipped(); }
    if (!elig.length) continue;
    const limited = w.max_parallel !== undefined && w.max_parallel < elig.length;
    const levelOut: Array<[PhaseSpec, PhaseOut]> = [];
    for (const p of elig) {
      if (actualSbs?.[p.id]) {
        // Rule 5 fact: kept from starting. Consistent only if the stop fired in this level, the
        // phase was queued behind max_parallel, and none of its agents was called.
        if (!(stopHere && L === trigLevel && limited && agentsOf(p).every(a => !ctx.callSeq.has(a)))) problems.push(`sbs-inconsistent ${p.id}`);
        levelOut.push([p, stopped()]); continue;
      }
      const m = phaseModel(p, ctx);
      if ('missing' in m) { problems.push(`missing-call ${m.missing} in ${p.id}`); return { threw: false }; }
      if (m.thrown) {
        if (elig.length === 1) return { threw: true };
        levelOut.push([p, { d: 'blocked', sbs: false, reached: false, crash: true, score: null, thrown: true }]); continue;
      }
      levelOut.push([p, m]);
    }
    for (const [p, o] of levelOut) {
      res[p.id] = o;
      if (o.d === 'blocked' && !o.reached && !o.sbs) {
        // F1 (Alex 2026-10-06): on_failure warn does not soften a phase whose every step crashed.
        if (w.on_failure === 'warn') { if (!o.thrown) o.d = 'warned'; }
        else if (w.on_failure === 'stop' || w.on_failure === 'abort') halt = true;
      }
    }
  }
  const all = Object.values(res);
  const isStopped = (o: PhaseOut) => o.reached || o.sbs;
  const anyStop = all.some(isStopped);
  const scorable = all.filter(o => o.d !== 'skipped' && o.d !== 'aborted' && !o.sbs);
  let score: number | null;
  if (scorable.length === 0) score = anyStop ? null : 0;
  else { const s = scorable.map(o => o.score).filter((x): x is number => x !== null); score = s.length ? Math.round(mean(s)) : null; }
  const vocab = w.vocab ?? { SHIP: 'SHIP', HOLD: 'HOLD', BLOCK: 'BLOCK' };
  let decision: string, cat: Cat;
  if (anyStop) {
    // Rule 3 (OD-14): BLOCK iff a stopped phase holds a real crash or a FINISHED phase is blocked.
    const neg = all.some(o => isStopped(o) ? o.crash : o.d === 'blocked');
    if (neg) { decision = vocab.BLOCK; cat = 'negative'; } else { decision = 'ABORTED'; cat = 'neutral'; }
  } else if (all.some(o => o.d === 'blocked')) { decision = vocab.BLOCK; cat = 'negative'; }
  else if (all.some(o => o.d === 'warned')) { decision = vocab.HOLD; cat = 'conditional'; }
  else { decision = vocab.SHIP; cat = 'positive'; }
  const childCrashed = all.some(o => o.crash);
  const markers = [...(anyStop ? [cat === 'negative' ? PARTIAL : RUN_STOPPED] : []), ...(childCrashed ? [CHILD] : [])].sort();
  const executed = all.filter(o => o.d !== 'skipped' && o.d !== 'aborted' && !o.sbs).length;
  return { threw: false, decision, cat, score, phases: res, markers, executed, anyStop, stopUnreached: stopHere && !anyStop };
}
const HALT_THEN_STOP = { n: 0 };
let CURRENT_OPTIONS: Record<string, boolean> = {};
const ctx_options = (_ctx: Ctx) => CURRENT_OPTIONS;

function cmpWf(exp: WfOut, act: NWf, label: string, out: string[]) {
  if (exp.threw !== act.threw) { out.push(`${label} threw exp=${exp.threw} act=${act.threw} (act ${act.decision})`); return; }
  if (exp.threw) return;
  if (exp.cat !== act.cat) out.push(`${label} category exp=${exp.cat} act=${act.cat}`);
  if (exp.decision !== act.decision) out.push(`${label} decision exp=${exp.decision} act=${act.decision}`);
  if ((exp.score ?? null) !== (act.score ?? null)) out.push(`${label} score exp=${exp.score} act=${act.score}`);
  for (const [id, o] of Object.entries(exp.phases ?? {})) {
    const a = act.phases?.[id];
    if (!a) { out.push(`${label} phase ${id} missing`); continue; }
    if (a.d !== o.d) out.push(`${label} phase ${id} exp=${o.d} act=${a.d}`);
    if (a.sbs !== o.sbs) out.push(`${label} phase ${id} sbs exp=${o.sbs} act=${a.sbs}`);
  }
  if (JSON.stringify(exp.markers) !== JSON.stringify(act.markers)) out.push(`${label} markers exp=${exp.markers} act=${act.markers}`);
  if (act.executed !== undefined && exp.executed !== act.executed) out.push(`${label} phasesExecuted exp=${exp.executed} act=${act.executed}`);
  if (act.costOk === false) out.push(`${label} cost roll-up priced-ness wrong`);
}

const plCat = (d: string) => ({ FAIL: 'negative', WARN: 'conditional', PASS: 'positive', CANCELLED: 'neutral' } as Record<string, string>)[d] ?? `?${d}`;
interface PlOut { decision: string; status: string; score: number | null; stages: Record<string, { status: string; cat?: Cat; decision?: string; markers?: string[]; wf?: WfOut }>; stopUnreached: boolean }
function plModel(c: { stages: StageSpec[] }, ctx: Ctx, act: NPl, problems: string[]): PlOut {
  let status = 'running';
  const st: PlOut['stages'] = {};
  const order: string[] = [];
  let stopUnreached = false;
  let stoppedByRun = false, stopReachedStage = false, stopSkipped = false;
  const stopStatus = ctx.mode === 'cancel' || ctx.mode === 'abort' ? 'cancelled' : 'failed';
  const stageAgents = (s: StageSpec) => (s.kind === 'agents' ? s.agents : s.kind === 'command' ? stepAgents(s.step) : s.kind === 'workflow' ? wfAgents(s.wf) : []).map(a => a.name);
  const scores: Record<string, number | null> = {};
  for (let i = 0; i < c.stages.length; i++) {
    const s = c.stages[i]!;
    if (status !== 'running') { if (stoppedByRun) stopSkipped = true; for (let j = i; j < c.stages.length; j++) { st[c.stages[j]!.id] = { status: 'skipped' }; order.push(c.stages[j]!.id); } break; }
    if (s.depends_on && !s.depends_on.every(d => st[d]?.status === 'completed')) { st[s.id] = { status: 'skipped' }; order.push(s.id); continue; }
    if (s.kind === 'steps' && s.gate && (s.gate.on_failure ?? 'abort') === 'abort') { status = 'failed'; break; } // G5 throw
    let out: PlOut['stages'][string]; let gateScore: number | null = null; let nothing = false;
    if (s.kind === 'agents') {
      const recs: Rec[] = [];
      for (const a of s.agents) { const o = ctx.trace.get(a.name); if (!o) { problems.push(`missing-call ${a.name}`); return { decision: '?', status: '?', score: null, stages: {}, stopUnreached }; } recs.push(agentRec(o, ctx)); }
      const reached = recs.some(r => r.stop), crash = recs.some(r => r.crash);
      const neg = reached ? crash : recs.some(r => r.cat === 'negative');
      const cat: Cat = neg ? 'negative' : reached ? 'neutral' : 'positive';
      const sc = recs.filter(r => r.score !== null).map(r => r.score!);
      scores[s.id] = sc.length ? Math.round(mean(sc)) : null;
      gateScore = sc.length ? agg(sc, s.gate?.aggregate ?? 'min', false) : null;
      out = { status: 'completed', cat, decision: neg ? 'FAIL' : reached ? 'ABORTED' : 'PASS', markers: [...(reached ? [crash ? PARTIAL : RUN_STOPPED] : []), ...(crash ? [CHILD] : [])].sort() };
    } else if (s.kind === 'command') {
      const m = cmdModel(s.step, ctx);
      if (m.k === 'missing') { problems.push(`missing-call ${m.agent}`); return { decision: '?', status: '?', score: null, stages: {}, stopUnreached }; }
      if (m.k === 'throw') {
        if (m.err === 'cancel') { const dl = deadline(ctx); out = { status: 'completed', cat: dl ? 'negative' : 'neutral', decision: dl ? 'FAIL' : 'ABORTED' }; scores[s.id] = null; }
        else { out = { status: 'failed' }; scores[s.id] = null; }
      } else { out = { status: 'completed', cat: m.rec.cat, decision: m.decision, markers: m.markers }; scores[s.id] = m.rec.score; gateScore = m.rec.score; }
    } else if (s.kind === 'workflow') {
      const sbs = act.stages[s.id]?.wf ? Object.fromEntries(Object.entries(act.stages[s.id]!.wf!.phases ?? {}).map(([k, v]) => [k, v.sbs])) : undefined;
      const w = wfModel(s.wf, ctx, sbs, problems);
      if (w.threw) { out = { status: 'failed' }; scores[s.id] = null; }
      else {
        out = { status: 'completed', cat: w.cat, decision: w.decision, wf: w };
        nothing = w.executed === 0; scores[s.id] = nothing ? null : w.score ?? null; gateScore = w.score ?? null;
        if (w.stopUnreached) stopUnreached = true;
      }
    } else { out = { status: 'completed', cat: 'positive', decision: 'PASS' }; scores[s.id] = null; }
    st[s.id] = out; order.push(s.id);
    const stopInHere = ctx.stopFired && ctx.trigger !== undefined && stageAgents(s).includes(ctx.trigger);
    if (stopInHere) {
      status = stopStatus; stoppedByRun = true;
      if (s.kind === 'agents' && !st[s.id]!.markers?.some(m => m === RUN_STOPPED || m === PARTIAL)) stopUnreached = true;
      if (s.kind === 'command' && out.decision !== 'ABORTED' && !(out.markers ?? []).some(m => m === RUN_STOPPED || m === PARTIAL) && !(out.status === 'completed' && deadline(ctx) && out.decision === 'FAIL' && out.markers === undefined)) stopUnreached = true;
      stopReachedStage = !stopUnreached; // the one stop fires in this stage only
      continue; // loop top skips the rest
    }
    if (s.gate) {
      const failed = out.status === 'failed' || out.cat === 'negative' || nothing ||
        (s.gate.threshold !== undefined && gateScore !== null && gateScore < s.gate.threshold);
      if (failed) {
        const a = s.gate.on_failure ?? 'abort';
        if (a === 'abort') { status = 'failed'; for (let j = i + 1; j < c.stages.length; j++) st[c.stages[j]!.id] = { status: 'skipped' }; break; }
        if (a === 'skip') { for (let j = i + 1; j < c.stages.length; j++) st[c.stages[j]!.id] = { status: 'skipped' }; break; }
      } else if (s.gate.on_success === 'skip_remaining') { for (let j = i + 1; j < c.stages.length; j++) st[c.stages[j]!.id] = { status: 'skipped' }; break; }
    }
  }
  if (status === 'running') status = 'completed';
  const stages = Object.values(st);
  const hasFailures = stages.some(x => x.status === 'failed' || x.cat === 'negative');
  // Rule 3/4 at the pipeline: a failed/negative stage → FAIL (beats a later user cancel, OD-13);
  // else a user stop → CANCELLED; a credit trip / deadline → FAIL.
  let decision: string;
  // F2 (Alex 2026-10-06): "stopped" means a stop REACHED a stage (held a stop record, or a later
  // stage it kept from starting). A stop that reached nothing leaves the stages' verdict.
  const reachedAny = stopReachedStage || stopSkipped;
  const normal = hasFailures ? 'FAIL' : stages.some(x => x.cat === 'conditional') ? 'WARN' : 'PASS';
  if (status === 'cancelled') decision = hasFailures ? 'FAIL' : reachedAny ? 'CANCELLED' : normal;
  else if (status === 'failed') decision = hasFailures || !stoppedByRun || reachedAny ? 'FAIL' : normal;
  else decision = normal;
  const sc = c.stages.filter(s => st[s.id] && st[s.id]!.status !== 'skipped' && s.id in scores).map(s => scores[s.id]).filter((x): x is number => x !== null && x !== undefined);
  const score = sc.length ? Math.round(mean(sc)) : (Object.keys(st).length === 0 ? 0 : null);
  return { decision, status: status === 'completed' ? 'complete' : status, score, stages: st, stopUnreached };
}
function cmpPl(exp: PlOut, act: NPl, label: string, out: string[]) {
  if (exp.decision !== act.decision) out.push(`${label} decision exp=${exp.decision} act=${act.decision}`);
  if (exp.status !== act.status) out.push(`${label} status exp=${exp.status} act=${act.status}`);
  if (act.threw !== (exp.status === 'failed')) out.push(`${label} wait() threw=${act.threw} but status=${exp.status}`);
  if ((exp.score ?? null) !== (act.score ?? null)) out.push(`${label} score exp=${exp.score} act=${act.score}`);
  for (const [id, e] of Object.entries(exp.stages)) {
    const a = act.stages[id];
    if (!a) { out.push(`${label} stage ${id} missing (exp ${e.status})`); continue; }
    if (a.status !== e.status) { out.push(`${label} stage ${id} status exp=${e.status} act=${a.status}`); continue; }
    if (e.cat && a.cat !== e.cat) out.push(`${label} stage ${id} cat exp=${e.cat} act=${a.cat}`);
    if (e.decision && a.decision !== e.decision) out.push(`${label} stage ${id} decision exp=${e.decision} act=${a.decision}`);
    if (e.markers && JSON.stringify(e.markers) !== JSON.stringify(a.markers)) out.push(`${label} stage ${id} markers exp=${e.markers} act=${a.markers}`);
    if (e.wf && a.wf) cmpWf(e.wf, a.wf, `${label} stage ${id} wf`, out);
  }
  for (const id of Object.keys(act.stages)) if (!(id in exp.stages)) out.push(`${label} stage ${id} unexpected (act ${act.stages[id]!.status})`);
}

// ─── Layout split: one phase per workflow-ref stage ──────────────────────────────────────────
function splitLayout(c: WfCase): StageSpec[] {
  return c.wf.phases.map((p, i) => ({ id: `s${i}`, kind: 'workflow' as const, wf: { ...c.wf, name: `${c.wf.name}_${p.id}`, phases: [p], max_parallel: undefined } }));
}
const wfCatOf = (n: NWf) => n.threw ? 'negative' : n.cat!;


// ─── Minimal repros for the findings (FUZZ_REPRO=1) ──────────────────────────────────────────
const A = (name: string, beh: Beh): AgentSpec => ({ name, beh });
const c1 = (n: string, a: AgentSpec): CmdStep => ({ kind: 'cmd1', name: n, agent: a });
async function reproRun(label: string, wf: WfSpec, stop: StopMode) {
  const c: WfCase = { seed: 0, wf, options: {}, stop, layout: true };
  CURRENT_OPTIONS = {};
  const w = await runWorkflow(c);
  const nw: NWf = w.out.ok ? normWf(w.out.v) : { threw: true };
  const p = await runPipeline(splitLayout(c), {}, stop, wfAgents(wf));
  const np = normPl(p.out) as NPl;
  const line = { label, stop, workflow: nw.threw ? 'THREW' : `${nw.decision}/${nw.cat}`, phases: nw.phases, markers: nw.markers,
    splitPipeline: `${np.decision}/${plCat(np.decision)} status=${np.status}`, stages: Object.fromEntries(Object.entries(np.stages).map(([k, v]) => [k, `${v.status}:${v.decision ?? '-'}`])) };
  console.log(JSON.stringify(line));
  return { nw, np };
}
if (process.env.FUZZ_REPRO === '1') describe('minimal repros', () => {
  it('R1 layout: all-crashed finished phase under on_failure warn beside a stopped phase', async () => {
    const wf = (b: Beh): WfSpec => ({ name: 'w', on_failure: 'warn', max_parallel: 1, phases: [
      { id: 'A', parallel: true, steps: [c1('cA', A('a0', 'boom'))] },
      { id: 'B', parallel: true, steps: [c1('cB', A('a1', b))] } ] });
    await reproRun('R1 stopped (abort)', wf('trigWait'), 'abort');
    await reproRun('R1 control on_failure=continue', { ...wf('trigWait'), on_failure: 'continue' }, 'abort');
    await reproRun('R1u unstopped', wf('pass'), 'none');
  });
  it('R2 stop that reaches nothing', async () => {
    const wf: WfSpec = { name: 'w', on_failure: 'continue', phases: [{ id: 'A', parallel: true, steps: [c1('cA', A('a0', 'trigFinish'))] }] };
    await reproRun('R2 explicit abort', wf, 'abort');
    await reproRun('R2 deadline', wf, 'deadline');
  });
  it('R3 on_failure stop halts, run stop relabels the halted level', async () => {
    for (const stop of ['abort', 'deadline'] as const) {
      const wf: WfSpec = { name: 'w', on_failure: 'stop', phases: [
        { id: 'A', parallel: true, steps: [c1('cA', A('a0', 'low'))], gate: { threshold: 50, aggregate: 'average', on_fail: 'abort' } },
        { id: 'B', parallel: true, steps: [c1('cB', A('a1', 'trigFinish'))] },
        { id: 'C', parallel: true, steps: [c1('cC', A('a2', 'pass'))], depends_on: ['B'] } ] };
      const c: WfCase = { seed: 0, wf, options: {}, stop, layout: false };
      const w = await runWorkflow(c);
      const nw = normWf((w.out as { v: unknown }).v);
      console.log(JSON.stringify({ label: `R3 ${stop}`, decision: nw.decision, phases: nw.phases, markers: nw.markers }));
      const ctl = await runWorkflow({ ...c, stop: 'none', wf: { ...wf, phases: wf.phases.map(p => p.id === 'B' ? { ...p, steps: [c1('cB', A('a1', 'pass'))] } : p) } });
      console.log(JSON.stringify({ label: 'R3 control (no stop)', phases: normWf((ctl.out as { v: unknown }).v).phases }));
    }
  });
  it('R4 foreign CANCELLED classified after a same-tick stop (step layer)', async () => {
    const wf: WfSpec = { name: 'w', on_failure: 'continue', phases: [{ id: 'A', parallel: true, steps: [c1('cA', A('a0', 'fcancel')), c1('cB', A('a1', 'trigWait'))] }] };
    const w = await runWorkflow({ seed: 0, wf, options: {}, stop: 'abort', layout: false });
    const nw = normWf((w.out as { v: unknown }).v);
    const v = (w.out as { v: { phases: Array<{ commands: Array<{ name: string; decision: string; version: string }> }> } }).v;
    console.log(JSON.stringify({ label: 'R4', decision: nw.decision, phases: nw.phases, steps: v.phases[0]!.commands.map(c => [c.name, c.decision]), markers: nw.markers }));
  });
});

// ─── Driver ──────────────────────────────────────────────────────────────────────────────────
const NWF = Number(process.env.FUZZ_WF ?? 20000), NPL = Number(process.env.FUZZ_PL ?? 4000), SEED0 = Number(process.env.FUZZ_SEED0 ?? 1);
const ONLY_UNSTOPPED = process.env.FUZZ_ONLY_UNSTOPPED === '1';
const OUT = process.env.FUZZ_OUT;
const ONE = process.env.FUZZ_CASE;
type Fail = { seed: string; cls: string; msgs: string[] };
const fails: Fail[] = [];
const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
const unstoppedLines: string[] = [];
const classify = (m: string) => m.replace(/exp=\S+ act=\S+/g, 'exp/act').replace(/\b[aspcw]\d+\b/g, '#').replace(/\(.*\)/, '').trim();

async function wfCase(seed: number, verbose = false) {
  const c = genWfCase(seed);
  if (ONLY_UNSTOPPED && c.stop !== 'none') return;
  CURRENT_OPTIONS = c.options;
  const { ctx, out } = await runWorkflow(c);
  bump('wf.cases'); if (c.stop !== 'none') bump('wf.stopModes'); if (ctx.stopFired) bump('wf.stopFired');
  const act: NWf = out.ok ? normWf(out.v) : { threw: true };
  if (!out.ok && (out.e as Error)?.name !== 'WorkflowError') ctx.anomalies.push(`threw ${(out.e as Error)?.name}: ${(out.e as Error)?.message}`);
  if (c.stop === 'none') unstoppedLines.push(JSON.stringify({ k: `wf:${seed}`, ...act, markers: act.markers?.filter(m => m !== CHILD) }));
  const problems: string[] = [...ctx.anomalies];
  const exp = wfModel(c.wf, ctx, act.phases ? Object.fromEntries(Object.entries(act.phases).map(([k, v]) => [k, v.sbs])) : undefined, problems);
  const msgs: string[] = [...problems];
  cmpWf(exp, act, 'wf', msgs);
  if (exp.stopUnreached) { bump('wf.stopUnreached'); bump(`wf.stopUnreached.${act.cat}`); }
  if (exp.anyStop) bump('wf.stopReached');
  if (verbose) console.log(JSON.stringify({ case: c, trace: [...ctx.trace], stopFired: ctx.stopFired, trigger: ctx.trigger, act, exp }, null, 1));
  const fc = wfAgents(c.wf).some(a => a.beh === 'fcancel') ? '[fcancel] ' : '';
  if (msgs.length) fails.push({ seed: `wf:${seed}`, cls: fc + msgs.map(classify).join(' | '), msgs });
  // Layout invariance
  if (c.layout && !ONLY_UNSTOPPED) {
    const stages = splitLayout(c);
    CURRENT_OPTIONS = c.options;
    const p = await runPipeline(stages, c.options, c.stop, wfAgents(c.wf));
    const np = normPl(p.out);
    bump('layout.cases'); if (ctx.stopFired) bump('layout.stopped');
    if ('hang' in np) { fails.push({ seed: `wf:${seed}`, cls: 'layout-hang', msgs: ['layout pipeline hang'] }); return; }
    const a = wfCatOf(act), b = plCat(np.decision);
    if (a !== b) {
      const tag = exp.stopUnreached ? 'stop-unreached' : ctx.stopFired ? 'stopped' : 'unstopped';
      bump(`layout.mismatch.${tag}`);
      fails.push({ seed: `wf:${seed}`, cls: `LAYOUT[${tag}] wf=${act.threw ? 'THREW' : act.decision}/${a} pl=${np.decision}/${b}`, msgs: [`layout wf=${a} pipeline=${b}`] });
    }
  }
}
async function plCase(seed: number, verbose = false) {
  const c = genPlCase(seed);
  if (ONLY_UNSTOPPED && c.stop !== 'none') return;
  CURRENT_OPTIONS = c.options;
  const { ctx, out } = await runPipeline(c.stages, c.options, c.stop, plAgents(c.stages));
  bump('pl.cases'); if (c.stop !== 'none') bump('pl.stopModes'); if (ctx.stopFired) bump('pl.stopFired');
  const act = normPl(out);
  if ('hang' in act) { fails.push({ seed: `pl:${seed}`, cls: 'hang', msgs: ['hang', String((out as { e?: Error }).e?.message)] }); return; }
  if (c.stop === 'none') unstoppedLines.push(JSON.stringify({ k: `pl:${seed}`, ...act, stages: Object.fromEntries(Object.entries(act.stages).map(([k, v]) => [k, { ...v, markers: v.markers?.filter(m => m !== CHILD), wf: v.wf ? { ...v.wf, markers: v.wf.markers?.filter(m => m !== CHILD) } : undefined }])) }));
  const problems = [...ctx.anomalies];
  const exp = plModel(c, ctx, act, problems);
  const msgs = [...problems];
  cmpPl(exp, act, 'pl', msgs);
  if (exp.stopUnreached) bump('pl.stopUnreached');
  if (verbose) console.log(JSON.stringify({ case: c, trace: [...ctx.trace], stopFired: ctx.stopFired, trigger: ctx.trigger, act, exp }, null, 1));
  const fc = plAgents(c.stages).some(a => a.beh === 'fcancel') ? '[fcancel] ' : '';
  if (msgs.length) fails.push({ seed: `pl:${seed}`, cls: fc + msgs.map(classify).join(' | '), msgs });
}

describe('stop-verdict fuzzer', () => {
  if (ONE) {
    it(`replay ${ONE}`, async () => {
      const [k, s] = ONE.split(':');
      if (k === 'wf') await wfCase(Number(s), true); else await plCase(Number(s), true);
      console.log(JSON.stringify(fails, null, 1));
    });
    return;
  }
  it(`workflows (${NWF})`, async () => { for (let i = 0; i < NWF; i++) await wfCase(SEED0 + i); }, 1_800_000);
  it(`pipelines (${NPL})`, async () => { for (let i = 0; i < NPL; i++) await plCase(SEED0 + i); }, 1_800_000);
  it('report', () => {
    stats['wf.haltThenStopLevels'] = HALT_THEN_STOP.n;
    const byCls = new Map<string, Fail[]>();
    for (const f of fails) { const k = f.cls.slice(0, 300); byCls.set(k, [...(byCls.get(k) ?? []), f]); }
    const summary = { stats, failing: fails.length, classes: [...byCls].sort((a, b) => b[1].length - a[1].length).map(([cls, fs]) => ({ cls, count: fs.length, seeds: fs.slice(0, 6).map(f => f.seed), example: fs[0]!.msgs })) };
    console.log(JSON.stringify(summary, null, 1));
    if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1)); writeFileSync(`${OUT}/unstopped.jsonl`, unstoppedLines.join('\n') + '\n'); }
    expect(stats['wf.cases'] ?? 0).toBeGreaterThan(0);
    // Every class must agree with the rules except F4 ([fcancel]: a foreign CANCELLED laundered by a
    // same-tick stop at the step/stage layer — deferred, reachable only same-microtask).
    expect(fails.filter(f => !f.cls.startsWith('[fcancel]')).map(f => `${f.seed} ${f.cls}`).slice(0, 10)).toEqual([]);
  });
});
if (process.env.FUZZ_COSTDUMP) it('costdump', async () => {
  const c = genWfCase(Number(process.env.FUZZ_COSTDUMP)); CURRENT_OPTIONS = c.options;
  const { out } = await runWorkflow(c);
  const w = (out as { v: { metrics: unknown; phases: Array<{ id: string; decision: string; stoppedBeforeStart?: boolean; commands: Array<{ name: string; decision: string; metrics: { costUsd?: number; costBasis?: string } }> }> } }).v;
  console.log(JSON.stringify({ m: w.metrics, phases: w.phases.map(p => [p.id, p.decision, p.stoppedBeforeStart, p.commands.map(x => [x.name, x.decision, x.metrics.costUsd, x.metrics.costBasis])]) }));
});
