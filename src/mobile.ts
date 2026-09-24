import { interpolate } from './spec.js';
import { parseMobileStep, validateMobileStep, mobileLabel, type MobileStep, type MobileSpec, type Direction } from './mobile-spec.js';
import type { MobileAdapter, MobileAction } from './mobile-adapter.js';
import type { MobileKind, MobileFrame } from './mobile-tree.js';
import { intelligence, resolveTargets, judgeState, askSettled, type Intelligence } from './automation.js';
import { decide } from './jev.js';
import { timedInto, dumpDebug, type StepResult, type Status } from './results.js';
import { startHooks, type HooksRunner } from './hooks.js';

const EARLY_WINDOW_MS = 1000;

export class MobileSession<T = unknown> {
  calls = 0;
  tokens = 0;
  constructor(readonly adapter: MobileAdapter<T>, readonly timeout = 15000, private ai: Intelligence = intelligence) {}
  // Per-step phase timings (capture, jev, act, idle), reset by run() and returned as the result's `ms`.
  private ms: Record<string, number> = {};
  private timed<R>(phase: string, fn: () => Promise<R>) { return timedInto(this.ms, phase, fn); }
  private track(tokens: number) { this.calls++; this.tokens += tokens; }
  // End of the last step. Seconds later (an agent's turn) the UI is idle, the settled capture is quick,
  // and an early capture would only add calls (measured: no gain with 5 s between steps).
  private lastStepEnd = 0;
  /** The UI was just driven outside a step (the app was opened): the next step may find it busy. */
  noteActivity() { this.lastStepEnd = Date.now(); }
  // Captures the settled UI and asks Jev about it. Where the adapter offers an early capture (Android),
  // Jev already works on it while the adapter waits for the UI to go idle (askSettled) — only right
  // after the previous step, when the UI may still be busy.
  private async settled<R>(kind: MobileKind, within: T | undefined, ask: (frame: MobileFrame<T>) => Promise<R>,
    discard: (result: R) => void, skip?: (frame: MobileFrame<T>) => boolean) {
    const recent = Date.now() - this.lastStepEnd < EARLY_WINDOW_MS;
    const early = recent ? this.adapter.captureEarly?.bind(this.adapter) : undefined;
    const { frame, result, reasked } = await askSettled({
      early: early && (() => this.timed('capture', () => early(kind, within))),
      settled: () => this.timed('capture', () => this.adapter.capture(kind, within)),
      same: sameFrame, ask, discard, skip,
      waitAnswer: (fn) => this.timed('jev', fn),
    });
    if (reasked) this.ms.reasked = (this.ms.reasked ?? 0) + 1;
    return { frame, result };
  }
  async find(kind: MobileKind, targets: string[]) {
    const { result } = await this.settled(kind, undefined, (frame) => resolveTargets({ candidates: frame.candidates, state: frame.snapshot,
      element: (c) => { const el = frame.elements.get(c.id); if (el === undefined) throw new Error('Candidate handle missing'); return el; },
    }, targets, this.ai), ([first]) => { if (first?.usedJev) this.track(first.tokens); });
    for (const r of result!) if (r.usedJev) this.track(r.tokens);
    return result!;
  }
  async snapshot(within?: string) {
    if (!within) return (await this.timed('capture', () => this.adapter.capture('region'))).snapshot;
    const [r] = await this.find('region', [within]);
    if (r.element === null) throw new Error(r.detail);
    return (await this.timed('capture', () => this.adapter.capture('region', r.element!))).snapshot;
  }
  async step(raw: unknown): Promise<StepResult> {
    const step = parseMobileStep(raw);
    return this.run(step);
  }
  async run(step: MobileStep): Promise<StepResult> {
    const start = Date.now();
    this.ms = {};
    let result: StepResult;
    try { result = await this.execute(validateMobileStep(step)); }
    catch (error) { result = { step: mobileLabel(step), status: 'error', detail: error instanceof Error ? error.message : String(error) }; }
    if (step.optional && (result.status === 'error' || result.status === 'inconclusive')) result.status = 'skipped';
    this.lastStepEnd = Date.now();
    return { ...result, ms: { total: this.lastStepEnd - start, ...this.ms } };
  }
  private async execute(step: MobileStep): Promise<StepResult> {
    const name = mobileLabel(step);
    if (step.kind === 'expect' || step.kind === 'wait') {
      const claims = step.kind === 'expect' ? step.expectations : [step.condition];
      const deadline = Date.now() + this.timeout;
      let polls = 0, last = '', probabilities: number[] = [], status: Status = 'inconclusive';
      let snap;
      do {
        let region: T | undefined;
        if (step.kind === 'expect' && step.within) {
          const [r] = await this.find('region', [step.within]);
          if (r.element === null) throw new Error(r.detail);
          region = r.element;
        }
        // Unchanged since a clear "no": asking again buys nothing.
        const { frame, result: judged } = await this.settled('region', region, (f) => judgeState(f.snapshot, claims, [], this.ai),
          (r) => this.track(r.tokens), (f) => JSON.stringify(f.snapshot) === last && status === 'fail');
        snap = frame.snapshot;
        if (judged) {
          this.track(judged.tokens); probabilities = judged.probabilities; polls++;
          const decisions = probabilities.map((p) => decide(p, 'expect'));
          status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
        }
        last = JSON.stringify(snap);
        if (step.kind === 'expect' || status === 'pass' || Date.now() >= deadline || polls >= 8) break;
        await this.timed('idle', () => new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now())))));
      } while (Date.now() < deadline);
      if (step.kind === 'wait' && status !== 'pass') status = 'inconclusive';
      const debug = status === 'pass' ? '' : ` — state: ${dumpDebug(step.kind, { claims, probabilities, state: snap })}`;
      return { step: name, status, detail: `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}` };
    }
    if (step.kind === 'press') await this.timed('act', () => this.adapter.press(step.key));
    else if (step.kind === 'swipe') {
      let element: T | undefined;
      if (step.within) {
        const [r] = await this.find('region', [step.within]);
        if (r.element === null) return { step: name, status: 'inconclusive', detail: r.detail };
        element = r.element;
      }
      await this.timed('act', () => this.adapter.gesture('swipe', step.direction, element));
    } else {
      const kind: MobileKind = step.kind === 'fill' ? 'fill' : step.kind === 'check' || step.kind === 'uncheck' ? 'check' :
        step.kind === 'scroll' ? 'scroll' : 'click';
      const target = step.kind === 'scroll' ? step.target.replace(/^(up|down|left|right):\s*/, '') : step.target;
      const [r] = await this.find(kind, [target]);
      if (r.element === null) return { step: name, status: 'inconclusive', detail: r.detail };
      const element = r.element;
      if (step.kind === 'scroll') await this.timed('act', () => this.adapter.gesture('scroll', step.target.split(':')[0] as Direction, element));
      else await this.timed('act', () => this.adapter.act(step.kind as MobileAction, element, step.kind === 'fill' ? step.value : undefined));
      return { step: name, status: 'pass', detail: r.detail };
    }
    return { step: name, status: 'pass' };
  }
}

// Same input for Jev (tree text and candidates) and same native handles, so an answer about one frame holds for the other.
function sameFrame<T>(a: MobileFrame<T>, b: MobileFrame<T>): boolean {
  return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot) && JSON.stringify(a.candidates) === JSON.stringify(b.candidates) &&
    JSON.stringify([...a.elements]) === JSON.stringify([...b.elements]);
}

export async function runMobileSpec<T>(spec: MobileSpec, session: MobileSession<T>) {
  const steps: StepResult[] = [];
  let status: Status = 'pass';
  let hooks: HooksRunner<MobileSpec> | undefined;
  let data: Record<string, unknown> = {};
  let setupDone = false;
  try {
    if (spec.hooks) {
      hooks = await startHooks<MobileSpec>(spec.hooks);
      if (hooks.has.setup) data = await hooks.setup(spec);
    }
    setupDone = true;
    const resolved = interpolate({ platform: spec.platform, device: spec.device, app: spec.app, capabilities: spec.capabilities, steps: spec.steps }, { env: spec.env, hooks: data }, spec.name);
    const { steps: resolvedSteps, ...target } = resolved;
    await session.adapter.open(target);
    session.noteActivity();
    for (const step of resolvedSteps) {
      const result = await session.run(step); steps.push(result);
      if (result.status !== 'pass' && result.status !== 'skipped') { status = result.status; break; }
    }
  } catch (error) {
    status = 'error'; steps.push({ step: setupDone ? 'open/interpolate' : 'setup', status, detail: String(error) });
  } finally {
    try {
      if (setupDone && hooks?.has.teardown) await hooks.teardown({ spec, data, result: { status, steps } });
    } catch (error) { status = 'error'; steps.push({ step: 'teardown', status, detail: String(error) }); }
    finally {
      hooks?.close();
      try { await session.adapter.close(); }
      catch (error) { status = 'error'; steps.push({ step: 'close', status, detail: String(error) }); }
    }
  }
  return { name: spec.name, status, steps, jevCalls: session.calls, totalTokens: session.tokens };
}
