import { settle } from './page.js';
import { sleep, timed } from './context.js';
/** The DOM must be quiet this long before a step looks at it. Requests are waited for on their own. */
const SETTLE_QUIET_MS = 150;
const SETTLE_MAX_MS = 3000;
/** An older request is a long poll, a stream or a stuck beacon: no longer a response the page is about to render. */
const YOUNG_REQUEST_MS = 2000;
/** The longest an action waits for the navigation or the requests it may start. */
const ACTION_WATCH_MS = 1500;
const POLL_MS = 25;
const activityByPage = new WeakMap();
/**
 * The page's request tracker, wired on first use: a popup that becomes the active page is tracked from its
 * first action on. Document requests count too: a navigation that turns into a download never fires
 * `framenavigated`, and its request bridges the gap until the download handler holds the page.
 */
function activityOf(page) {
    const existing = activityByPage.get(page);
    if (existing)
        return existing;
    const activity = { inflight: new Map(), held: 0, lastActivity: Date.now(), settleAfter: 0 };
    activityByPage.set(page, activity);
    const isTracked = (request) => ['xhr', 'fetch', 'document'].includes(request.resourceType());
    page.on('request', (request) => {
        if (isTracked(request))
            activity.inflight.set(request, Date.now());
    });
    const onDone = (request) => {
        // A request that started before tracking was wired was never counted.
        if (activity.inflight.delete(request))
            activity.lastActivity = Date.now();
    };
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);
    return activity;
}
const pendingCount = (activity) => activity.inflight.size + activity.held;
function youngCount(activity) {
    const now = Date.now();
    let count = activity.held;
    for (const started of activity.inflight.values())
        if (now - started < YOUNG_REQUEST_MS)
            count++;
    return count;
}
/** Keeps the page unsettled until the returned function is called (a popup loading, a download being saved). */
export function holdActivity(page) {
    const activity = activityOf(page);
    activity.held++;
    return () => {
        activity.held = Math.max(0, activity.held - 1);
        activity.lastActivity = Date.now();
    };
}
/**
 * Waits until the DOM is quiet and no young request is in flight (a client-rendered page may fetch for a while
 * before it changes the DOM), at most SETTLE_MAX_MS. Resolves to the document's last mutation, as settle() does;
 * null when it cannot be read (no observer, or a navigation mid-evaluate): callers then treat the page as changed.
 */
export async function settlePage(page) {
    const activity = activityOf(page);
    await waitHold(page);
    const deadline = Date.now() + SETTLE_MAX_MS;
    for (;;) {
        const lastMutation = await settle(page, SETTLE_QUIET_MS, Math.max(0, deadline - Date.now())).catch(() => null);
        if (youngCount(activity) === 0 || Date.now() >= deadline)
            return lastMutation;
        while (youngCount(activity) > 0 && Date.now() < deadline)
            await sleep(POLL_MS);
    }
}
/** Waits out what is left of the last action's holdMs (see mayNavigate). */
export async function waitHold(page) {
    const left = activityOf(page).settleAfter - Date.now();
    if (left > 0)
        await sleep(left);
}
/**
 * Runs an action that may navigate (a link, Enter in a form) or start a request (typing into a debounced
 * autocomplete), and waits for whichever shows up instead of a flat timeout. A navigation always wins and is
 * awaited to `load`. Otherwise the page gets `graceMs` to start a request, then `graceMs` of quiet after the
 * last one ends. At most ACTION_WATCH_MS.
 * `holdMs`: the page is not settled before this long after the action (a debounced request may start only after
 * ~400 ms). That rest is waited by the next step's settle, so the next step's Jev call runs meanwhile.
 */
export async function mayNavigate(ctx, action, graceMs = 50, holdMs = 200) {
    const page = ctx.page;
    const activity = activityOf(page); // before the action, so the requests it starts are counted
    let navigated = false;
    const navigation = page
        .waitForEvent('framenavigated', { timeout: ACTION_WATCH_MS, predicate: (frame) => frame === page.mainFrame() })
        .then(() => {
        navigated = true;
        return page.waitForLoadState('load');
    })
        .catch(() => { }); // no navigation: the wait times out
    await timed(ctx, 'action', action);
    const actionEnd = Date.now();
    if (holdMs > graceMs)
        activity.settleAfter = actionEnd + holdMs;
    await timed(ctx, 'post', async () => {
        while (Date.now() - actionEnd < ACTION_WATCH_MS) {
            if (navigated)
                return navigation;
            const quietSince = Math.max(actionEnd, activity.lastActivity);
            if (pendingCount(activity) === 0 && Date.now() - quietSince >= graceMs)
                return;
            await sleep(10);
        }
    });
}
