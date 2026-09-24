import { parseArgs } from 'node:util';
import { intelligence, resolveTargets, judgeState, askSettled } from './automation.js';
import { decide, loadEnvFiles, provider, warmUp } from './jev.js';
import { timedInto, dumpDebug } from './results.js';
import { startHooks } from './hooks.js';
const EARLY_WINDOW_MS = 1000;
export class NativeSession {
    adapter;
    timeout;
    ai;
    calls = 0;
    tokens = 0;
    constructor(adapter, timeout = 15000, ai = intelligence) {
        this.adapter = adapter;
        this.timeout = timeout;
        this.ai = ai;
    }
    validate(step) { return step; }
    // Per-step phase timings (capture, jev, act, idle), reset by run() and returned as the result's `ms`.
    ms = {};
    timed(phase, fn) { return timedInto(this.ms, phase, fn); }
    track(tokens) { this.calls++; this.tokens += tokens; }
    // End of the last step. Seconds later (an agent's turn) the UI is idle, the settled capture is quick,
    // and an early capture would only add calls (measured: no gain with 5 s between steps).
    lastStepEnd = 0;
    /** The UI was just driven outside a step (the app was opened): the next step may find it busy. */
    noteActivity() { this.lastStepEnd = Date.now(); }
    // Captures the settled UI and asks Jev about it. Where the adapter offers an early capture (Android),
    // Jev already works on it while the adapter waits for the UI to go idle (askSettled) — only right
    // after the previous step, when the UI may still be busy.
    async settled(kind, within, ask, discard, skip) {
        const recent = Date.now() - this.lastStepEnd < EARLY_WINDOW_MS;
        const early = recent ? this.adapter.captureEarly?.bind(this.adapter) : undefined;
        const { frame, result, reasked } = await askSettled({
            early: early && (() => this.timed('capture', () => early(kind, within))),
            settled: () => this.timed('capture', () => this.adapter.capture(kind, within)),
            same: sameFrame, ask, discard, skip,
            waitAnswer: (fn) => this.timed('jev', fn),
        });
        if (reasked)
            this.ms.reasked = (this.ms.reasked ?? 0) + 1;
        return { frame, result };
    }
    async find(kind, targets) {
        const { result } = await this.settled(kind, undefined, (frame) => resolveTargets({ candidates: frame.candidates, state: frame.snapshot,
            element: (c) => { const el = frame.elements.get(c.id); if (el === undefined)
                throw new Error('Candidate handle missing'); return el; },
        }, targets, this.ai), ([first]) => { if (first?.usedJev)
            this.track(first.tokens); });
        for (const r of result)
            if (r.usedJev)
                this.track(r.tokens);
        return result;
    }
    /** The element a region description names; throws when Jev finds none. */
    async region(within) {
        const [r] = await this.find('region', [within]);
        if (r.element === null)
            throw new Error(r.detail);
        return r.element;
    }
    async snapshot(within) {
        const region = within ? await this.region(within) : undefined;
        return (await this.timed('capture', () => this.adapter.capture('region', region))).snapshot;
    }
    /** Judges claims once against the settled UI (or a region of it), without recording or polling: the MCP `ask` tool. */
    async ask(claims, within) {
        this.ms = {};
        const region = within ? await this.region(within) : undefined;
        const { frame, result } = await this.settled('region', region, (f) => judgeState(f.snapshot, claims, [], this.ai), (r) => this.track(r.tokens));
        this.track(result.tokens);
        return { snapshot: frame.snapshot, probabilities: result.probabilities, ms: this.ms };
    }
    step(raw) { return this.run(this.parse(raw)); }
    async run(step) {
        const start = Date.now();
        this.ms = {};
        let result;
        try {
            const valid = this.validate(step);
            result = valid.kind === 'expect' || valid.kind === 'wait' ? await this.assert(valid) : await this.act(valid, this.label(valid));
        }
        catch (error) {
            result = { step: this.label(step), status: 'error', detail: error instanceof Error ? error.message : String(error) };
        }
        if (step.optional && (result.status === 'error' || result.status === 'inconclusive'))
            result.status = 'skipped';
        this.lastStepEnd = Date.now();
        return { ...result, ms: { total: this.lastStepEnd - start, ...this.ms } };
    }
    async assert(step) {
        const claims = step.kind === 'expect' ? step.expectations : [step.condition];
        const deadline = Date.now() + this.timeout;
        let polls = 0, last = '', probabilities = [], status = 'inconclusive';
        let snap;
        do {
            const region = step.kind === 'expect' && step.within ? await this.region(step.within) : undefined;
            // Unchanged since a clear "no": asking again buys nothing.
            const { frame, result: judged } = await this.settled('region', region, (f) => judgeState(f.snapshot, claims, [], this.ai), (r) => this.track(r.tokens), (f) => JSON.stringify(f.snapshot) === last && status === 'fail');
            snap = frame.snapshot;
            if (judged) {
                this.track(judged.tokens);
                probabilities = judged.probabilities;
                polls++;
                const decisions = probabilities.map((p) => decide(p, 'expect'));
                status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
            }
            last = JSON.stringify(snap);
            if (step.kind === 'expect' || status === 'pass' || Date.now() >= deadline || polls >= 8)
                break;
            await this.timed('idle', () => new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now())))));
        } while (Date.now() < deadline);
        if (step.kind === 'wait' && status !== 'pass')
            status = 'inconclusive';
        const debug = status === 'pass' ? '' : ` — state: ${dumpDebug(step.kind, { claims, probabilities, state: snap })}`;
        return { step: this.label(step), status, detail: `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}` };
    }
}
// Same input for Jev (tree text and candidates) and same native handles, so an answer about one frame holds for the other.
function sameFrame(a, b) {
    return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot) && JSON.stringify(a.candidates) === JSON.stringify(b.candidates) &&
        JSON.stringify([...a.elements]) === JSON.stringify([...b.elements]);
}
/** hooks setup → `open` (interpolates, attaches, returns the resolved steps) → steps → teardown → close. */
export async function runNativeSpec(spec, session, open) {
    const steps = [];
    let status = 'pass';
    let hooks;
    let data = {};
    let setupDone = false;
    try {
        if (spec.hooks) {
            hooks = await startHooks(spec.hooks);
            if (hooks.has.setup)
                data = await hooks.setup(spec);
        }
        setupDone = true;
        for (const step of await open({ env: spec.env, hooks: data })) {
            const result = await session.run(step);
            steps.push(result);
            if (result.status !== 'pass' && result.status !== 'skipped') {
                status = result.status;
                break;
            }
        }
    }
    catch (error) {
        status = 'error';
        steps.push({ step: setupDone ? 'open/interpolate' : 'setup', status, detail: String(error) });
    }
    finally {
        try {
            if (setupDone && hooks?.has.teardown)
                await hooks.teardown({ spec, data, result: { status, steps } });
        }
        catch (error) {
            status = 'error';
            steps.push({ step: 'teardown', status, detail: String(error) });
        }
        finally {
            hooks?.close();
            try {
                await session.adapter.close();
            }
            catch (error) {
                status = 'error';
                steps.push({ step: 'close', status, detail: String(error) });
            }
        }
    }
    return { name: spec.name, status, steps, jevCalls: session.calls, totalTokens: session.tokens };
}
/** The desktop and mobile CLI: `mcp`, or spec files run one after another (one input stream: never concurrently). */
export async function nativeCli(bin, usage, options, main) {
    loadEnvFiles();
    try {
        const { values, positionals } = parseArgs({ options: { timeout: { type: 'string', default: '15000' }, ...options }, allowPositionals: true });
        const args = values;
        const timeout = Number(values.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0)
            throw new Error('--timeout must be a positive number of milliseconds');
        if (!positionals.length)
            throw new Error(`usage: ${bin} [--timeout 15000] ${usage}mcp | <spec.yaml> [more.yaml ...]`);
        warmUp(); // connect to Jev while the session starts
        if (positionals[0] === 'mcp') {
            if (positionals.length !== 1)
                throw new Error('mcp takes no positional arguments');
            return await main.serve(timeout, args);
        }
        provider();
        let passed = true;
        for (const file of positionals) {
            try {
                const result = await main.run(file, timeout, args);
                console.log(JSON.stringify(result));
                if (result.status !== 'pass')
                    passed = false;
            }
            catch (error) {
                console.error(`${file}: ${error}`);
                passed = false;
            }
        }
        process.exitCode = passed ? 0 : 1;
    }
    catch (error) {
        console.error(`${bin}: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 2;
    }
}
