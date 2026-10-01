import { frameLabel } from './frames.js';
export { CandidateSchema, SnapshotSchema } from './automation.js';
export { CandidateKindSchema, candidates, elementById } from './candidates.js';
// The candidate scan tags elements with data-jev-id. That is our own write, not the page changing, so
// every observer below ignores it — otherwise each scan would restart the quiet window it just waited out.
const OWN_ATTRIBUTE = 'data-jev-id';
/**
 * Installs a MutationObserver at document start in every new document of `target` (a page, or a context
 * so popups inherit it), recording the time
 * of the last DOM mutation on `window.__plainwrightLastMutation`. `settle()` reads it to tell a page
 * that's already quiet from one that still needs to wait out the rest of its quiet window.
 * `__plainwrightDoc` identifies the document, so a mark taken before a navigation is never compared
 * with the next document's clock.
 * Only mutations after the load event count: building the page is not a rendering burst to wait out
 * once it has loaded (every step after a goto used to wait a full quiet window for the parser's last
 * insert). Until then the document is not settled at all (see settle and mark).
 */
export async function installSettleObserver(target) {
    await target.addInitScript((own) => {
        window.__plainwrightDoc = Math.random();
        window.__plainwrightLastMutation = -1e9;
        new MutationObserver((records) => {
            if (document.readyState !== 'complete')
                return;
            if (records.some((r) => r.attributeName !== own))
                window.__plainwrightLastMutation = performance.now();
        }).observe(document, { childList: true, subtree: true, attributes: true });
    }, OWN_ATTRIBUTE);
}
/** Now, on the main document's clock; null where the observer is not installed or the document is still loading. */
export function mark(page) {
    return page.evaluate(() => (typeof window.__plainwrightDoc === 'number' && document.readyState === 'complete' ? { doc: window.__plainwrightDoc, t: performance.now() } : null));
}
/** True when the main document provably did not mutate between `before` (a mark) and `after` (settle's result). */
export function unchangedSince(before, after) {
    return before !== null && after !== null && before.doc === after.doc && after.t <= before.t;
}
/**
 * Wait until the DOM stops mutating for `quietMs` (debounced autocompletes, modals), giving up after
 * `maxMs`. Retroactive: if `installSettleObserver` recorded the DOM as already quiet for `quietMs`,
 * resolves immediately; otherwise waits only the remaining quiet time. Falls back to a full `quietMs`
 * prospective wait when the observer wasn't installed (e.g. an existing tab attached over CDP).
 * Resolves to the time of the document's last mutation (null without the observer), for `unchangedSince`.
 */
export function settle(page, quietMs = 500, maxMs = 3000) {
    return page.evaluate(({ quietMs, maxMs, own }) => new Promise((resolve) => {
        const lastMutation = () => {
            const doc = window.__plainwrightDoc;
            const t = window.__plainwrightLastMutation;
            return typeof doc === 'number' && typeof t === 'number' ? { doc, t } : null;
        };
        // A document still loading is never retroactively quiet: its parser inserts are not counted.
        const last = document.readyState === 'complete' ? window.__plainwrightLastMutation : undefined;
        if (typeof last === 'number' && performance.now() - last >= quietMs)
            return resolve(lastMutation());
        const initialWait = typeof last === 'number' ? quietMs - (performance.now() - last) : quietMs;
        let timer = setTimeout(done, initialWait);
        const obs = new MutationObserver((records) => {
            if (records.every((r) => r.attributeName === own))
                return;
            clearTimeout(timer);
            timer = setTimeout(done, quietMs);
        });
        const cap = setTimeout(done, maxMs);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        function done() {
            obs.disconnect();
            clearTimeout(timer);
            clearTimeout(cap);
            resolve(lastMutation());
        }
    }), { quietMs, maxMs, own: OWN_ATTRIBUTE });
}
/** Resolves true on the first DOM mutation, false after `maxMs` without one. */
export function waitForMutation(page, maxMs) {
    return page.evaluate(({ maxMs, own }) => new Promise((resolve) => {
        const obs = new MutationObserver((records) => {
            if (records.every((r) => r.attributeName === own))
                return;
            obs.disconnect();
            clearTimeout(timer);
            resolve(true);
        });
        const timer = setTimeout(() => { obs.disconnect(); resolve(false); }, maxMs);
        obs.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    }), { maxMs, own: OWN_ATTRIBUTE });
}
const ARIA_MAX_CHARS = 60_000; // ponytail: hard truncate, no smart summarization — ≈15k tokens, ≈$0.0006/call
// Playwright marks a checked control `[checked]` and an unchecked one with nothing, and Jev reads a missing
// mark as weak evidence: "the checkbox is checked" on an unchecked box came out inconclusive, not failed
// (docs/benchmarks/claims.md). An explicit `[checked=false]` (Playwright's own syntax, and what the mobile tree
// already writes) makes the state a fact on the line. Role, optional quoted name, then any `[...]` attributes.
const CHECKABLE_LINE = /^(\s*- '?(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio)(?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]*\])*)(?=[:']|$)/gm;
export function markUnchecked(aria) {
    return aria.replace(CHECKABLE_LINE, (line, head, attrs) => attrs.includes('[checked') ? line : `${head}${attrs} [checked=false]`);
}
function toSnapshot(page, title, aria) {
    aria = markUnchecked(aria);
    return { url: page.url(), title, aria: aria.slice(0, ARIA_MAX_CHARS), truncated: aria.length > ARIA_MAX_CHARS };
}
export async function snapshot(page) {
    const frames = page.frames();
    const iframeFrames = frames.slice(1);
    const [title, bodyAria, iframeArias] = await Promise.all([
        page.title(),
        page.locator('body').ariaSnapshot(),
        // detached or cross-origin — skip, never fatal
        Promise.all(iframeFrames.map((f) => f.locator('body').ariaSnapshot().catch(() => null))),
    ]);
    const iframes = iframeFrames.map((frame, i) => iframeArias[i] === null ? '' : `\n--- iframe ${frameLabel(frame)} ---\n${iframeArias[i]}`);
    return toSnapshot(page, title, bodyAria + iframes.join(''));
}
/** Same as `snapshot()` but scoped to one region locator, for `expect: { that, within }`. */
export async function snapshotRegion(page, locator) {
    const [title, ariaFull] = await Promise.all([page.title(), locator.ariaSnapshot()]);
    return toSnapshot(page, title, ariaFull);
}
