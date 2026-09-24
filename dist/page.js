import { StepKind } from './step-kind.js';
import { z } from 'zod';
export { CandidateSchema, SnapshotSchema } from './automation.js';
export const CandidateKindSchema = z.enum([StepKind.click, StepKind.hover, StepKind.fill, StepKind.select, StepKind.check, StepKind.upload, 'region']);
const CLICK_SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=listbox] li, [role=menuitemradio], [onclick]';
const FILL_SELECTOR = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]';
const SELECT_SELECTOR = 'select';
// Toggles that keep their state in aria-pressed/aria-checked (filter chips, menu check items) count too; the
// `check` step reads that state before acting. Labels whose checkbox has no size are added by the walker.
const CHECK_SELECTOR = 'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch], [role=menuitemcheckbox], [role=menuitemradio], [aria-pressed]';
const UPLOAD_SELECTOR = 'input[type=file]';
const REGION_SELECTOR = 'main, section, article, dialog, nav, header, footer, aside, form, table, [role=region], [role=dialog], [role=main], [role=tabpanel], [role=list]';
// Layers decide what a dense page loses to the cap: an open dialog blocks everything else, so its controls
// come first; nav and footer link farms (131 of trivago's first 254 candidates) come last.
const DIALOG_SELECTOR = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
const CHROME_SELECTOR = 'nav, footer, [role=navigation], [role=contentinfo]';
const SELECTORS = {
    [StepKind.click]: CLICK_SELECTOR,
    [StepKind.hover]: `${CLICK_SELECTOR}, img, svg, figure`, // hover targets are often plain images with no clickable signal
    [StepKind.fill]: FILL_SELECTOR,
    [StepKind.select]: SELECT_SELECTOR,
    [StepKind.check]: CHECK_SELECTOR,
    [StepKind.upload]: UPLOAD_SELECTOR,
    region: REGION_SELECTOR,
};
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
export async function installSettleObserver(target) {
    await target.addInitScript((own) => {
        window.__plainwrightDoc = Math.random();
        window.__plainwrightLastMutation = performance.now();
        new MutationObserver((records) => {
            if (records.some((r) => r.attributeName !== own))
                window.__plainwrightLastMutation = performance.now();
        }).observe(document, { childList: true, subtree: true, attributes: true });
    }, OWN_ATTRIBUTE);
}
/** Now, on the main document's clock; null where the observer is not installed. */
export function mark(page) {
    return page.evaluate(() => (typeof window.__plainwrightDoc === 'number' ? { doc: window.__plainwrightDoc, t: performance.now() } : null));
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
        const last = window.__plainwrightLastMutation;
        if (typeof last === 'number' && performance.now() - last >= quietMs) {
            resolve(lastMutation());
            return;
        }
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
        const timer = setTimeout(() => {
            obs.disconnect();
            resolve(false);
        }, maxMs);
        obs.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    }), { maxMs, own: OWN_ATTRIBUTE });
}
/**
 * Runs inside the page/frame. Walks the whole document — including open shadow roots — collecting
 * elements that match `selector`. For `includeExtras` (the `click` kind), also collects React-style
 * clickables that match no selector: cursor:pointer, [tabindex], [contenteditable], summary, label.
 * For `labelsOfToggles` (the `check` kind), a label whose checkbox/radio has no size stands in for it.
 * Order before the cap: dialog content, then the page, then nav/footer; within a layer selector-matched
 * elements first (DOM order), extras after.
 */
function collectCandidatesInPage(args) {
    const { selector, dialogSelector, chromeSelector, includeExtras, labelsOfToggles, skipVisibility, max, startId } = args;
    function visible(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0)
            return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }
    const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    function truncate(s, n) {
        s = s.trim().replace(/\s+/g, ' ');
        return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function describe(el) {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const role = el.getAttribute('role');
        let head = tag;
        if (type)
            head += `[type=${type}]`;
        if (role)
            head += `[role=${role}]`;
        const parts = [head];
        const text = el.innerText ?? el.textContent ?? '';
        const value = el.value;
        if (text && text.trim())
            parts.push(`"${truncate(text, 60)}"`);
        else if (value)
            parts.push(`value="${truncate(value, 60)}"`);
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel)
            parts.push(`aria-label="${truncate(ariaLabel, 60)}"`);
        const placeholder = el.getAttribute('placeholder');
        if (placeholder)
            parts.push(`placeholder="${truncate(placeholder, 60)}"`);
        const alt = el.getAttribute('alt');
        if (alt)
            parts.push(`alt="${truncate(alt, 60)}"`);
        const title = el.getAttribute('title');
        if (title)
            parts.push(`title="${truncate(title, 60)}"`);
        const name = el.getAttribute('name');
        if (name)
            parts.push(`name="${name}"`);
        const id = el.getAttribute('id');
        if (id)
            parts.push(`id="${id}"`);
        const href = el.getAttribute('href');
        if (href) {
            try {
                parts.push(`href=${new URL(href, location.href).pathname}`);
            }
            catch {
                parts.push(`href=${href}`);
            }
        }
        return parts.join(' ');
    }
    // Keep the control's identity and its surrounding evidence together. In particular, an Edit
    // button's own text says nothing about which row it edits. Never flatten a whole table/list or
    // borrow text from another item. These limits bound both DOM work and additional model input.
    const ITEM = 'article, li, tr, [role=article], [role=listitem], [role=row]';
    const GROUP = 'section, form, fieldset, dialog, [role=group], [role=region], [role=dialog], [role=alertdialog]';
    const HEADING = 'h1, h2, h3, h4, h5, h6, [role=heading], legend';
    const OMIT = 'script, style, template, noscript, input, textarea, select, button, [role=button], nav, footer';
    function parent(el) {
        return el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
    }
    function hasHeading(el) {
        let scanned = 0;
        for (const child of el.children) {
            if (++scanned > 256)
                break;
            if (child.matches(HEADING))
                return true;
        }
        return false;
    }
    function context(el) {
        let container = parent(el);
        for (let depth = 0; container && depth < 6; depth++, container = parent(container)) {
            if (container.matches('body, main, nav, footer, table, ul, ol, [role=main], [role=table], [role=list]'))
                break;
            const item = container.matches(ITEM);
            const group = container.matches(GROUP);
            // Plain div cards are common too. Only consider a direct heading, never a heading in a
            // neighboring child card; all other generic wrappers are skipped.
            const headed = hasHeading(container);
            if (!item && !group && !headed)
                continue;
            let visited = 0;
            let heading = '';
            let nearby = '';
            function read(node, inHeading = false) {
                if (++visited > 256 || (heading.length >= 80 && nearby.length >= 160))
                    return;
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent?.trim();
                    if (text) {
                        if (inHeading)
                            heading = truncate(`${heading} ${text}`, 80);
                        else if (item || headed)
                            nearby = truncate(`${nearby} ${text}`, 160);
                    }
                    return;
                }
                if (!(node instanceof Element))
                    return;
                if (node !== container) {
                    if (node === el || node.matches(`${OMIT}, ${ITEM}, ${GROUP}`))
                        return;
                    // An article's heading may live in a header/div. Only use the extra generic-card
                    // boundary when the selected container itself is a generic card.
                    if (!item && !group && hasHeading(node))
                        return;
                }
                const style = window.getComputedStyle(node);
                if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden')
                    return;
                const isHeading = inHeading || node.matches(HEADING);
                for (const child of node.childNodes) {
                    if (visited >= 256)
                        break;
                    read(child, isHeading);
                }
            }
            read(container);
            const name = container.getAttribute('aria-label');
            const parts = [name && `name=${JSON.stringify(truncate(name, 80))}`, heading && `heading=${JSON.stringify(heading)}`, nearby && `text=${JSON.stringify(nearby)}`].filter(Boolean);
            // Stop at the nearest item/group even when it has no usable context. Looking beyond an
            // empty row/card would risk attributing a sibling's identity to this control.
            return parts.length ? ` context: ${container.getAttribute('role') ?? container.tagName.toLowerCase()} ${truncate(parts.join(' '), 240)}` : '';
        }
        return '';
    }
    // `[draggable=true]` catches HTML5 drag-and-drop sources/targets — the-internet's /drag_and_drop
    // boxes are plain <div draggable="true"> with `cursor: move`, not `pointer`, so isPointer() alone
    // would never surface them for a `drag` step.
    const EXTRA_SELECTOR = '[tabindex]:not([tabindex="-1"]), [contenteditable=true], summary, label, [draggable=true]';
    // key = layer * 2 + (extra ? 1 : 0): dialog controls, dialog extras, page controls, page extras, nav/footer...
    const found = [];
    // `cursor` is inherited: only the outermost pointer element is the clickable (the card), not every
    // span/svg/path inside it — those would only bloat the list toward the 255-option ceiling.
    const isPointer = (el) => window.getComputedStyle(el).cursor === 'pointer';
    // A styled checkbox is usually a 0x0 or offscreen input behind a label: the label is what a user clicks.
    const isHiddenToggle = (c) => c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio') && !visible(c);
    function visit(el, layer) {
        if (el.hasAttribute('data-jev-id'))
            el.removeAttribute('data-jev-id');
        if (el.matches(dialogSelector))
            layer = 0;
        else if (layer === 1 && el.matches(chromeSelector))
            layer = 2;
        if (el.matches(selector))
            found.push({ el, key: layer * 2 });
        else if (labelsOfToggles && el instanceof HTMLLabelElement && isHiddenToggle(el.control))
            found.push({ el, key: layer * 2 });
        else if (includeExtras && !(el instanceof SVGElement) && (el.matches(EXTRA_SELECTOR) || (isPointer(el) && !(el.parentElement && isPointer(el.parentElement))))) {
            found.push({ el, key: layer * 2 + 1 });
        }
        if (el.shadowRoot)
            for (const c of Array.from(el.shadowRoot.children))
                visit(c, layer);
        for (const c of Array.from(el.children))
            visit(c, layer);
    }
    if (document.body)
        for (const c of Array.from(document.body.children))
            visit(c, 1);
    const keep = (el) => (skipVisibility || visible(el)) && enabled(el);
    const final = found
        .filter((f) => keep(f.el))
        .sort((a, b) => a.key - b.key) // stable: DOM order within a key
        .map((f) => f.el)
        .slice(0, max);
    const descs = final.map((el, i) => {
        el.setAttribute('data-jev-id', String(startId + i));
        return describe(el);
    });
    // Identical descriptions (three "img alt=User Avatar", two bare checkboxes) get an ordinal in DOM order,
    // so "the first …" / "the leftmost …" has exactly one answer.
    const counts = new Map();
    for (const d of descs)
        counts.set(d, (counts.get(d) ?? 0) + 1);
    const seen = new Map();
    return descs.map((d, i) => {
        const surrounding = context(final[i]);
        if ((counts.get(d) ?? 0) < 2)
            return d + surrounding;
        const n = (seen.get(d) ?? 0) + 1;
        seen.set(d, n);
        return `${d} #${n}${surrounding}`;
    });
}
function frameLabel(frame) {
    const name = frame.name();
    if (name)
        return name;
    try {
        return new URL(frame.url()).pathname || frame.url();
    }
    catch {
        return frame.url();
    }
}
export async function candidates(page, kind, max) {
    const selector = SELECTORS[kind];
    const includeExtras = kind === StepKind.click || kind === StepKind.hover;
    const labelsOfToggles = kind === StepKind.check;
    const skipVisibility = kind === StepKind.upload;
    const out = [];
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length && out.length < max; frameIndex++) {
        const frame = frames[frameIndex];
        const startId = out.length;
        let descs;
        try {
            descs = await frame.evaluate(collectCandidatesInPage, {
                selector,
                dialogSelector: DIALOG_SELECTOR,
                chromeSelector: CHROME_SELECTOR,
                includeExtras,
                labelsOfToggles,
                skipVisibility,
                max: max - out.length,
                startId,
            });
        }
        catch {
            continue; // detached or cross-origin frame — skip, never fatal
        }
        const prefix = frameIndex === 0 ? '' : `[iframe ${frameLabel(frame)}] `;
        for (const desc of descs)
            out.push({ id: out.length, desc: prefix + desc, frameIndex });
    }
    return out;
}
export function elementById(page, id, frameIndex = 0) {
    return page.frames()[frameIndex].locator(`[data-jev-id="${id}"]`);
}
const ARIA_MAX_CHARS = 60_000; // ponytail: hard truncate, no smart summarization — ≈15k tokens, ≈$0.0006/call
function capAria(s) {
    return s.length > ARIA_MAX_CHARS ? { aria: s.slice(0, ARIA_MAX_CHARS), truncated: true } : { aria: s, truncated: false };
}
function toSnapshot(page, title, ariaFull) {
    const { aria, truncated } = capAria(ariaFull);
    return { url: page.url(), title, aria, truncated };
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
    let full = bodyAria;
    iframeFrames.forEach((frame, i) => {
        const frameAria = iframeArias[i];
        if (frameAria !== null)
            full += `\n--- iframe ${frameLabel(frame)} ---\n${frameAria}`;
    });
    return toSnapshot(page, title, full);
}
/** Same as `snapshot()` but scoped to one region locator, for `expect: { that, within }`. */
export async function snapshotRegion(page, locator) {
    const [title, ariaFull] = await Promise.all([page.title(), locator.ariaSnapshot()]);
    return toSnapshot(page, title, ariaFull);
}
