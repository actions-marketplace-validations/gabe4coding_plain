import { frameLabel } from './frames.js';
/** The candidate scan tags elements with it. Our own write is not the page changing, so every observer ignores it. */
const OWN_ATTRIBUTE = 'data-jev-id';
/** A hard cut, about 15k tokens. */
const ARIA_MAX_CHARS = 60_000;
/**
 * Records the time of the last DOM mutation in every new document of `target` (a page, or a context so popups
 * inherit it), so settle() can tell a page that is already quiet. `__plainwrightDoc` identifies the document:
 * a mark taken before a navigation is never compared with the next document's clock. Only mutations after the
 * load event count: building the page is not a rendering burst to wait out once it has loaded.
 */
export async function installSettleObserver(target) {
    await target.addInitScript((own) => {
        window.__plainwrightDoc = Math.random();
        window.__plainwrightLastMutation = -1e9;
        new MutationObserver((records) => {
            if (document.readyState !== 'complete')
                return;
            if (records.some((record) => record.attributeName !== own))
                window.__plainwrightLastMutation = performance.now();
        }).observe(document, { childList: true, subtree: true, attributes: true });
    }, OWN_ATTRIBUTE);
}
/** Now, on the main document's clock; null without the observer or while the document is still loading. */
export function mark(page) {
    return page.evaluate(() => (typeof window.__plainwrightDoc === 'number' && document.readyState === 'complete'
        ? { doc: window.__plainwrightDoc, t: performance.now() }
        : null));
}
/** True when the main document provably did not mutate between `before` (a mark) and `after` (settle's result). */
export function unchangedSince(before, after) {
    return before !== null && after !== null && before.doc === after.doc && after.t <= before.t;
}
/**
 * Waits until the DOM has not mutated for `quietMs`, at most `maxMs`. When the observer already saw the page
 * quiet, it resolves at once, or waits only the rest of the quiet window. Without the observer (an existing tab
 * attached over CDP) it waits a full window. Resolves to the document's last mutation, for unchangedSince().
 */
export function settle(page, quietMs = 500, maxMs = 3000) {
    return page.evaluate(({ quietMs, maxMs, own }) => new Promise((resolve) => {
        const lastMutation = () => {
            const doc = window.__plainwrightDoc;
            const t = window.__plainwrightLastMutation;
            return typeof doc === 'number' && typeof t === 'number' ? { doc, t } : null;
        };
        // A document still loading is never quiet already: the parser's inserts are not counted.
        const last = document.readyState === 'complete' ? window.__plainwrightLastMutation : undefined;
        if (typeof last === 'number' && performance.now() - last >= quietMs)
            return resolve(lastMutation());
        const firstWait = typeof last === 'number' ? quietMs - (performance.now() - last) : quietMs;
        let timer = setTimeout(done, firstWait);
        const observer = new MutationObserver((records) => {
            if (records.every((record) => record.attributeName === own))
                return;
            clearTimeout(timer);
            timer = setTimeout(done, quietMs);
        });
        const cap = setTimeout(done, maxMs);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        function done() {
            observer.disconnect();
            clearTimeout(timer);
            clearTimeout(cap);
            resolve(lastMutation());
        }
    }), { quietMs, maxMs, own: OWN_ATTRIBUTE });
}
/** Resolves true on the first DOM mutation, false after `maxMs` without one. */
export function waitForMutation(page, maxMs) {
    return page.evaluate(({ maxMs, own }) => new Promise((resolve) => {
        const observer = new MutationObserver((records) => {
            if (records.every((record) => record.attributeName === own))
                return;
            observer.disconnect();
            clearTimeout(timer);
            resolve(true);
        });
        const timer = setTimeout(() => {
            observer.disconnect();
            resolve(false);
        }, maxMs);
        observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    }), { maxMs, own: OWN_ATTRIBUTE });
}
/**
 * Playwright marks a checked control `[checked]` and an unchecked one with nothing, and Jev reads a missing mark
 * as weak evidence (docs/benchmarks/claims.md). An explicit `[checked=false]`, Playwright's own syntax, makes the
 * state a fact on the line. Matches the role, an optional quoted name, then any `[...]` attributes.
 */
const CHECKABLE_LINE = /^(\s*- '?(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio)(?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]*\])*)(?=[:']|$)/gm;
export function markUnchecked(aria) {
    return aria.replace(CHECKABLE_LINE, (line, head, attributes) => attributes.includes('[checked') ? line : `${head}${attributes} [checked=false]`);
}
/** Longer link targets are ad and tracking links, by measure: real ones on the saved content pages stay under 250. */
const MAX_URL_CHARS = 200;
const URL_LINE = /^(\s*- \/url: )(.*)$/gm;
/**
 * Cuts each link target over MAX_URL_CHARS to its part before `?` or `#`, and that to MAX_URL_CHARS, marked with
 * `…`. An ad link's target can be 2,000 characters of query, and the URLs of a few ads were 90% of a whole-page
 * claim's tokens (docs/benchmarks/claims.md). A claim names what a link says, and an agent clicks a link by its
 * name or reads the full href with `evaluate`. Every snapshot gets it: claims, the MCP snapshot, read and changed.
 */
export function shortenUrls(aria) {
    return aria.replace(URL_LINE, (line, head, value) => {
        if (value.length <= MAX_URL_CHARS)
            return line;
        const url = value.replace(/^(["'])(.*)\1$/, '$2');
        return `${head}${url.split(/[?#]/, 1)[0].slice(0, MAX_URL_CHARS)}…`;
    });
}
/** Long link targets are cut (shortenUrls) before the 60k cap, so ad links do not push page content out. */
function toSnapshot(page, title, aria) {
    const marked = markUnchecked(shortenUrls(aria));
    return { url: page.url(), title, aria: marked.slice(0, ARIA_MAX_CHARS), truncated: marked.length > ARIA_MAX_CHARS };
}
/** The page's accessibility tree, each iframe's tree appended under its own header. An empty iframe has none. */
export async function snapshot(page) {
    const iframes = page.frames().slice(1);
    const [title, bodyAria, iframeArias] = await Promise.all([
        page.title(),
        page.locator('body').ariaSnapshot(),
        Promise.all(iframes.map((frame) => frame.locator('body').ariaSnapshot().catch(() => null))), // detached or cross-origin
    ]);
    const iframeSections = iframes.map((frame, i) => iframeArias[i] ? `\n--- iframe ${frameLabel(frame)} ---\n${iframeArias[i]}` : '');
    return toSnapshot(page, title, bodyAria + iframeSections.join(''));
}
/** snapshot() of one region, for `within`. */
export async function snapshotRegion(page, region) {
    const [title, aria] = await Promise.all([page.title(), region.ariaSnapshot()]);
    return { ...toSnapshot(page, title, aria), region: true };
}
