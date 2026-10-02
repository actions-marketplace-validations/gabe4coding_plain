import { StepKind } from './step-kind.js';
import { z } from 'zod';
import { frameLabel } from './frames.js';
export const CandidateKindSchema = z.enum([StepKind.click, StepKind.hover, StepKind.fill, StepKind.select, StepKind.check, StepKind.upload, 'region']);
const CLICK_SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=listbox] li, [role=menuitemradio], [onclick]';
const SELECTORS = {
    [StepKind.click]: CLICK_SELECTOR,
    [StepKind.hover]: `${CLICK_SELECTOR}, img, svg, figure`, // hover targets are often plain images with no clickable signal
    [StepKind.fill]: 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]',
    [StepKind.select]: 'select',
    // Toggles that keep their state in aria-pressed/aria-checked (filter chips, menu check items) count too; the
    // `check` step reads that state before acting. Labels whose checkbox has no size are added by the walker.
    [StepKind.check]: 'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch], [role=menuitemcheckbox], [role=menuitemradio], [aria-pressed]',
    [StepKind.upload]: 'input[type=file]',
    // ul/ol are lists without saying so: Open Library's search results are a plain <ul>, never offered before.
    region: 'main, section, article, dialog, nav, header, footer, aside, form, table, ul, ol, [role=region], [role=dialog], [role=main], [role=tabpanel], [role=list]',
};
/**
 * Runs inside the page/frame. Walks the whole document — including open shadow roots — collecting
 * elements that match `selector`. For `includeExtras` (the `click` kind), also collects React-style
 * clickables that match no selector: cursor:pointer, [tabindex], [contenteditable], summary, label.
 * For `labelsOfToggles` (the `check` kind), a label whose checkbox/radio has no size stands in for it.
 * For `listsOfThings` (the `region` kind), a plain ul/ol counts only when it lists things: 2+ items of
 * 40+ characters on average (Open Library's results), not a row's inline labels (GitHub's "Python · 4.2k
 * · Updated yesterday" under every result) or a short menu. An explicit role=list always counts.
 * Order before the cap: dialog content, then the page, then nav/footer; within a layer selector-matched
 * elements first (DOM order), extras after.
 */
function collectCandidatesInPage({ selector, includeExtras, labelsOfToggles, listsOfThings, skipVisibility, max, startId }) {
    // Layers decide what a dense page loses to the cap: an open dialog blocks everything else, so its controls
    // come first; nav and footer link farms (131 of trivago's first 254 candidates) come last.
    const dialogSelector = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
    const chromeSelector = 'nav, footer, [role=navigation], [role=contentinfo]';
    // One style read per element per scan: the walk, the visibility filter and context() ask about the same elements.
    const styles = new Map();
    function styleOf(el) {
        let style = styles.get(el);
        if (!style)
            styles.set(el, (style = window.getComputedStyle(el)));
        return style;
    }
    function visible(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0)
            return false;
        const style = styleOf(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }
    const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    function truncate(s, n) {
        s = s.trim().replace(/\s+/g, ' ');
        return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function describe(el) {
        const type = el.getAttribute('type');
        const role = el.getAttribute('role');
        const parts = [el.tagName.toLowerCase() + (type ? `[type=${type}]` : '') + (role ? `[role=${role}]` : '')];
        const text = el.innerText ?? el.textContent ?? '';
        const value = el.value;
        if (text && text.trim())
            parts.push(`"${truncate(text, 60)}"`);
        else if (value)
            parts.push(`value="${truncate(value, 60)}"`);
        for (const attr of ['aria-label', 'placeholder', 'alt', 'title', 'name', 'id']) {
            const v = el.getAttribute(attr);
            if (v)
                parts.push(`${attr}="${attr === 'name' || attr === 'id' ? v : truncate(v, 60)}"`); // name and id are never cut
        }
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
    // Candidates in one list share their containers, so every per-element check below is asked once per scan.
    const memo = (fn) => {
        const cache = new Map();
        return (el) => {
            let v = cache.get(el);
            if (v === undefined && !cache.has(el))
                cache.set(el, (v = fn(el)));
            return v;
        };
    };
    const isHeading = memo((el) => el.matches(HEADING));
    const isItem = memo((el) => el.matches(ITEM));
    const isGroup = memo((el) => el.matches(GROUP));
    const isStop = memo((el) => el.matches('body, main, nav, footer, table, ul, ol, [role=main], [role=table], [role=list]'));
    const isBoundary = memo((el) => el.matches(`${OMIT}, ${ITEM}, ${GROUP}`));
    const isHidden = memo((el) => {
        const style = styleOf(el);
        return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden';
    });
    const hasHeading = memo((el) => {
        let scanned = 0;
        for (const child of el.children) {
            if (++scanned > 256)
                break;
            if (isHeading(child))
                return true;
        }
        return false;
    });
    function context(el) {
        let container = parent(el);
        for (let depth = 0; container && depth < 6; depth++, container = parent(container)) {
            if (isStop(container))
                break;
            const item = isItem(container);
            const group = isGroup(container);
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
                    if (node === el || isBoundary(node))
                        return;
                    // An article's heading may live in a header/div. Only use the extra generic-card
                    // boundary when the selected container itself is a generic card.
                    if (!item && !group && hasHeading(node))
                        return;
                }
                if (isHidden(node))
                    return;
                const underHeading = inHeading || isHeading(node);
                for (const child of node.childNodes) {
                    if (visited >= 256)
                        break;
                    read(child, underHeading);
                }
            }
            read(container);
            const name = container.getAttribute('aria-label');
            const shortName = name ? truncate(name, 80) : '';
            // A row is often labelled by its own heading (GitHub issue rows): say it once, not twice.
            if (heading.trim() === shortName.trim())
                heading = '';
            const parts = [shortName && `name=${JSON.stringify(shortName)}`, heading && `heading=${JSON.stringify(heading)}`, nearby && `text=${JSON.stringify(nearby)}`].filter(Boolean);
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
    const pointer = new Map();
    function isPointer(el) {
        let is = pointer.get(el);
        if (is === undefined)
            pointer.set(el, (is = styleOf(el).cursor === 'pointer'));
        return is;
    }
    // A styled checkbox is usually a 0x0 or offscreen input behind a label: the label is what a user clicks.
    const isHiddenToggle = (c) => c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio') && !visible(c);
    // Last scan's tags are removed after the walk: a write between style reads makes the next read recompute styles.
    const stale = [];
    const isPlainList = (el) => (el.tagName === 'UL' || el.tagName === 'OL') && !el.hasAttribute('role');
    function listsThings(el) {
        const items = Array.from(el.children).filter((c) => c.tagName === 'LI');
        return items.length >= 2 && (el.textContent ?? '').replace(/\s+/g, ' ').trim().length / items.length >= 40;
    }
    function visit(el, layer) {
        if (el.hasAttribute('data-jev-id'))
            stale.push(el);
        if (el.matches(dialogSelector))
            layer = 0;
        else if (layer === 1 && el.matches(chromeSelector))
            layer = 2;
        if (el.matches(selector)) {
            if (!listsOfThings || !isPlainList(el) || listsThings(el))
                found.push({ el, key: layer * 2 });
        }
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
    for (const el of stale)
        el.removeAttribute('data-jev-id');
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
    // A text-entry field's value is what the user typed, not its identity (the pick cache ignores it); a
    // submit/button input's value is its label.
    const TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
    const editable = (el) => el instanceof HTMLTextAreaElement || el.isContentEditable ||
        (el instanceof HTMLInputElement && TEXT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase()));
    // UI state the desc does not show; only the pick cache reads it (a flip on an unchanged page is a change).
    const state = (el) => [
        el.checked ? 'checked' : '', el.selected ? 'selected' : '',
        el.disabled ? 'disabled' : '',
        ...['aria-checked', 'aria-pressed', 'aria-selected', 'aria-expanded', 'aria-current', 'aria-disabled']
            .map((attr) => el.hasAttribute(attr) ? `${attr}=${el.getAttribute(attr)}` : ''),
    ].filter(Boolean).join(' ');
    return descs.map((d, i) => {
        const n = (seen.get(d) ?? 0) + 1;
        seen.set(d, n);
        return [`${d}${counts.get(d) > 1 ? ` #${n}` : ''}${context(final[i])}`, editable(final[i]), state(final[i])];
    });
}
export async function candidates(page, kind, max) {
    const selector = SELECTORS[kind];
    const includeExtras = kind === StepKind.click || kind === StepKind.hover;
    const labelsOfToggles = kind === StepKind.check;
    const listsOfThings = kind === 'region';
    const skipVisibility = kind === StepKind.upload;
    const out = [];
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length && out.length < max; frameIndex++) {
        const frame = frames[frameIndex];
        const startId = out.length;
        let descs;
        try {
            descs = await frame.evaluate(collectCandidatesInPage, { selector, includeExtras, labelsOfToggles, listsOfThings, skipVisibility, max: max - out.length, startId });
        }
        catch {
            continue; // detached or cross-origin frame — skip, never fatal
        }
        const prefix = frameIndex === 0 ? '' : `[iframe ${frameLabel(frame)}] `;
        for (const [desc, editable, state] of descs)
            out.push({ id: out.length, desc: prefix + desc, frameIndex, ...(editable ? { editable } : {}), ...(state ? { state } : {}) });
    }
    return out;
}
export function elementById(page, id, frameIndex = 0) {
    return page.frames()[frameIndex].locator(`[data-jev-id="${id}"]`);
}
