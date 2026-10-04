import type { Page, Frame, Locator, BrowserContext } from 'playwright';
import type { Snapshot } from '../core/automation.js';
import { frameLabel } from './frames.js';

declare global {
  interface Window {
    __plainLastMutation?: number;
    __plainDoc?: number;
  }
}

/** The candidate scan tags elements with it. Our own write is not the page changing, so every observer ignores it. */
const OWN_ATTRIBUTE = 'data-jev-id';
/** A hard cut, about 15k tokens. */
const ARIA_MAX_CHARS = 60_000;

/**
 * Records the time of the last DOM mutation in every new document of `target` (a page, or a context so popups
 * inherit it), so settle() can tell a page that is already quiet. `__plainDoc` identifies the document:
 * a mark taken before a navigation is never compared with the next document's clock. Only mutations after the
 * load event count: building the page is not a rendering burst to wait out once it has loaded.
 */
export async function installSettleObserver(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript((own) => {
    window.__plainDoc = Math.random();
    window.__plainLastMutation = -1e9;
    new MutationObserver((records) => {
      if (document.readyState !== 'complete') return;
      if (records.some((record) => record.attributeName !== own)) window.__plainLastMutation = performance.now();
    }).observe(document, { childList: true, subtree: true, attributes: true });
  }, OWN_ATTRIBUTE);
}

/** A moment on the main document's clock, from mark(), or the last mutation settle() saw. */
export interface DocTime { doc: number; t: number }

/** Now, on the main document's clock; null without the observer or while the document is still loading. */
export function mark(page: Page): Promise<DocTime | null> {
  return page.evaluate(() => (typeof window.__plainDoc === 'number' && document.readyState === 'complete'
    ? { doc: window.__plainDoc, t: performance.now() }
    : null));
}

/** True when the main document provably did not mutate between `before` (a mark) and `after` (settle's result). */
export function unchangedSince(before: DocTime | null, after: DocTime | null): boolean {
  return before !== null && after !== null && before.doc === after.doc && after.t <= before.t;
}

/**
 * Waits until the DOM has not mutated for `quietMs`, at most `maxMs`. When the observer already saw the page
 * quiet, it resolves at once, or waits only the rest of the quiet window. Without the observer (an existing tab
 * attached over CDP) it waits a full window. Resolves to the document's last mutation, for unchangedSince().
 */
export function settle(page: Page, quietMs = 500, maxMs = 3000): Promise<DocTime | null> {
  return page.evaluate(
    ({ quietMs, maxMs, own }) =>
      new Promise<DocTime | null>((resolve) => {
        const lastMutation = () => {
          const doc = window.__plainDoc;
          const t = window.__plainLastMutation;
          return typeof doc === 'number' && typeof t === 'number' ? { doc, t } : null;
        };
        // A document still loading is never quiet already: the parser's inserts are not counted.
        const last = document.readyState === 'complete' ? window.__plainLastMutation : undefined;
        if (typeof last === 'number' && performance.now() - last >= quietMs) return resolve(lastMutation());
        const firstWait = typeof last === 'number' ? quietMs - (performance.now() - last) : quietMs;
        let timer = setTimeout(done, firstWait);
        const observer = new MutationObserver((records) => {
          if (records.every((record) => record.attributeName === own)) return;
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
      }),
    { quietMs, maxMs, own: OWN_ATTRIBUTE }
  );
}

/** Resolves true on the first DOM mutation, false after `maxMs` without one. */
export function waitForMutation(page: Page, maxMs: number): Promise<boolean> {
  return page.evaluate(
    ({ maxMs, own }) =>
      new Promise<boolean>((resolve) => {
        const observer = new MutationObserver((records) => {
          if (records.every((record) => record.attributeName === own)) return;
          observer.disconnect();
          clearTimeout(timer);
          resolve(true);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, maxMs);
        observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      }),
    { maxMs, own: OWN_ATTRIBUTE }
  );
}

/**
 * Playwright marks a checked control `[checked]` and an unchecked one with nothing, and Jev reads a missing mark
 * as weak evidence (docs/benchmarks/claims.md). An explicit `[checked=false]`, Playwright's own syntax, makes the
 * state a fact on the line. Matches the role, an optional quoted name, then any `[...]` attributes.
 */
const CHECKABLE_LINE = /^(\s*- '?(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio)(?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]*\])*)(?=[:']|$)/gm;

export function markUnchecked(aria: string): string {
  return aria.replace(CHECKABLE_LINE, (line, head: string, attributes: string) =>
    attributes.includes('[checked') ? line : `${head}${attributes} [checked=false]`);
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
export function shortenUrls(aria: string): string {
  return aria.replace(URL_LINE, (line, head: string, value: string) => {
    if (value.length <= MAX_URL_CHARS) return line;
    const url = value.replace(/^(["'])(.*)\1$/, '$2');
    return `${head}${url.split(/[?#]/, 1)[0].slice(0, MAX_URL_CHARS)}…`;
  });
}

/**
 * What Jev, agents and debug dumps see in place of a filled password field's value, which is a spec's secret
 * (`${env.*}`): in trees, candidate descriptions and layout text. An empty field still shows no value. A word, not
 * dots: on dots Jev was less sure that the field is filled and read "contains any text" as unsure.
 */
export const PASSWORD_MASK = '[filled]';
/** The mask as Playwright prints that text in a tree: `[` needs quotes in YAML. */
const ARIA_PASSWORD_MASK = JSON.stringify(PASSWORD_MASK);

/** A textbox's line, its key maybe single-quoted (YAML), with its value when the value is on the line. */
const TEXTBOX_LINE = /^(\s*)- '?textbox(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*'?:(?: (.*))?$/;
const TEXT_LINE = /^(\s*)- text: (.*)$/;
const ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A value as Playwright prints it (yamlEscapeValueIfNeeded), back to its text. */
function unquote(value: string): string {
  if (!/^".*"$/.test(value)) return value;
  return value.slice(1, -1).replace(/\\(x[0-9a-f]{2}|.)/g, (_, c: string) =>
    c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ESCAPES[c] ?? c);
}

/**
 * Puts the mask in place of each textbox value that is one of `secrets` (passwordValues()). The tree does not
 * say which textbox is a password field, so the value tells. Playwright prints it after the textbox's key, or on a
 * `- text:` line right under it when the field has a placeholder. A plain field with the same text gets the mask too.
 */
export function maskPasswords(aria: string, secrets: ReadonlySet<string>): string {
  if (!secrets.size) return aria;
  let textboxIndent = -1; // the textbox whose child lines are read, or -1
  return aria.split('\n').map((line) => {
    const textbox = TEXTBOX_LINE.exec(line);
    if (textbox) {
      textboxIndent = textbox[1].length;
      const value = textbox[2];
      return value && secrets.has(unquote(value)) ? line.slice(0, -value.length) + ARIA_PASSWORD_MASK : line;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= textboxIndent) textboxIndent = -1;
    const text = TEXT_LINE.exec(line);
    return text && textboxIndent >= 0 && indent === textboxIndent + 2 && secrets.has(unquote(text[2]))
      ? `${text[1]}- text: ${ARIA_PASSWORD_MASK}` : line;
  }).join('\n');
}

/**
 * The values of the page's filled password fields, in every frame and open shadow root, with whitespace normalized
 * as Playwright prints a value. A frame that cannot be read (detached, navigating) adds none.
 */
async function passwordValues(page: Page): Promise<Set<string>> {
  const values = await Promise.all(page.frames().map((frame) => frame.locator('input').evaluateAll((inputs) =>
    inputs.flatMap((input) => input instanceof HTMLInputElement && input.type === 'password' && input.value ? [input.value] : []))
    .catch(() => [])));
  return new Set(values.flat().map((value) => value.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ')).filter(Boolean));
}

/**
 * Long link targets are cut (shortenUrls) before the 60k cap, so ad links do not push page content out. An open
 * dialog the cap would cut is added whole after the page's tree, which is cut shorter to make room: a site often
 * appends its popup at the end of the body, where a long page leaves it out. Password values are masked
 * (maskPasswords) in every tree.
 */
function toSnapshot(page: Page, title: string, aria: string, secrets: ReadonlySet<string>, dialogs: string[] = []): Snapshot {
  const view = (tree: string) => maskPasswords(markUnchecked(shortenUrls(tree)), secrets);
  const marked = view(aria);
  const head = marked.slice(0, ARIA_MAX_CHARS);
  // A dialog nested in the page's tree is indented there: whole trees are compared without the indentation.
  const flat = (tree: string) => tree.split('\n').map((line) => line.trim()).join('\n');
  const trees = dialogs.map(view).filter(Boolean)
    .filter((dialog, i, all) => !all.some((other, j) => j !== i && other.length > dialog.length && flat(other).includes(flat(dialog))));
  // Room for the added dialogs shortens the page part, which can cut a dialog that fit: check against the kept part.
  let kept = head;
  let tail = '';
  for (let changed = true; changed;) {
    const flatKept = flat(kept);
    const next = trees.filter((dialog) => !flatKept.includes(flat(dialog)))
      .map((dialog) => `\n--- open dialog ---\n${dialog}`).join('').slice(0, MAX_DIALOG_CHARS);
    changed = next.length > tail.length;
    if (changed) tail = next;
    kept = head.slice(0, ARIA_MAX_CHARS - tail.length);
  }
  return { url: page.url(), title, aria: kept + tail, truncated: marked.length > ARIA_MAX_CHARS };
}

/** Open dialogs, also in shadow roots; hidden ones have no tree to keep. */
const OPEN_DIALOG = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]';
const MAX_DIALOGS = 4;
const MAX_DIALOG_CHARS = ARIA_MAX_CHARS / 2;

async function openDialogs(page: Page): Promise<string[]> {
  try {
    const dialogs = await page.locator(OPEN_DIALOG).filter({ visible: true }).all();
    return await Promise.all(dialogs.slice(0, MAX_DIALOGS).map((dialog) => dialog.ariaSnapshot({ timeout: IFRAME_ARIA_MS }).catch(() => '')));
  } catch {
    return []; // the page navigated during the look
  }
}

/**
 * The cap of one iframe's tree. It is reached when the body goes away during the look (the ad sync frame removes
 * its body on load) or a loading frame's parser stays blocked. A tree takes about 10 ms, also a 450 KB ad frame's,
 * so the cost is only that a frame whose tree takes over 2 s to build is left out.
 */
const IFRAME_ARIA_MS = 2_000;

/**
 * One iframe's tree, or null. An ad frame can remove its body (static.admaster.cc cookieSync.html does), and a
 * `body` locator then waits its whole timeout, 15 s per look, for one that never comes. A parsed document without
 * a body gets none later, so it is skipped; only a document still loading can get its body from the parser.
 */
async function iframeAria(frame: Frame): Promise<string | null> {
  try {
    const state = await frame.evaluate(() => (document.body ? 'body' : document.readyState));
    if (state !== 'body' && state !== 'loading') return null;
    return await frame.locator('body').ariaSnapshot({ timeout: IFRAME_ARIA_MS });
  } catch {
    return null; // detached or cross-origin, or no body within IFRAME_ARIA_MS
  }
}

/** The page's accessibility tree, each iframe's tree appended under its own header. An empty iframe has none. */
export async function snapshot(page: Page): Promise<Snapshot> {
  const iframes = page.frames().slice(1);
  const [title, bodyAria, iframeArias, secrets] = await Promise.all([
    page.title(),
    page.locator('body').ariaSnapshot(),
    Promise.all(iframes.map(iframeAria)),
    passwordValues(page),
  ]);
  const iframeSections = iframes.map((frame, i) => iframeArias[i] ? `\n--- iframe ${frameLabel(frame)} ---\n${iframeArias[i]}` : '');
  const aria = bodyAria + iframeSections.join('');
  const snap = toSnapshot(page, title, aria, secrets);
  return snap.truncated ? toSnapshot(page, title, aria, secrets, await openDialogs(page)) : snap;
}

/** snapshot() of one region, for `within`. */
export async function snapshotRegion(page: Page, region: Locator): Promise<Snapshot> {
  const [title, aria, secrets] = await Promise.all([page.title(), region.ariaSnapshot(), passwordValues(page)]);
  return { ...toSnapshot(page, title, aria, secrets), region: true };
}
