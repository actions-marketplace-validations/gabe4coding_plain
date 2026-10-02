import { intelligence, resolveTargets, judgeState, askSettled, HiddenTargetError } from '../core/automation.js';
import { timedInto, dumpDebug, errorMessage } from '../core/results.js';
import { readAnswer } from '../core/read.js';
import { decideAll } from '../jev/decide.js';
const isAssertion = (step) => step.kind === 'expect' || step.kind === 'wait';
/** Right after a step the UI may still be busy, so an early capture can save time. Later it only adds calls. */
const EARLY_WINDOW_MS = 1000;
/** A key or click that opens a window returns before the window exists: an empty capture is looked at again. */
const APPEAR_MS = 2000;
const APPEAR_POLL_MS = 150;
const MAX_WAIT_POLLS = 8;
const WAIT_POLL_MS = 250;
/**
 * Jev targeting, expect/wait polling and phase timing for the desktop and mobile engines. A subclass parses,
 * labels and performs its platform's actions.
 */
export class NativeSession {
    adapter;
    timeout;
    ai;
    calls = 0;
    tokens = 0;
    /** What the whole flow is for (spec `goal:`, MCP `open {goal}`): every pick sees it, claims never do. */
    goal;
    /** This attempt's pick cache; spec runs only, never an MCP session. */
    picks;
    /** The first whole-screen capture of the current step, before it acted: the MCP `changed` diffs against it. */
    firstSnapshot;
    /** Returned as the result's `ms`. */
    phaseMs = {};
    /** Its source and kind key the pick cache. */
    currentStep;
    lastStepEnd = 0;
    constructor(adapter, timeout = 15000, ai = intelligence) {
        this.adapter = adapter;
        this.timeout = timeout;
        this.ai = ai;
    }
    validate(step) { return step; }
    timed(phase, fn) { return timedInto(this.phaseMs, phase, fn); }
    track(tokens) {
        this.calls++;
        this.tokens += tokens;
    }
    /** The UI was just driven outside a step (the app was opened): the next step may find it busy. */
    noteActivity() { this.lastStepEnd = Date.now(); }
    step(raw) { return this.run(this.parse(raw)); }
    async run(step) {
        const start = Date.now();
        this.phaseMs = {};
        this.firstSnapshot = undefined;
        this.currentStep = step;
        let result;
        try {
            const valid = this.validate(step);
            result = isAssertion(valid) ? await this.assert(valid) : await this.act(valid, this.label(valid));
        }
        catch (error) {
            result = { step: this.label(step), status: 'error', detail: errorMessage(error) };
        }
        if (step.optional && (result.status === 'error' || result.status === 'inconclusive'))
            result.status = 'skipped';
        if (this.phaseMs.cached)
            result = { ...result, cached: true, detail: result.detail ? `${result.detail} (cached pick)` : '(cached pick)' };
        this.lastStepEnd = Date.now();
        return { ...result, ms: { total: this.lastStepEnd - start, ...this.phaseMs } };
    }
    /** Resolves targets of one kind with one Jev request; pick cache hits skip Jev. */
    async find(kind, targets, regionPick = false) {
        const deadline = Date.now() + Math.min(APPEAR_MS, this.timeout);
        const step = this.currentStep;
        const picks = this.picks;
        // Only a step loaded from a file has a source, so an MCP step never uses the pick cache.
        const refs = picks && step?.at
            ? targets.map((target) => ({ at: step.at, kind: step.kind, target, goal: this.goal }))
            : undefined;
        const pick = (frame) => resolveTargets({
            candidates: frame.candidates,
            state: { ...frame.snapshot, ...(this.goal ? { goal: this.goal } : {}) },
            element: (candidate) => {
                const element = frame.elements.get(candidate.id);
                if (element === undefined)
                    throw new Error('Candidate handle missing');
                return element;
            },
            ...(refs ? { cached: (_target, i) => picks.lookup(refs[i], frame.candidates, frame.snapshot) } : {}),
        }, targets, this.ai);
        for (;;) {
            const { frame, result } = await this.settled({ kind, ask: pick, discard: (unused) => this.trackResolved(unused), regionPick });
            if (frame.candidates.length === 0 && Date.now() < deadline) {
                await this.timed('idle', () => new Promise((resolve) => setTimeout(resolve, APPEAR_POLL_MS)));
                continue;
            }
            const resolved = result;
            this.trackResolved(resolved);
            // Only the answer kept is recorded: an early capture's answer may have been discarded.
            if (refs)
                for (const [i, target] of resolved.entries()) {
                    if (target.cached) {
                        picks.hit(refs[i], frame.snapshot);
                        this.phaseMs.cached = (this.phaseMs.cached ?? 0) + 1;
                    }
                    else if (target.candidate) {
                        picks.accept(refs[i], target.candidate, frame.candidates, frame.snapshot);
                    }
                }
            return frame.approximate ? resolved.map((target) => ({ ...target, approximate: true })) : resolved;
        }
    }
    async snapshot(within) {
        return this.inRegion(within, async (region) => (await this.timed('capture', () => this.adapter.capture('region', region))).snapshot);
    }
    /** The MCP `ask` tool: judges claims once against the settled UI or a region of it; no polling, not recorded. */
    async ask(claims, within) {
        this.phaseMs = {};
        const { frame, result } = await this.inRegion(within, (region) => this.settled({ kind: 'region', within: region, ask: this.judge(claims), discard: (unused) => this.track(unused.tokens) }));
        this.track(result.tokens);
        return { snapshot: frame.snapshot, probabilities: result.probabilities, ms: this.phaseMs };
    }
    /** The MCP `read` tool: the tree lines that answer `question`; not recorded. */
    async read(question, within) {
        const snapshot = await this.snapshot(within);
        const result = await readAnswer(snapshot, question, this.ai.ask);
        this.track(result.tokens);
        return result;
    }
    /**
     * The element a region description names; throws when Jev finds none. `allowApproximate`: the adapter may pick it from an
     * approximate capture (a rejected pick there is asked again from an exact one); the first look inside the
     * region then confirms it shows something, or throws HiddenTargetError.
     */
    async region(within, allowApproximate = false) {
        let [resolved] = await this.find('region', [within], allowApproximate);
        if (resolved.approximate && resolved.element === null) {
            this.retarget();
            [resolved] = await this.find('region', [within]);
        }
        if (resolved.element === null)
            throw new Error(resolved.detail);
        return resolved.element;
    }
    retarget() {
        this.phaseMs.retargeted = 1;
        this.adapter.preferExact?.();
    }
    /** Runs `look` inside the region `within` names, picked fast where the adapter can; a covered one is picked again. */
    async inRegion(within, look) {
        if (!within)
            return look(undefined);
        const region = await this.region(within, true);
        try {
            return await look(region);
        }
        catch (error) {
            if (!(error instanceof HiddenTargetError))
                throw error;
            this.retarget();
            return look(await this.region(within));
        }
    }
    /**
     * Captures the settled UI and asks Jev about it. Right after the previous step, where the adapter offers an
     * early capture (Android), Jev already works on it while the adapter waits for the UI to go idle.
     */
    async settled({ kind, within, ask, discard, skip, regionPick = false }) {
        const recent = Date.now() - this.lastStepEnd < EARLY_WINDOW_MS;
        const captureEarly = recent ? this.adapter.captureEarly?.bind(this.adapter) : undefined;
        const { frame, result, reasked } = await askSettled({
            early: captureEarly && (() => this.timed('capture', () => captureEarly(kind, within))),
            settled: async () => {
                const options = regionPick ? { regionPick } : undefined;
                const frame = await this.timed('capture', () => this.adapter.capture(kind, within, options));
                if (within === undefined && !frame.approximate)
                    this.firstSnapshot ??= frame.snapshot;
                return frame;
            },
            same: sameFrame,
            ask,
            discard,
            skip,
            waitAnswer: (fn) => this.timed('jev', fn),
        });
        if (reasked)
            this.phaseMs.reasked = (this.phaseMs.reasked ?? 0) + 1;
        return { frame, result };
    }
    /**
     * `expect` judges once; `wait` polls until the claim holds. Both judge a region alone when `within` names one.
     * An unchanged UI after a clear "no" is not asked again.
     */
    async assert(step) {
        const claims = step.kind === 'expect' ? step.expectations : [step.condition];
        const deadline = Date.now() + this.timeout;
        let polls = 0;
        let lastSnapshotJson = '';
        let probabilities = [];
        let status = 'inconclusive';
        let lastSnapshot;
        let region = step.within ? await this.region(step.within, true) : undefined;
        const unchangedSinceNo = (frame) => JSON.stringify(frame.snapshot) === lastSnapshotJson && status === 'fail';
        do {
            let looked;
            try {
                looked = await this.settled({
                    kind: 'region', within: region, ask: this.judge(claims), discard: (unused) => this.track(unused.tokens), skip: unchangedSinceNo,
                });
            }
            catch (error) {
                // A region picked from an approximate capture turned out covered: pick it once more from an exact one.
                if (!(error instanceof HiddenTargetError) || this.phaseMs.retargeted || !step.within)
                    throw error;
                this.retarget();
                region = await this.region(step.within);
                continue;
            }
            const { frame, result: judged } = looked;
            lastSnapshot = frame.snapshot;
            if (judged) {
                this.track(judged.tokens);
                probabilities = judged.probabilities;
                polls++;
                status = decideAll(probabilities);
            }
            lastSnapshotJson = JSON.stringify(lastSnapshot);
            if (step.kind === 'expect' || status === 'pass' || Date.now() >= deadline || polls >= MAX_WAIT_POLLS)
                break;
            const pause = Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()));
            await this.timed('idle', () => new Promise((resolve) => setTimeout(resolve, pause)));
        } while (Date.now() < deadline);
        if (step.kind === 'wait' && status !== 'pass')
            status = 'inconclusive';
        const debug = status === 'pass' ? '' : ` — state: ${dumpDebug(step.kind, { claims, probabilities, state: lastSnapshot })}`;
        const detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}`;
        return { step: this.label(step), status, detail };
    }
    judge(claims) {
        return (frame) => judgeState(frame.snapshot, claims, [], this.ai);
    }
    trackResolved(resolved) {
        for (const target of resolved)
            if (target.usedJev)
                this.track(target.tokens);
    }
}
/** Same tree text, candidates and native handles: an answer about one frame holds for the other. */
function sameFrame(a, b) {
    return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot)
        && JSON.stringify(a.candidates) === JSON.stringify(b.candidates)
        && JSON.stringify([...a.elements]) === JSON.stringify([...b.elements]);
}
