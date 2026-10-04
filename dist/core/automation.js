import { z } from 'zod';
import { ask, isTooLong } from '../jev/ask.js';
import { decide } from '../jev/decide.js';
import { describeSnapshot } from '../jev/describe.js';
import { judge } from '../jev/judge.js';
import { pickElements } from '../jev/pick.js';
import { dumpDebug, topGuesses } from './results.js';
// What every engine (browser, desktop, mobile) shows Jev. Element handles stay inside the adapters.
export const CandidateSchema = z.object({
    id: z.number(),
    desc: z.string(),
    frameIndex: z.number().optional(),
    /** A browser text-entry field: the pick cache ignores its `value=`. */
    editable: z.boolean().optional(),
    /** The element's UI state in the browser (checked, expanded...), for the pick cache. Never sent to Jev. */
    state: z.string().optional(),
    /** Rendered edges in the main viewport's CSS pixels, requested for spatial targets. */
    bounds: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional(),
});
export const SnapshotSchema = z.object({
    url: z.string(),
    title: z.string(),
    aria: z.string(),
    truncated: z.boolean(),
    /** The tree of one region (`within`), not of the whole page. */
    region: z.boolean().optional(),
    /** Read-only rendered geometry, requested for spatial claims. */
    layout: z.string().optional(),
});
/** A pick from an approximate frame is covered or off screen: the caller picks again from an exact capture. */
export class HiddenTargetError extends Error {
    constructor(what = 'Mobile control') {
        super(`${what} is not visible (covered or off screen)`);
        this.name = 'HiddenTargetError';
    }
}
export const intelligence = { pick: pickElements, judge, describe: describeSnapshot, ask };
/** Resolves each target to an element: a pick cache hit acts on the stored pick, the misses share one Jev request. */
export async function resolveTargets(adapter, targets, ai = intelligence) {
    if (!adapter.candidates.length)
        return targets.map(() => ({ element: null, detail: 'no candidates', tokens: 0, usedJev: false }));
    const hits = targets.map((target, i) => adapter.cached?.(target, i));
    const asked = targets.filter((_, i) => !hits[i]);
    const picks = asked.length ? await ai.pick(adapter.candidates, asked, adapter.state) : [];
    let pickIndex = 0;
    return targets.map((target, i) => {
        const hit = hits[i];
        if (hit)
            return { element: adapter.element(hit), detail: `→ ${hit.desc}`, tokens: 0, usedJev: false, cached: true, candidate: hit };
        const isFirstPick = pickIndex === 0;
        const pick = picks[pickIndex++];
        if (!pick)
            throw new Error('Jev returned fewer picks than targets');
        const { id, probability, confidence, probabilities, tokens } = pick;
        const candidate = adapter.candidates.find((c) => c.id === id);
        const confidenceText = confidence === undefined ? '' : ` c=${confidence.toFixed(2)}`;
        const base = { tokens, usedJev: isFirstPick, confidence, score: confidence ?? probability };
        if (candidate && decide(confidence ?? probability, 'pick') === 'pass') {
            return { ...base, element: adapter.element(candidate), candidate,
                detail: `→ ${candidate.desc} (p=${probability.toFixed(2)}${confidenceText})` };
        }
        const file = dumpDebug('pick', { instruction: target, probabilities, confidence, candidates: adapter.candidates });
        const reason = id === null ? 'no matching element' : 'low confidence or invalid candidate';
        return { ...base, element: null,
            detail: `${reason}${confidenceText} — top: ${topGuesses(probabilities, adapter.candidates)} — candidates: ${file}` };
    });
}
/**
 * Asks Jev about an early observation while the settled one is still being taken, instead of settle →
 * observe → ask. The early answer is kept only when the settled observation is the same; otherwise the
 * settled one is asked, and the early answer is still awaited so `discard` can count its tokens.
 * `early` resolving to null (or throwing) means no early look. `skip`: no question is needed for this
 * observation; the result is then null. The browser has its own variant (settledAsk in src/browser/settled-ask.ts).
 */
export async function askSettled(options) {
    const { early, settled, same, discard, skip } = options;
    const waitAnswer = options.waitAnswer ?? ((fn) => fn());
    const earlyFrame = early ? await early().catch(() => null) : null;
    const earlyAnswer = earlyFrame !== null && !skip?.(earlyFrame) ? options.ask(earlyFrame) : null;
    earlyAnswer?.catch(() => { }); // its error surfaces below, only if this answer is used
    const frame = await settled();
    if (earlyAnswer && same(earlyFrame, frame))
        return { frame, result: await waitAnswer(() => earlyAnswer), reasked: false };
    const discarded = earlyAnswer?.then(discard, () => { });
    const reasked = earlyAnswer !== null;
    if (skip?.(frame)) {
        await discarded;
        return { frame, result: null, reasked };
    }
    const [result] = await waitAnswer(() => Promise.all([options.ask(frame), discarded]));
    return { frame, result, reasked };
}
const MIN_ARIA_TO_HALVE = 4000;
const SPATIAL_CLAIM_RULES = 'A spatial claim requires all its named text, current values, displayed selections, visibility and spatial relations to hold for the same elements. If any named text, value or selection differs, or required visible text belongs to an invisible element, the entire claim is false. A correct spatial relation alone does not make a claim with a mismatched name or value true. An available unselected option in the accessibility tree is not displayed by a collapsed select. Read the rendered evidence for physical position and visibility.';
/**
 * Judges claims against a snapshot. A state over the token limit is cut in half until it fits. A region goes
 * without the page URL: with it, Jev doubts a claim that a short region tree plainly shows. Without the title
 * too, it doubts claims phrased in the page's terms (docs/benchmarks/claims.md).
 */
export async function judgeState(snap, claims, events = [], ai = intelligence) {
    let aria = snap.aria;
    const page = snap.region ? { title: snap.title } : { url: snap.url, title: snap.title };
    for (;;) {
        try {
            const result = await ai.judge({ ...page, aria, events,
                ...(snap.layout ? { layout: snap.layout, layoutRules: SPATIAL_CLAIM_RULES } : {}) }, claims);
            if (result.probabilities.length !== claims.length)
                throw new Error('Jev returned fewer judgments than claims');
            return result;
        }
        catch (error) {
            if (!isTooLong(error) || aria.length < MIN_ARIA_TO_HALVE)
                throw error;
            aria = aria.slice(0, Math.floor(aria.length / 2));
            console.error(`plainwright: state too long for the model, aria cut to ${aria.length} chars — scope the expect with \`within\` for precision`);
        }
    }
}
