import { judgeState } from '../core/automation.js';
import { snapshot, snapshotRegion } from './page.js';
import { settledAsk } from './settled-ask.js';
import { resolveOne } from './locate.js';
import { timed } from './context.js';
import { needsLayout, prepareEvidence } from './evidence.js';
import { StepKind } from '../core/step-kind.js';
import { layoutSnapshot } from './layout.js';
const sameObserved = (a, b) => a.snap.url === b.snap.url && a.snap.title === b.snap.title && a.snap.aria === b.snap.aria && a.snap.layout === b.snap.layout &&
    a.events.length === b.events.length && a.events.every((event, i) => event === b.events[i]);
/** Judges claims against the whole settled page, in one request; null probabilities when `skip` says so. */
export async function judgeSettled(ctx, claims, skip) {
    const spatial = await needsLayout(ctx, claims);
    return judgeObservation(ctx, claims, spatial, undefined, skip);
}
async function judgeObservation(ctx, claims, spatial, within, skip) {
    const { state, result } = await settledAsk(ctx, {
        // A scoped region can live in a shadow root, outside the main document's mutation observer.
        reobserve: spatial || within !== undefined,
        observe: async () => ({ snap: await timed(ctx, 'snapshot', async () => {
                const page = ctx.page;
                const snap = await (within ? snapshotRegion(page, within) : snapshot(page));
                return spatial ? { ...snap, layout: await layoutSnapshot(page, within) } : snap;
            }), events: [...ctx.events] }),
        same: sameObserved,
        ask: ({ snap, events }) => judgeState(snap, claims, events),
        discard: (unused) => ctx.track(unused.tokens),
        skip,
    });
    if (result)
        ctx.track(result.tokens);
    return { state, probabilities: result?.probabilities ?? null };
}
/** Judges one claim against a region only; null probabilities when `skip` says so. */
export async function judgeRegion(ctx, region, claim, skip) {
    const spatial = await needsLayout(ctx, [claim]);
    return judgeObservation(ctx, [claim], spatial, region, skip);
}
/** One judgment of the claims, against the page or the region `within` names (`detail` when Jev finds no region). */
export async function judgeClaims(ctx, claims, within) {
    prepareEvidence(ctx, [{ kind: StepKind.expect, expectations: claims, within }]);
    if (within) {
        const region = await resolveOne(ctx, 'region', within);
        if (!region.element)
            return { detail: region.detail };
        const spatial = await needsLayout(ctx, claims);
        const { state, probabilities } = await judgeObservation(ctx, claims, spatial, region.element);
        return { snap: state.snap, probabilities: probabilities };
    }
    // Settled, because a client-side route change reaches `load` at once and the claim is about the content.
    const { state, probabilities } = await judgeSettled(ctx, claims);
    return { snap: state.snap, probabilities: probabilities };
}
/** The MCP `ask` tool: one judgment, like expect, but not a step: no status, not recorded. */
export async function askPage(ctx, claims, within) {
    ctx.ms = {};
    return { ...(await judgeClaims(ctx, claims, within)), ms: ctx.ms };
}
