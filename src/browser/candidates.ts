import { z } from 'zod';
import type { Page, Locator } from 'playwright';
import { StepKind } from '../core/step-kind.js';
import type { Candidate } from '../core/automation.js';
import { frameLabel } from './frames.js';

export const CandidateKindSchema = z.enum([StepKind.click, StepKind.hover, StepKind.fill, StepKind.select, StepKind.check, StepKind.upload, 'region']);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

const CLICK_SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], ' +
  '[role=radio], [role=option], [role=listbox] li, [role=menuitemradio], [onclick]';

const SELECTORS: Record<CandidateKind, string> = {
  [StepKind.click]: CLICK_SELECTOR,
  // Hover targets are often plain images with no clickable signal.
  [StepKind.hover]: `${CLICK_SELECTOR}, img, svg, figure`,
  [StepKind.fill]: 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), ' +
    'textarea, [contenteditable=true]',
  [StepKind.select]: 'select',
  // Toggles that keep their state in aria-pressed/aria-checked count too: `check` reads that state before acting.
  [StepKind.check]: 'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch], [role=menuitemcheckbox], ' +
    '[role=menuitemradio], [aria-pressed]',
  [StepKind.upload]: 'input[type=file]',
  // Plain ul/ol too: search results are often a bare list (the walk keeps only lists of things).
  region: 'main, section, article, dialog, nav, header, footer, aside, form, table, ul, ol, [role=region], [role=dialog], ' +
    '[role=main], [role=tabpanel], [role=list]',
};

interface ScanOptions {
  selector: string;
  /** `click`/`hover`: also cursor:pointer, [tabindex], [contenteditable], summary, label and [draggable] elements. */
  includeExtras: boolean;
  /** `check`: a label whose checkbox or radio has no size stands in for it. */
  labelsOfToggles: boolean;
  /** `region`: a plain ul/ol counts only when it lists things, not a row's inline labels or a short menu. */
  listsOfThings: boolean;
  /** `upload`: file inputs are usually hidden. */
  skipVisibility: boolean;
  max: number;
  startId: number;
}

type ScannedCandidate = [desc: string, editable: boolean, state: string];

/**
 * Runs inside the page or frame, so every helper lives in here. Walks the document, open shadow roots included,
 * tags each kept element with `data-jev-id` and describes it.
 * Order before the cap: an open dialog's content first (it blocks the rest), then the page, then nav and footer
 * (link farms); within each layer, selector matches before extras, in DOM order.
 */
function scanCandidatesInPage({ selector, includeExtras, labelsOfToggles, listsOfThings, skipVisibility, max, startId }: ScanOptions):
  ScannedCandidate[] {
  const DIALOG = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
  const PAGE_CHROME = 'nav, footer, [role=navigation], [role=contentinfo]';
  const EXTRA = '[tabindex]:not([tabindex="-1"]), [contenteditable=true], summary, label, [draggable=true]';
  const LAYER = { dialog: 0, page: 1, chrome: 2 };
  const MAX_TEXT = 60;

  // One style read per element per scan: the walk, the visibility filter and the context all ask.
  const styles = new Map<Element, CSSStyleDeclaration>();
  function styleOf(el: Element): CSSStyleDeclaration {
    let style = styles.get(el);
    if (!style) styles.set(el, (style = window.getComputedStyle(el)));
    return style;
  }
  function visible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = styleOf(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  const enabled = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
  function truncate(text: string, max: number): string {
    const flat = text.trim().replace(/\s+/g, ' ');
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }

  function describe(el: Element): string {
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const parts = [el.tagName.toLowerCase() + (type ? `[type=${type}]` : '') + (role ? `[role=${role}]` : '')];
    const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
    const value = (el as HTMLInputElement).value;
    if (text && text.trim()) parts.push(`"${truncate(text, MAX_TEXT)}"`);
    else if (value) parts.push(`value="${truncate(value, MAX_TEXT)}"`);
    for (const attribute of ['aria-label', 'placeholder', 'alt', 'title', 'name', 'id']) {
      const attributeValue = el.getAttribute(attribute);
      const neverCut = attribute === 'name' || attribute === 'id';
      if (attributeValue) parts.push(`${attribute}="${neverCut ? attributeValue : truncate(attributeValue, MAX_TEXT)}"`);
    }
    const href = el.getAttribute('href');
    if (href) {
      try {
        parts.push(`href=${new URL(href, location.href).pathname}`);
      } catch {
        parts.push(`href=${href}`);
      }
    }
    return parts.join(' ');
  }

  // The context keeps a control's identity and its surroundings together: an Edit button's own text says
  // nothing about which row it edits. It never flattens a whole table or list, nor borrows another item's text.
  const ITEM = 'article, li, tr, [role=article], [role=listitem], [role=row]';
  const GROUP = 'section, form, fieldset, dialog, [role=group], [role=region], [role=dialog], [role=alertdialog]';
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role=heading], legend';
  const OMIT = 'script, style, template, noscript, input, textarea, select, button, [role=button], nav, footer';
  const STOP = 'body, main, nav, footer, table, ul, ol, [role=main], [role=table], [role=list]';
  const MAX_DEPTH = 6;
  const MAX_NODES = 256;
  const MAX_HEADING = 80;
  const MAX_NEARBY = 160;
  const MAX_CONTEXT = 240;
  function parent(el: Element): Element | null {
    const root = el.getRootNode();
    return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  // Candidates of one list share their containers: each check runs once per element per scan.
  const memo = <T>(fn: (el: Element) => T) => {
    const cache = new Map<Element, T>();
    return (el: Element): T => {
      let value = cache.get(el);
      if (value === undefined && !cache.has(el)) cache.set(el, (value = fn(el)));
      return value as T;
    };
  };
  const isHeading = memo((el) => el.matches(HEADING));
  const isItem = memo((el) => el.matches(ITEM));
  const isGroup = memo((el) => el.matches(GROUP));
  const isStop = memo((el) => el.matches(STOP));
  const isBoundary = memo((el) => el.matches(`${OMIT}, ${ITEM}, ${GROUP}`));
  const isHidden = memo((el) => {
    const style = styleOf(el);
    return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden';
  });
  const hasHeading = memo((el) => {
    let scanned = 0;
    for (const child of el.children) {
      if (++scanned > MAX_NODES) break;
      if (isHeading(child)) return true;
    }
    return false;
  });

  /** ` context: <container> name=… heading=… text=…` from the nearest item, group or headed card, or ''. */
  function context(el: Element): string {
    let container = parent(el);
    for (let depth = 0; container && depth < MAX_DEPTH; depth++, container = parent(container)) {
      if (isStop(container)) break;
      const item = isItem(container);
      const group = isGroup(container);
      // A plain div card counts when it has a heading of its own; other generic wrappers are skipped.
      const headed = hasHeading(container);
      if (!item && !group && !headed) continue;

      let visited = 0;
      let heading = '';
      let nearby = '';
      const card = container;
      function read(node: Node, inHeading = false) {
        if (++visited > MAX_NODES || (heading.length >= MAX_HEADING && nearby.length >= MAX_NEARBY)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim();
          if (text) {
            if (inHeading) heading = truncate(`${heading} ${text}`, MAX_HEADING);
            else if (item || headed) nearby = truncate(`${nearby} ${text}`, MAX_NEARBY);
          }
          return;
        }
        if (!(node instanceof Element)) return;
        if (node !== card) {
          if (node === el || isBoundary(node)) return;
          // A nested headed card is another card, unless the container itself is only a generic card.
          if (!item && !group && hasHeading(node)) return;
        }
        if (isHidden(node)) return;
        const underHeading = inHeading || isHeading(node);
        for (const child of node.childNodes) {
          if (visited >= MAX_NODES) break;
          read(child, underHeading);
        }
      }
      read(container);
      const label = container.getAttribute('aria-label');
      const name = label ? truncate(label, MAX_HEADING) : '';
      // A row is often labelled by its own heading: say it once.
      if (heading.trim() === name.trim()) heading = '';
      const parts = [name && `name=${JSON.stringify(name)}`, heading && `heading=${JSON.stringify(heading)}`,
        nearby && `text=${JSON.stringify(nearby)}`].filter(Boolean);
      // Stop at the nearest item or group even when it has nothing to say: looking further out could give this
      // control a sibling's identity.
      const kind = container.getAttribute('role') ?? container.tagName.toLowerCase();
      return parts.length ? ` context: ${kind} ${truncate(parts.join(' '), MAX_CONTEXT)}` : '';
    }
    return '';
  }

  // `cursor` is inherited: only the outermost pointer element (the card) is the clickable, not every span inside it.
  const pointer = new Map<Element, boolean>();
  function isPointer(el: Element): boolean {
    let is = pointer.get(el);
    if (is === undefined) pointer.set(el, (is = styleOf(el).cursor === 'pointer'));
    return is;
  }
  // A styled checkbox is usually a 0x0 or offscreen input behind a label: the label is what a user clicks.
  const isHiddenToggle = (control: HTMLElement | null) =>
    control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio') && !visible(control);
  const isPlainList = (el: Element) => (el.tagName === 'UL' || el.tagName === 'OL') && !el.hasAttribute('role');
  /** Two or more items of 40+ characters on average. */
  function listsThings(el: Element) {
    const items = Array.from(el.children).filter((child) => child.tagName === 'LI');
    return items.length >= 2 && (el.textContent ?? '').replace(/\s+/g, ' ').trim().length / items.length >= 40;
  }

  // Sort key: layer * 2, + 1 for an extra.
  const found: { el: Element; key: number }[] = [];
  // The previous scan's tags are removed after the walk: a write between style reads would make each read recompute.
  const staleTags: Element[] = [];
  function visit(el: Element, layer: number) {
    if (el.hasAttribute('data-jev-id')) staleTags.push(el);
    if (el.matches(DIALOG)) layer = LAYER.dialog;
    else if (layer === LAYER.page && el.matches(PAGE_CHROME)) layer = LAYER.chrome;
    if (el.matches(selector)) {
      if (!listsOfThings || !isPlainList(el) || listsThings(el)) found.push({ el, key: layer * 2 });
    } else if (labelsOfToggles && el instanceof HTMLLabelElement && isHiddenToggle(el.control)) {
      found.push({ el, key: layer * 2 });
    } else if (includeExtras && !(el instanceof SVGElement)
      && (el.matches(EXTRA) || (isPointer(el) && !(el.parentElement && isPointer(el.parentElement))))) {
      found.push({ el, key: layer * 2 + 1 });
    }
    if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.children)) visit(child, layer);
    for (const child of Array.from(el.children)) visit(child, layer);
  }
  if (document.body) for (const child of Array.from(document.body.children)) visit(child, LAYER.page);
  for (const el of staleTags) el.removeAttribute('data-jev-id');

  const kept = found
    .filter(({ el }) => (skipVisibility || visible(el)) && enabled(el))
    .sort((a, b) => a.key - b.key) // stable: DOM order within a key
    .map(({ el }) => el)
    .slice(0, max);
  const descs = kept.map((el, i) => {
    el.setAttribute('data-jev-id', String(startId + i));
    return describe(el);
  });

  // A text field's value is what the user typed, not its identity (the pick cache ignores it); a button input's
  // value is its label.
  const TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
  const editable = (el: Element) => el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable ||
    (el instanceof HTMLInputElement && TEXT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase()));
  // UI state the description does not show, for the pick cache: a flip on an unchanged page is a change.
  const state = (el: Element): string => [
    (el as HTMLInputElement).checked ? 'checked' : '',
    (el as HTMLOptionElement).selected ? 'selected' : '',
    (el as HTMLInputElement).disabled ? 'disabled' : '',
    ...['aria-checked', 'aria-pressed', 'aria-selected', 'aria-expanded', 'aria-current', 'aria-disabled']
      .map((attribute) => el.hasAttribute(attribute) ? `${attribute}=${el.getAttribute(attribute)}` : ''),
  ].filter(Boolean).join(' ');

  // Identical descriptions get an ordinal in DOM order, so "the first …" has exactly one answer.
  const counts = new Map<string, number>();
  for (const desc of descs) counts.set(desc, (counts.get(desc) ?? 0) + 1);
  const seen = new Map<string, number>();
  return descs.map((desc, i): ScannedCandidate => {
    const ordinal = (seen.get(desc) ?? 0) + 1;
    seen.set(desc, ordinal);
    const numbered = counts.get(desc)! > 1 ? `${desc} #${ordinal}` : desc;
    return [`${numbered}${context(kept[i])}`, editable(kept[i]), state(kept[i])];
  });
}

/** The candidates of `kind` in every frame, main frame first, ids in scan order. */
export async function candidates(page: Page, kind: CandidateKind, max: number): Promise<Candidate[]> {
  const options = {
    selector: SELECTORS[kind],
    includeExtras: kind === StepKind.click || kind === StepKind.hover,
    labelsOfToggles: kind === StepKind.check,
    listsOfThings: kind === 'region',
    skipVisibility: kind === StepKind.upload,
  };
  const found: Candidate[] = [];
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length && found.length < max; frameIndex++) {
    const frame = frames[frameIndex];
    let scanned: ScannedCandidate[];
    try {
      scanned = await frame.evaluate(scanCandidatesInPage, { ...options, max: max - found.length, startId: found.length });
    } catch {
      continue; // a detached or cross-origin frame
    }
    const prefix = frameIndex === 0 ? '' : `[iframe ${frameLabel(frame)}] `;
    for (const [desc, editable, state] of scanned) {
      found.push({ id: found.length, desc: prefix + desc, frameIndex, ...(editable ? { editable } : {}), ...(state ? { state } : {}) });
    }
  }
  return found;
}

export function elementById(page: Page, id: number, frameIndex = 0): Locator {
  return page.frames()[frameIndex].locator(`[data-jev-id="${id}"]`);
}
