import { interpolate } from './spec.js';
import { parseMobileStep, validateMobileStep, mobileLabel } from './mobile-spec.js';
import { intelligence, resolveTargets, judgeState } from './automation.js';
import { decide } from './jev.js';
import { dumpDebug } from './results.js';
import { startHooks } from './hooks.js';
export class MobileSession {
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
    track(tokens) { this.calls++; this.tokens += tokens; }
    async find(kind, targets) {
        const frame = await this.adapter.capture(kind);
        const resolved = await resolveTargets({ candidates: frame.candidates, state: frame.snapshot,
            element: (c) => { const el = frame.elements.get(c.id); if (el === undefined)
                throw new Error('Candidate handle missing'); return el; },
        }, targets, this.ai);
        for (const r of resolved)
            if (r.usedJev)
                this.track(r.tokens);
        return resolved;
    }
    async snapshot(within) {
        if (!within)
            return (await this.adapter.capture('region')).snapshot;
        const [r] = await this.find('region', [within]);
        if (r.element === null)
            throw new Error(r.detail);
        return (await this.adapter.capture('region', r.element)).snapshot;
    }
    async step(raw) {
        const step = parseMobileStep(raw);
        return this.run(step);
    }
    async run(step) {
        const start = Date.now();
        let result;
        try {
            result = await this.execute(validateMobileStep(step));
        }
        catch (error) {
            result = { step: mobileLabel(step), status: 'error', detail: error instanceof Error ? error.message : String(error) };
        }
        if (step.optional && (result.status === 'error' || result.status === 'inconclusive'))
            result.status = 'skipped';
        return { ...result, ms: { total: Date.now() - start } };
    }
    async execute(step) {
        const name = mobileLabel(step);
        if (step.kind === 'expect' || step.kind === 'wait') {
            const claims = step.kind === 'expect' ? step.expectations : [step.condition];
            const deadline = Date.now() + this.timeout;
            let polls = 0, last = '', probabilities = [], status = 'inconclusive';
            let snap;
            do {
                snap = await this.snapshot(step.kind === 'expect' ? step.within : undefined);
                const key = JSON.stringify(snap);
                if (key !== last || status !== 'fail') {
                    const judged = await judgeState(snap, claims, [], this.ai);
                    this.track(judged.tokens);
                    probabilities = judged.probabilities;
                    polls++;
                    const decisions = probabilities.map((p) => decide(p, 'expect'));
                    status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
                }
                last = key;
                if (step.kind === 'expect' || status === 'pass' || Date.now() >= deadline || polls >= 8)
                    break;
                await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
            } while (Date.now() < deadline);
            if (step.kind === 'wait' && status !== 'pass')
                status = 'inconclusive';
            const debug = status === 'pass' ? '' : ` — state: ${dumpDebug(step.kind, { claims, probabilities, state: snap })}`;
            return { step: name, status, detail: `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}` };
        }
        if (step.kind === 'press')
            await this.adapter.press(step.key);
        else if (step.kind === 'swipe') {
            let element;
            if (step.within) {
                const [r] = await this.find('region', [step.within]);
                if (r.element === null)
                    return { step: name, status: 'inconclusive', detail: r.detail };
                element = r.element;
            }
            await this.adapter.gesture('swipe', step.direction, element);
        }
        else {
            const kind = step.kind === 'fill' ? 'fill' : step.kind === 'check' || step.kind === 'uncheck' ? 'check' :
                step.kind === 'scroll' ? 'scroll' : 'click';
            const target = step.kind === 'scroll' ? step.target.replace(/^(up|down|left|right):\s*/, '') : step.target;
            const [r] = await this.find(kind, [target]);
            if (r.element === null)
                return { step: name, status: 'inconclusive', detail: r.detail };
            if (step.kind === 'scroll')
                await this.adapter.gesture('scroll', step.target.split(':')[0], r.element);
            else
                await this.adapter.act(step.kind, r.element, step.kind === 'fill' ? step.value : undefined);
            return { step: name, status: 'pass', detail: r.detail };
        }
        return { step: name, status: 'pass' };
    }
}
export async function runMobileSpec(spec, session) {
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
        const resolved = interpolate({ platform: spec.platform, device: spec.device, app: spec.app, capabilities: spec.capabilities, steps: spec.steps }, { env: spec.env, hooks: data }, spec.name);
        const { steps: resolvedSteps, ...target } = resolved;
        await session.adapter.open(target);
        for (const step of resolvedSteps) {
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
