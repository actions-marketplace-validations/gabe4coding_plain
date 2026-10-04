import { mark, unchangedSince } from './page.js';
import { settlePage } from './activity.js';
import { timed } from './context.js';
/**
 * Observes the page and asks Jev at once, while the page settles, instead of settle → observe → ask. The early
 * answer is kept when it is about the settled state: the main document did not mutate after the observation,
 * or a second look is the same. Otherwise the settled state is asked again. Returns the state the result is
 * about; the result is null when skipped.
 */
export async function settledAsk(ctx, question) {
    const { observe, same, ask, discard, skip } = question;
    const page = ctx.page;
    const before = await mark(page).catch(() => null);
    const first = await observe();
    const earlyAnswer = skip?.(first) ? null : ask(first);
    earlyAnswer?.catch(() => { }); // its error surfaces below, only if this answer is used
    const settled = await timed(ctx, 'settle', () => settlePage(page));
    let state = first;
    // The mark covers the main document only: look again when iframes exist, or when a popup became the active page.
    const mayHaveChanged = question.reobserve || ctx.page !== page || !unchangedSince(before, settled) || page.frames().length > 1;
    if (mayHaveChanged) {
        const again = await observe();
        if (!same(first, again))
            state = again;
    }
    if (state === first && earlyAnswer)
        return { state, result: await timed(ctx, 'jev', () => earlyAnswer) };
    if (earlyAnswer)
        ctx.ms.reasked = (ctx.ms.reasked ?? 0) + 1;
    const discarded = earlyAnswer?.then(discard, () => { });
    if (skip?.(state)) {
        await discarded;
        return { state, result: null };
    }
    const [result] = await timed(ctx, 'jev', () => Promise.all([ask(state), discarded]));
    return { state, result };
}
