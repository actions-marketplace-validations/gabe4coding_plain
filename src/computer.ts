import { interpolate, type Step } from './spec.js';
import { parseComputerStep, type ComputerSpec } from './computer-spec.js';
import { type ComputerAdapter, type ComputerKind } from './computer-adapter.js';
import { intelligence, resolveTargets, judgeState, type Intelligence } from './automation.js';
import { decide } from './jev.js';
import { label, dumpDebug, type StepResult, type Status } from './results.js';
import { startHooks, type HooksRunner } from './hooks.js';

export class ComputerSession<T = unknown> {
  calls = 0;
  tokens = 0;
  constructor(readonly adapter: ComputerAdapter<T>, readonly timeout = 15000, private ai: Intelligence = intelligence) {}
  private track(tokens: number) { this.calls++; this.tokens += tokens; }
  async find(kind: ComputerKind, targets: string[]) {
    const frame = await this.adapter.capture(kind);
    const resolved = await resolveTargets({ candidates: frame.candidates, state: frame.snapshot,
      element: (c) => { const el = frame.elements.get(c.id); if (el === undefined) throw new Error('Candidate handle missing'); return el; },
    }, targets, this.ai);
    for (const r of resolved) if (r.usedJev) this.track(r.tokens);
    return resolved;
  }
  async snapshot(within?: string) {
    if (!within) return (await this.adapter.capture('region')).snapshot;
    const [r] = await this.find('region', [within]);
    if (r.element === null) throw new Error(r.detail);
    return (await this.adapter.capture('region', r.element)).snapshot;
  }
  async step(raw: unknown): Promise<StepResult> {
    const step = parseComputerStep(raw);
    return this.run(step);
  }
  async run(step: Step): Promise<StepResult> {
    const start = Date.now();
    let result: StepResult;
    try { result = await this.execute(step); }
    catch (error) { result = { step: label(step), status: 'error', detail: error instanceof Error ? error.message : String(error) }; }
    if (step.optional && (result.status === 'error' || result.status === 'inconclusive')) result.status = 'skipped';
    return { ...result, ms: { total: Date.now() - start } };
  }
  private async execute(step: Step): Promise<StepResult> {
    const name = label(step);
    if (step.kind === 'expect' || step.kind === 'wait') {
      const claims = step.kind === 'expect' ? step.expectations : [step.condition];
      const deadline = Date.now() + this.timeout;
      let polls = 0, last = '', probabilities: number[] = [], status: Status = 'inconclusive';
      let snap;
      do {
        snap = await this.snapshot(step.kind === 'expect' ? step.within : undefined);
        const key = JSON.stringify(snap);
        if (key !== last || status !== 'fail') {
          const judged = await judgeState(snap, claims, [], this.ai);
          this.track(judged.tokens); probabilities = judged.probabilities; polls++;
          const decisions = probabilities.map((p) => decide(p, 'expect'));
          status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
        }
        last = key;
        if (step.kind === 'expect' || status === 'pass' || Date.now() >= deadline || polls >= 8) break;
        await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
      } while (Date.now() < deadline);
      if (step.kind === 'wait' && status !== 'pass') status = 'inconclusive';
      const debug = status === 'pass' ? '' : ` — state: ${dumpDebug(step.kind, { claims, probabilities, state: snap })}`;
      return { step: name, status, detail: `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}` };
    }
    if (step.kind === 'press') await this.adapter.press(step.key);
    else if (step.kind === 'mouse') await this.adapter.mouse(step.x, step.y);
    else if (step.kind === 'drag') {
      const [source, target] = await this.find('click', [step.source, step.target]);
      if (source.element === null || target.element === null) return { step: name, status: 'inconclusive', detail: `${source.detail} → ${target.detail}` };
      await this.adapter.drag(source.element, target.element);
    } else if (step.kind === 'goto' || step.kind === 'select' || step.kind === 'upload') {
      throw new Error(`${step.kind} is browser-only`);
    } else {
      const kind: ComputerKind = step.kind === 'fill' ? 'fill' : step.kind === 'check' || step.kind === 'uncheck' ? 'check' :
        step.kind === 'scroll' ? 'scroll' : step.kind === 'hover' ? 'hover' : 'click';
      const target = step.kind === 'scroll' ? step.target.replace(/^(up|down):\s*/, '') : step.target;
      const [r] = await this.find(kind, [target]);
      if (r.element === null) return { step: name, status: 'inconclusive', detail: r.detail };
      await this.adapter.act(step.kind, r.element, step.kind === 'fill' ? step.value : step.kind === 'scroll' ? (step.target.startsWith('up:') ? '-3' : '3') : undefined);
      return { step: name, status: 'pass', detail: r.detail };
    }
    return { step: name, status: 'pass' };
  }
}

export async function runComputerSpec<T>(spec: ComputerSpec, session: ComputerSession<T>) {
  const steps: StepResult[] = [];
  let status: Status = 'pass';
  let hooks: HooksRunner<ComputerSpec> | undefined;
  let data: Record<string, unknown> = {};
  let setupDone = false;
  try {
    if (spec.hooks) {
      hooks = await startHooks<ComputerSpec>(spec.hooks);
      if (hooks.has.setup) data = await hooks.setup(spec);
    }
    setupDone = true;
    const resolved = interpolate({ app: spec.app, steps: spec.steps }, { env: spec.env, hooks: data }, spec.name);
    await session.adapter.open({ app: resolved.app }, true);
    for (const step of resolved.steps) {
      const result = await session.run(step); steps.push(result);
      if (result.status !== 'pass' && result.status !== 'skipped') { status = result.status; break; }
    }
  } catch (error) {
    status = 'error'; steps.push({ step: setupDone ? 'open/interpolate' : 'setup', status, detail: String(error) });
  } finally {
    try {
      if (setupDone && hooks?.has.teardown) await hooks.teardown({ spec, data, result: { status, steps } });
    } catch (error) { status = 'error'; steps.push({ step: 'teardown', status, detail: String(error) }); }
    finally { hooks?.close(); await session.adapter.close(); }
  }
  return { name: spec.name, status, steps, jevCalls: session.calls, totalTokens: session.tokens };
}
