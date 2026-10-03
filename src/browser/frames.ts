import type { ElementHandle, Frame } from 'playwright';
import { blockingLayer } from './layer.js';

/** Iframe name, or its URL's pathname. Labels iframe candidates and iframe snapshot sections. */
export function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try { return new URL(frame.url()).pathname || frame.url(); } catch { return frame.url(); }
}

/**
 * What in a document can make an embedded frame inert: an `inert` element, an open showModal() dialog, or the
 * layer a script dialog puts over the page (`blockingLayer`, a handle to release with `releaseBlockers`).
 */
export interface Blockers { inert: boolean; modal: boolean; layer: ElementHandle<Element> | null }
/** One scan's Blockers per document; null when the document cannot be read. */
export type BlockerCache = Map<Frame, Promise<Blockers | null>>;

/**
 * A child frame inherits inertness from its embedding element, including shadow hosts and outer frames. An open
 * showModal() dialog, or a script dialog's layer, that does not contain the embedding element makes it inert too.
 * Most documents hold none of these, and their frames then need no look at their ancestors.
 */
export async function frameIsInert(frame: Frame, blockers: BlockerCache): Promise<boolean> {
  for (let parent = frame.parentFrame(); parent; frame = parent, parent = frame.parentFrame()) {
    const found = await blockersIn(parent, blockers);
    if (found && !found.inert && !found.modal && !found.layer) continue;
    const element = await frame.frameElement();
    try {
      const ancestry = await element.evaluate((node, layer) => {
        if (!(node instanceof Element)) return 'outside';
        let inLayer = false;
        for (let el: Element | null = node; el;) {
          if (el.hasAttribute('inert')) return 'inert';
          if (el.matches('dialog:modal')) return 'in modal';
          inLayer ||= el === layer;
          const root = el.getRootNode();
          el = el.assignedSlot ?? el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return layer && !inLayer ? 'inert' : 'outside';
      }, found?.layer ?? null);
      if (ancestry === 'inert') return true;
      if (ancestry === 'outside' && (found?.modal ?? false)) return true;
    } finally {
      await element.dispose();
    }
  }
  return false;
}

export function blockersIn(frame: Frame, blockers: BlockerCache): Promise<Blockers | null> {
  let found = blockers.get(frame);
  if (!found) {
    found = (async () => {
      const { dialog, ...flags } = await frame.evaluate(() => {
        const result = { inert: false, modal: false, dialog: false };
        const walk = (root: Document | ShadowRoot) => {
          result.inert ||= root.querySelector('[inert]') !== null;
          result.modal ||= root.querySelector('dialog:modal') !== null;
          result.dialog ||= Array.from(root.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]'))
            .some((el) => el.checkVisibility());
          for (const child of Array.from(root.querySelectorAll('*'))) if (child.shadowRoot) walk(child.shadowRoot);
        };
        walk(document);
        return result;
      });
      // Only a visible dialog can have a layer: most documents have none and need no second look.
      return { ...flags, layer: dialog ? await settledLayer(frame) : null };
    })().catch(() => null);
    blockers.set(frame, found);
  }
  return found;
}

/** How long a dialog's layer may animate before it is taken as it is. */
const LAYER_ANIMATION_MS = 1_000;

/**
 * The layer once its own animations end. A dialog that fades out after its close button keeps covering the page
 * for its animation, and the page's DOM stays quiet meanwhile, so the settle before the step does not wait for it.
 */
async function settledLayer(frame: Frame): Promise<ElementHandle<Element> | null> {
  for (let look = 0; look < 2; look++) {
    const handle = await frame.evaluateHandle(blockingLayer);
    const layer = handle.asElement();
    if (!layer) {
      await handle.dispose();
      return null;
    }
    const animated = await layer.evaluate((el, maxMs) => {
      const running = el.getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      if (!running.length) return false;
      const ended = Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      return Promise.race([ended, new Promise((done) => setTimeout(done, maxMs))]).then(() => true);
    }, LAYER_ANIMATION_MS);
    if (!animated || look === 1) return layer;
    await layer.dispose();
  }
  return null;
}

export async function releaseBlockers(blockers: BlockerCache): Promise<void> {
  for (const found of blockers.values()) await (await found)?.layer?.dispose().catch(() => {});
}
