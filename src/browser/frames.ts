import type { Frame } from 'playwright';

/** Iframe name, or its URL's pathname. Labels iframe candidates and iframe snapshot sections. */
export function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try { return new URL(frame.url()).pathname || frame.url(); } catch { return frame.url(); }
}

/**
 * A child frame inherits inertness from its embedding element, including shadow hosts and outer frames. An open
 * showModal() dialog that does not contain the embedding element makes it inert too.
 */
export async function frameIsInert(frame: Frame): Promise<boolean> {
  for (let parent = frame.parentFrame(); parent; frame = parent, parent = frame.parentFrame()) {
    const element = await frame.frameElement();
    try {
      const inert = await element.evaluate((node) => {
        if (!(node instanceof Element)) return false;
        for (let el: Element | null = node; el;) {
          if (el.hasAttribute('inert')) return true;
          if (el.matches('dialog:modal')) return false;
          const root = el.getRootNode();
          el = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        const modalIn = (root: Document | ShadowRoot): boolean => root.querySelector('dialog:modal') !== null ||
          Array.from(root.querySelectorAll('*')).some((child) => child.shadowRoot !== null && modalIn(child.shadowRoot));
        return modalIn(node.ownerDocument);
      });
      if (inert) return true;
    } finally {
      await element.dispose();
    }
  }
  return false;
}
