import type { Page, Frame, Locator, BrowserContext } from 'playwright';

import type { Snapshot } from './automation.js';

// Iframe name, or pathname. The candidate scan keeps the same private helper.
function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try { return new URL(frame.url()).pathname || frame.url(); } catch { return frame.url(); }
}

export { CandidateSchema, type Candidate, SnapshotSchema, type Snapshot } from './automation.js';
export { CandidateKindSchema, candidates, elementById, type CandidateKind } from './candidates.js';

declare global {
  interface Window {
    __plainwrightLastMutation?: number;
    __plainwrightDoc?: number;
  }
}

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
 */
export async function installSettleObserver(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript((own) => {
    window.__plainwrightDoc = Math.random();
    window.__plainwrightLastMutation = performance.now();
    new MutationObserver((records) => {
      if (records.some((r) => r.attributeName !== own)) window.__plainwrightLastMutation = performance.now();
    }).observe(document, { childList: true, subtree: true, attributes: true });
  }, OWN_ATTRIBUTE);
}

/** A point in time of the page's main document, from `mark()`, or what `settle()` saw at its end. */
export interface DocTime { doc: number; t: number; }

/** Now, on the main document's clock; null where the observer is not installed. */
export function mark(page: Page): Promise<DocTime | null> {
  return page.evaluate(() => (typeof window.__plainwrightDoc === 'number' ? { doc: window.__plainwrightDoc, t: performance.now() } : null));
}

/** True when the main document provably did not mutate between `before` (a mark) and `after` (settle's result). */
export function unchangedSince(before: DocTime | null, after: DocTime | null): boolean {
  return before !== null && after !== null && before.doc === after.doc && after.t <= before.t;
}

/**
 * Wait until the DOM stops mutating for `quietMs` (debounced autocompletes, modals), giving up after
 * `maxMs`. Retroactive: if `installSettleObserver` recorded the DOM as already quiet for `quietMs`,
 * resolves immediately; otherwise waits only the remaining quiet time. Falls back to a full `quietMs`
 * prospective wait when the observer wasn't installed (e.g. an existing tab attached over CDP).
 * Resolves to the time of the document's last mutation (null without the observer), for `unchangedSince`.
 */
export function settle(page: Page, quietMs = 500, maxMs = 3000): Promise<DocTime | null> {
  return page.evaluate(
    ({ quietMs, maxMs, own }) =>
      new Promise<DocTime | null>((resolve) => {
        const lastMutation = () => {
          const doc = window.__plainwrightDoc;
          const t = window.__plainwrightLastMutation;
          return typeof doc === 'number' && typeof t === 'number' ? { doc, t } : null;
        };
        const last = window.__plainwrightLastMutation;
        if (typeof last === 'number' && performance.now() - last >= quietMs) return resolve(lastMutation());
        const initialWait = typeof last === 'number' ? quietMs - (performance.now() - last) : quietMs;
        let timer = setTimeout(done, initialWait);
        const obs = new MutationObserver((records) => {
          if (records.every((r) => r.attributeName === own)) return;
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        const cap = setTimeout(done, maxMs);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        function done() {
          obs.disconnect(); clearTimeout(timer); clearTimeout(cap);
          resolve(lastMutation());
        }
      }),
    { quietMs, maxMs, own: OWN_ATTRIBUTE }
  );
}

/** Resolves true on the first DOM mutation, false after `maxMs` without one. */
export function waitForMutation(page: Page, maxMs: number): Promise<boolean> {
  return page.evaluate(
    ({ maxMs, own }) =>
      new Promise<boolean>((resolve) => {
        const obs = new MutationObserver((records) => {
          if (records.every((r) => r.attributeName === own)) return;
          obs.disconnect(); clearTimeout(timer);
          resolve(true);
        });
        const timer = setTimeout(() => { obs.disconnect(); resolve(false); }, maxMs);
        obs.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      }),
    { maxMs, own: OWN_ATTRIBUTE }
  );
}

const ARIA_MAX_CHARS = 60_000; // ponytail: hard truncate, no smart summarization — ≈15k tokens, ≈$0.0006/call

function toSnapshot(page: Page, title: string, aria: string): Snapshot {
  return { url: page.url(), title, aria: aria.slice(0, ARIA_MAX_CHARS), truncated: aria.length > ARIA_MAX_CHARS };
}

export async function snapshot(page: Page): Promise<Snapshot> {
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
export async function snapshotRegion(page: Page, locator: Locator): Promise<Snapshot> {
  const [title, ariaFull] = await Promise.all([page.title(), locator.ariaSnapshot()]);
  return toSnapshot(page, title, ariaFull);
}
