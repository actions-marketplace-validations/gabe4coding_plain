/**
 * The layer a script dialog puts over the page, or null. Runs inside the page, so it is self-contained.
 *
 * A role=dialog or aria-modal element does not make the page inert by itself: many cookie banners carry
 * aria-modal and leave the page usable. A dialog blocks the page when what a pointer hits at the viewport's
 * corners and center all sits in one element that holds an open dialog and is, or is inside, a fixed-position
 * box: a click on anything outside that layer lands on its overlay, wherever the page is scrolled. Hits follow open shadow roots, and
 * containment follows the flat tree, so a slotted control is inside the layer its slot renders in.
 */
export function blockingLayer(): Element | null {
  const DIALOG = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]';
  const EDGE = 2;
  const width = innerWidth;
  const height = innerHeight;
  if (!document.body || width <= EDGE * 2 || height <= EDGE * 2) return null;
  const points = [[EDGE, EDGE], [width - EDGE - 1, EDGE], [EDGE, height - EDGE - 1], [width - EDGE - 1, height - EDGE - 1],
    [width / 2, height / 2]];

  const parentOf = (el: Element): Element | null => {
    const root = el.getRootNode();
    return el.assignedSlot ?? el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  };
  const hitAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const holdsOpenDialog = (el: Element): boolean => {
    const roots: (Element | ShadowRoot)[] = [el];
    if (el.shadowRoot) roots.push(el.shadowRoot);
    for (const root of roots) {
      const dialogs = root instanceof Element && root.matches(DIALOG) ? [root] : [];
      dialogs.push(...Array.from(root.querySelectorAll(DIALOG)));
      if (dialogs.some((dialog) => dialog.checkVisibility())) return true;
      for (const child of Array.from(root.querySelectorAll('*'))) if (child.shadowRoot && holdsOpenDialog(child)) return true;
    }
    return false;
  };
  const isPage = (el: Element) => el === document.body || el === document.documentElement;

  // The layer is the nearest fixed box at or around the nearest box that holds an open dialog, seen from the first
  // hit. A fixed box below that holder (a sticky header in an app wrapper that also holds a banner) does not count.
  let holder: Element | null = null;
  for (let el = hitAt(points[0][0], points[0][1]); el && !isPage(el) && !holder; el = parentOf(el)) {
    if (holdsOpenDialog(el)) holder = el;
  }
  let layer: Element | null = null;
  for (let el = holder; el && !isPage(el) && !layer; el = parentOf(el)) {
    if (getComputedStyle(el).position === 'fixed') layer = el;
  }
  if (!layer) return null;
  const inLayer = (el: Element | null) => {
    for (; el; el = parentOf(el)) if (el === layer) return true;
    return false;
  };
  return points.every(([x, y]) => inLayer(hitAt(x, y))) ? layer : null;
}
