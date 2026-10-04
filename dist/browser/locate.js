import { StepKind } from '../core/step-kind.js';
import { resolveTargets } from '../core/automation.js';
import { MAX_CANDIDATES } from '../jev/pick.js';
import { candidates, elementById } from './candidates.js';
import { settledAsk } from './settled-ask.js';
import { needsLayout } from './evidence.js';
import { layoutSnapshot, spatialCandidates } from './layout.js';
import { sleep, timed } from './context.js';
/** How long a step waits for a page with no candidates yet (still redirecting after `open`) to show some. */
const APPEAR_MS = 2000;
const APPEAR_POLL_MS = 150;
/** What to try instead when a step kind finds nothing at all to choose from. */
const NO_CANDIDATES_HINT = {
    [StepKind.check]: ' (no checkbox, radio, switch or aria-pressed toggle); for a plain button or chip use click',
    [StepKind.select]: ' (no native <select>); for a custom dropdown click the control, then click the option',
    [StepKind.upload]: ' (no file input); if the page opens a picker from a button, use css= on the hidden input',
};
/** One target, its Jev call counted. */
export async function resolveOne(ctx, kind, target) {
    const [resolved] = await resolveLocators(ctx, kind, [target]);
    if (resolved.usedJev)
        ctx.track(resolved.tokens);
    return resolved;
}
/**
 * Resolves several targets of one kind, in order. `css=` targets resolve directly; the others share one settle,
 * one candidate scan and one Jev request, whose tokens only the first Jev-resolved result carries.
 */
export async function resolveLocators(ctx, kind, targets) {
    const results = new Array(targets.length);
    const jevIndices = [];
    for (const [i, target] of targets.entries()) {
        if (target.startsWith('css='))
            results[i] = await resolveCss(ctx, target.slice(4));
        else
            jevIndices.push(i);
    }
    if (!jevIndices.length)
        return results;
    const jevTargets = jevIndices.map((i) => targets[i]);
    const step = ctx.step;
    // Only a step loaded from a file has a source, so an MCP step never uses the pick cache.
    const refs = ctx.picks && step?.at
        ? jevTargets.map((target) => ({ at: step.at, kind: step.kind, target, goal: ctx.spec.goal }))
        : undefined;
    const { state: { cands, url, title, layout }, result: picks } = await lookAndPick(ctx, kind, jevTargets, refs);
    const pickState = { url, title, ...(layout === undefined ? {} : { layout }) };
    // Only the answer kept is recorded: an early look's answer may have been discarded.
    if (refs)
        for (const [j, pick] of picks.entries()) {
            if (pick.cached) {
                ctx.picks.hit(refs[j], pickState);
                ctx.ms.cached = (ctx.ms.cached ?? 0) + 1;
            }
            else if (pick.candidate) {
                ctx.picks.accept(refs[j], pick.candidate, cands, pickState, pick.score ?? 0);
            }
        }
    const noCandidates = `no candidates: nothing on the page matches a ${kind} target${NO_CANDIDATES_HINT[kind] ?? ''}`;
    picks.forEach((pick, j) => {
        results[jevIndices[j]] = { ...pick, detail: cands.length ? pick.detail : noCandidates };
    });
    return results;
}
/** No match yet is left to Playwright's auto-wait; several matches would end in its strict-mode error dump. */
async function resolveCss(ctx, selector) {
    const element = ctx.page.locator(selector);
    const count = await element.count();
    return count > 1
        ? { element: null, detail: `css=${selector} matched ${count} elements; make the selector match exactly one`, tokens: 0, usedJev: false }
        : { element, detail: `→ css=${selector}`, tokens: 0, usedJev: false };
}
/**
 * Scans the candidates and asks Jev while the page settles, so debounced autocompletes and modals finish
 * rendering first. A page with no candidates yet, or one that navigates during the look, is looked at again
 * for up to APPEAR_MS.
 */
async function lookAndPick(ctx, kind, targets, refs) {
    let spatial;
    const deadline = Date.now() + Math.min(APPEAR_MS, ctx.timeout);
    for (;;) {
        const look = await settledAsk(ctx, {
            get reobserve() { return spatial === true; },
            // The active page is read on every look: a popup may replace it while the page settles, and a locator
            // belongs to the page that was scanned.
            observe: async () => {
                let page = ctx.page;
                let found = await timed(ctx, 'candidates', () => candidates(page, kind, MAX_CANDIDATES));
                if (found.length && spatial === undefined) {
                    spatial = await needsLayout(ctx, targets);
                    // Routing can outlast a render or replace the active page; geometry needs a fresh scan.
                    page = ctx.page;
                    found = await timed(ctx, 'candidates', () => candidates(page, kind, MAX_CANDIDATES));
                }
                const cands = spatial ? await timed(ctx, 'candidates', () => spatialCandidates(page, found)) : found;
                const layout = spatial ? await timed(ctx, 'snapshot', () => layoutSnapshot(page)) : undefined;
                return { page, cands, url: page.url(), title: await page.title(), ...(layout === undefined ? {} : { layout }) };
            },
            same: (a, b) => a.page === b.page && a.url === b.url && a.title === b.title && a.layout === b.layout && sameCandidates(a.cands, b.cands),
            ask: ({ page, cands, url, title, layout }) => resolveTargets({
                candidates: cands,
                state: { url, title, goal: ctx.spec.goal, ...(layout === undefined ? {} : { layout }) },
                element: (candidate) => elementById(page, candidate.id, candidate.frameIndex),
                ...(refs ? { cached: (_target, i) => ctx.picks.lookup(refs[i], cands, { url, title, ...(layout === undefined ? {} : { layout }) }) } : {}),
            }, targets),
            discard: (results) => {
                for (const result of results)
                    if (result.usedJev)
                        ctx.track(result.tokens);
            },
        }).catch((error) => {
            if (Date.now() < deadline && /context was destroyed|frame was detached|navigat/i.test(String(error)))
                return null;
            throw error;
        });
        const expired = Date.now() >= deadline;
        if (look && (look.state.cands.length || expired))
            return { state: look.state, result: look.result };
        if (expired)
            throw new Error('the page kept navigating; no candidates could be read');
        await timed(ctx, 'idle', () => sleep(APPEAR_POLL_MS));
    }
}
/** Geometry can omit a detached element, leaving gaps in the ids of an otherwise equal list. */
function sameCandidates(a, b) {
    return a.length === b.length && a.every((candidate, i) => candidate.id === b[i].id &&
        candidate.desc === b[i].desc && candidate.frameIndex === b[i].frameIndex &&
        JSON.stringify(candidate.bounds) === JSON.stringify(b[i].bounds));
}
