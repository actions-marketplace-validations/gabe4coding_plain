import { parseArgs } from 'node:util';
import type { Step } from './spec.js';
import { intelligence, resolveTargets, judgeState, askSettled, HiddenTargetError, type Intelligence, type Frame } from './automation.js';
import { decide, loadEnvFiles, provider, warmUp } from './jev.js';
import { timedInto, dumpDebug, type StepResult, type Status } from './results.js';
import { readAnswer } from './read.js';
import { startHooks, type HooksRunner, type HookSpec } from './hooks.js';

// Shared by the desktop (computer.ts) and mobile (mobile.ts) paths: Jev targeting, expect/wait polling,
// phase timing, spec runs and the CLI. Subclasses only perform their platform's actions.
export interface NativeAdapter<T, K extends string> {
  /** `regionPick`: the capture only picks a region, so an approximate frame may do (see AppiumAdapter). */
  capture(kind: K | 'region', within?: T, options?: { regionPick?: boolean }): Promise<Frame<T>>;
  /** The next target capture is exact, not approximate (a pick from an approximate one was rejected or hidden). */
  preferExact?(): void;
  /** Target captures may be approximate (AppiumAdapter with fastTargets on iOS): they never serve as a step's `changed` baseline. */
  readonly approximateTargets?: boolean;
  /** A capture that skips the platform's wait for an idle UI, or null where that is not faster (see AppiumAdapter). */
  captureEarly?(kind: K | 'region', within?: T): Promise<Frame<T> | null>;
  press(key: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}
type Assert = Extract<Step, { kind: 'expect' | 'wait' }>;

const EARLY_WINDOW_MS = 1000;
const APPEAR_MS = 2000;

export abstract class NativeSession<T, K extends string, S extends { kind: string; optional?: boolean }, A extends NativeAdapter<T, K>> {
  calls = 0;
  tokens = 0;
  /** What the whole flow is for (spec `goal:`, MCP `open {goal}`): every pick sees it, claims never do. */
  goal?: string;
  constructor(readonly adapter: A, readonly timeout = 15000, protected ai: Intelligence = intelligence) {}
  abstract parse(raw: unknown): S;
  protected abstract label(step: S): string;
  protected validate(step: S): S { return step; }
  /** Every step kind but expect and wait. */
  protected abstract act(step: S, name: string): Promise<StepResult>;
  // Per-step phase timings (capture, jev, act, idle), reset by run() and returned as the result's `ms`.
  protected ms: Record<string, number> = {};
  protected timed<R>(phase: string, fn: () => Promise<R>) { return timedInto(this.ms, phase, fn); }
  private track(tokens: number) { this.calls++; this.tokens += tokens; }
  // End of the last step. Seconds later (an agent's turn) the UI is idle, the settled capture is quick,
  // and an early capture would only add calls (measured: no gain with 5 s between steps).
  private lastStepEnd = 0;
  /** The first whole-screen capture of the current step, before it acted: `changed` in the MCP step result diffs against it. */
  firstSnapshot?: Frame<T>['snapshot'];
  /** The UI was just driven outside a step (the app was opened): the next step may find it busy. */
  noteActivity() { this.lastStepEnd = Date.now(); }
  // Captures the settled UI and asks Jev about it. Where the adapter offers an early capture (Android),
  // Jev already works on it while the adapter waits for the UI to go idle (askSettled) — only right
  // after the previous step, when the UI may still be busy.
  private async settled<R>(kind: K | 'region', within: T | undefined, ask: (frame: Frame<T>) => Promise<R>,
    discard: (result: R) => void, skip?: (frame: Frame<T>) => boolean, regionPick = false) {
    const recent = Date.now() - this.lastStepEnd < EARLY_WINDOW_MS;
    const early = recent ? this.adapter.captureEarly?.bind(this.adapter) : undefined;
    const { frame, result, reasked } = await askSettled({
      early: early && (() => this.timed('capture', () => early(kind, within))),
      settled: () => this.timed('capture', () => this.adapter.capture(kind, within, regionPick ? { regionPick } : undefined)).then((f) => {
        if (within === undefined && !f.approximate) this.firstSnapshot ??= f.snapshot;
        return f;
      }),
      same: sameFrame, ask, discard, skip,
      waitAnswer: (fn) => this.timed('jev', fn),
    });
    if (reasked) this.ms.reasked = (this.ms.reasked ?? 0) + 1;
    return { frame, result };
  }
  async find(kind: K | 'region', targets: string[], regionPick = false) {
    // A key or click that opens a window returns before the window exists (TextEdit's Command-N):
    // an empty capture is looked at again for a moment instead of reported as "no candidates".
    const deadline = Date.now() + Math.min(APPEAR_MS, this.timeout);
    for (;;) {
      const { frame, result } = await this.settled(kind, undefined, (frame) => resolveTargets({ candidates: frame.candidates, state: { ...frame.snapshot, ...(this.goal ? { goal: this.goal } : {}) },
        element: (c) => { const el = frame.elements.get(c.id); if (el === undefined) throw new Error('Candidate handle missing'); return el; },
      }, targets, this.ai), ([first]) => { if (first?.usedJev) this.track(first.tokens); }, undefined, regionPick);
      if (frame.candidates.length === 0 && Date.now() < deadline) { await this.timed('idle', () => new Promise((r) => setTimeout(r, 150))); continue; }
      for (const r of result!) if (r.usedJev) this.track(r.tokens);
      return frame.approximate ? result!.map((r) => ({ ...r, approximate: true })) : result!;
    }
  }
  /**
   * The element a region description names; throws when Jev finds none. `fast`: the adapter may pick from an
   * approximate capture (a rejected pick there is asked again from an exact one); the first look inside the
   * region then confirms it shows something, or throws HiddenTargetError.
   */
  protected async region(within: string, fast = false) {
    let [r] = await this.find('region', [within], fast);
    if (r.approximate && r.element === null) { this.retarget(); [r] = await this.find('region', [within]); }
    if (r.element === null) throw new Error(r.detail);
    return r.element;
  }
  protected retarget() { this.ms.retargeted = 1; this.adapter.preferExact?.(); }
  /** Runs `look` inside the region `within` names, picked fast where the adapter can; a covered one is picked once more exactly. */
  private async inRegion<R>(within: string | undefined, look: (region: T | undefined) => Promise<R>): Promise<R> {
    if (!within) return look(undefined);
    const region = await this.region(within, true);
    try { return await look(region); } catch (error) {
      if (!(error instanceof HiddenTargetError)) throw error;
      this.retarget(); return look(await this.region(within));
    }
  }
  async snapshot(within?: string) {
    return this.inRegion(within, async (region) => (await this.timed('capture', () => this.adapter.capture('region', region))).snapshot);
  }
  /** Judges claims once against the settled UI (or a region of it), without recording or polling: the MCP `ask` tool. */
  async ask(claims: string[], within?: string) {
    this.ms = {};
    const { frame, result } = await this.inRegion(within, (region) => this.settled('region', region, (f) => judgeState(f.snapshot, claims, [], this.ai), (r) => this.track(r.tokens)));
    this.track(result!.tokens);
    return { snapshot: frame.snapshot, probabilities: result!.probabilities, ms: this.ms };
  }
  /** The MCP `read` tool: the tree lines that answer `question` (src/read.ts), not recorded. */
  async read(question: string, within?: string) {
    const snapshot = await this.snapshot(within);
    const result = await readAnswer(snapshot, question, this.ai.ask);
    this.track(result.tokens);
    return result;
  }
  step(raw: unknown): Promise<StepResult> { return this.run(this.parse(raw)); }
  async run(step: S): Promise<StepResult> {
    const start = Date.now();
    this.ms = {};
    this.firstSnapshot = undefined;
    let result: StepResult;
    try {
      const valid = this.validate(step);
      result = valid.kind === 'expect' || valid.kind === 'wait' ? await this.assert(valid as unknown as Assert) : await this.act(valid, this.label(valid));
    } catch (error) { result = { step: this.label(step), status: 'error', detail: error instanceof Error ? error.message : String(error) }; }
    if (step.optional && (result.status === 'error' || result.status === 'inconclusive')) result.status = 'skipped';
    this.lastStepEnd = Date.now();
    return { ...result, ms: { total: this.lastStepEnd - start, ...this.ms } };
  }
  private async assert(step: Assert): Promise<StepResult> {
    const claims = step.kind === 'expect' ? step.expectations : [step.condition];
    const deadline = Date.now() + this.timeout;
    let polls = 0, last = '', probabilities: number[] = [], status: Status = 'inconclusive';
    let snap;
    // A wait polls its region too: one region pick, then only that part of the tree per poll.
    let region = step.within ? await this.region(step.within, true) : undefined;
    do {
      // Unchanged since a clear "no": asking again buys nothing.
      let looked;
      try {
        looked = await this.settled('region', region, (f) => judgeState(f.snapshot, claims, [], this.ai),
          (r) => this.track(r.tokens), (f) => JSON.stringify(f.snapshot) === last && status === 'fail');
      } catch (error) {
        // A region picked from an approximate capture turned out covered: pick it once more from an exact one.
        if (!(error instanceof HiddenTargetError) || this.ms.retargeted || !step.within) throw error;
        this.retarget(); region = await this.region(step.within); continue;
      }
      const { frame, result: judged } = looked;
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
    return { step: this.label(step as unknown as S), status, detail: `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}` };
  }
}

// Same input for Jev (tree text and candidates) and same native handles, so an answer about one frame holds for the other.
function sameFrame<T>(a: Frame<T>, b: Frame<T>): boolean {
  return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot) && JSON.stringify(a.candidates) === JSON.stringify(b.candidates) &&
    JSON.stringify([...a.elements]) === JSON.stringify([...b.elements]);
}

type NativeSpec<S> = HookSpec & { env: Record<string, unknown>; hooks?: string; goal?: string; steps: S[] };

/** hooks setup → `open` (interpolates, attaches, returns the resolved steps) → steps → teardown → close. */
export async function runNativeSpec<S extends { kind: string; optional?: boolean }, P extends NativeSpec<S>>(spec: P,
  session: NativeSession<unknown, string, S, NativeAdapter<unknown, string>>, open: (vars: { env: Record<string, unknown>; hooks: Record<string, unknown> }) => Promise<S[]>) {
  const steps: StepResult[] = [];
  let status: Status = 'pass';
  let hooks: HooksRunner<P> | undefined;
  let data: Record<string, unknown> = {};
  let setupDone = false;
  session.goal = spec.goal;
  try {
    if (spec.hooks) {
      hooks = await startHooks<P>(spec.hooks);
      if (hooks.has.setup) data = await hooks.setup(spec);
    }
    setupDone = true;
    for (const step of await open({ env: spec.env, hooks: data })) {
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

/** The desktop and mobile CLI: `mcp`, or spec files run one after another (one input stream: never concurrently). */
export async function nativeCli(bin: string, usage: string, options: Record<string, { type: 'string' }>, main: {
  serve(timeout: number, values: Record<string, string | undefined>): Promise<void>;
  run(file: string, timeout: number, values: Record<string, string | undefined>): Promise<{ status: Status }>;
}) {
  loadEnvFiles();
  try {
    const { values, positionals } = parseArgs({ options: { timeout: { type: 'string', default: '15000' }, ...options }, allowPositionals: true });
    const args = values as Record<string, string | undefined>;
    const timeout = Number(values.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be a positive number of milliseconds');
    if (!positionals.length) throw new Error(`usage: ${bin} [--timeout 15000] ${usage}mcp | <spec.yaml> [more.yaml ...]`);
    warmUp(); // connect to Jev while the session starts
    if (positionals[0] === 'mcp') {
      if (positionals.length !== 1) throw new Error('mcp takes no positional arguments');
      return await main.serve(timeout, args);
    }
    provider();
    let passed = true;
    for (const file of positionals) {
      try {
        const result = await main.run(file, timeout, args);
        console.log(JSON.stringify(result));
        if (result.status !== 'pass') passed = false;
      } catch (error) { console.error(`${file}: ${error}`); passed = false; }
    }
    process.exitCode = passed ? 0 : 1;
  } catch (error) { console.error(`${bin}: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; }
}
