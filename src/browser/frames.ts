import type { Frame } from 'playwright';

/** Iframe name, or its URL's pathname. Labels iframe candidates and iframe snapshot sections. */
export function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try { return new URL(frame.url()).pathname || frame.url(); } catch { return frame.url(); }
}

/** What in a document can make an embedded frame inert: an `inert` element, an open showModal() dialog. */
interface Blockers { inert: boolean; modal: boolean }

/**
 * A child frame inherits inertness from its embedding element, including shadow hosts and outer frames. An open
 * showModal() dialog that does not contain the embedding element makes it inert too. `blockers` keeps, for one
 * scan, what each document holds: most hold neither, and their frames then need no look at their ancestors.
 */
export async function frameIsInert(frame: Frame, blockers = new Map<Frame, Promise<Blockers | null>>()): Promise<boolean> {
  for (let parent = frame.parentFrame(); parent; frame = parent, parent = frame.parentFrame()) {
    const found = await blockersIn(parent, blockers);
    if (found && !found.inert && !found.modal) continue;
    const element = await frame.frameElement();
    try {
      const ancestry = await element.evaluate((node) => {
        if (!(node instanceof Element)) return 'outside';
        for (let el: Element | null = node; el;) {
          if (el.hasAttribute('inert')) return 'inert';
          if (el.matches('dialog:modal')) return 'in modal';
          const root = el.getRootNode();
          el = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return 'outside';
      });
      if (ancestry === 'inert') return true;
      if (ancestry === 'outside' && (found?.modal ?? false)) return true;
    } finally {
      await element.dispose();
    }
  }
  return false;
}

/** null when the document cannot be read: its frames are then looked at one by one. */
function blockersIn(frame: Frame, blockers: Map<Frame, Promise<Blockers | null>>): Promise<Blockers | null> {
  let found = blockers.get(frame);
  if (!found) {
    found = frame.evaluate(() => {
      const result = { inert: false, modal: false };
      const walk = (root: Document | ShadowRoot) => {
        result.inert ||= root.querySelector('[inert]') !== null;
        result.modal ||= root.querySelector('dialog:modal') !== null;
        for (const child of Array.from(root.querySelectorAll('*'))) if (child.shadowRoot) walk(child.shadowRoot);
      };
      walk(document);
      return result;
    }).catch(() => null);
    blockers.set(frame, found);
  }
  return found;
}
