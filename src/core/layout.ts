import type { Candidate } from './automation.js';

/** Rendered edges of an element. */
export type Bounds = NonNullable<Candidate['bounds']>;
export interface LayoutItem { description: string; name: string; bounds: Bounds }

/** The browser and the native layouts list at most this many elements, in at most this many characters. */
export const MAX_LAYOUT_ELEMENTS = 254;
export const MAX_LAYOUT_CHARS = 24_000;
export const LAYOUT_TRUNCATED = 'Layout truncated: do not infer absence or extremes across omitted elements.';

/**
 * Qualitative neighbors expose measured order without asking Jev to infer it from tree order or arithmetic. Only
 * the nearest element per direction with perpendicular overlap is named: the raw bounds stay in the layout for the
 * other relations.
 */
export function neighborRelations(items: LayoutItem[]): string[] {
  const relations = new Set<string>();
  for (const item of items) {
    const nearest: Partial<Record<'above' | 'below' | 'left of' | 'right of', { gap: number; items: LayoutItem[] }>> = {};
    for (const other of items) {
      if (item === other) continue;
      const a = item.bounds;
      const b = other.bounds;
      const horizontal = Math.min(a.right, b.right) > Math.max(a.left, b.left);
      const vertical = Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
      const measured: [keyof typeof nearest, number][] = [];
      if (horizontal && a.bottom <= b.top) measured.push(['above', b.top - a.bottom]);
      if (horizontal && a.top >= b.bottom) measured.push(['below', a.top - b.bottom]);
      if (vertical && a.right <= b.left) measured.push(['left of', b.left - a.right]);
      if (vertical && a.left >= b.right) measured.push(['right of', a.left - b.right]);
      for (const [direction, gap] of measured) {
        const known = nearest[direction];
        if (!known || gap < known.gap) nearest[direction] = { gap, items: [other] };
        else if (gap === known.gap) known.items.push(other);
      }
    }
    for (const [direction, found] of Object.entries(nearest)) {
      for (const other of found.items) relations.add(`${item.name} is ${direction} ${other.name}.`);
    }
  }
  return [...relations];
}

/** Joins lines up to MAX_LAYOUT_CHARS; a cut ends with the truncation line. */
export function joinLayout(lines: string[]): string {
  let text = '';
  for (const line of lines) {
    if (text.length + line.length > MAX_LAYOUT_CHARS) return `${text}\n${LAYOUT_TRUNCATED}`;
    text += `${text ? '\n' : ''}${line}`;
  }
  return text;
}

/**
 * The layout of a desktop or mobile capture: accessibility rows with their bounds and the measured neighbors.
 * `coordinates` names the platform's coordinate space.
 */
export function nativeLayout(items: LayoutItem[], coordinates: string, truncated: boolean): string {
  const listed = items.slice(0, MAX_LAYOUT_ELEMENTS);
  const neighbors = neighborRelations(listed);
  return joinLayout([
    `Rendered bounds in ${coordinates}: x increases right, y increases down.`,
    'Use bounds for spatial claims. Tree order is not visual order. Missing required geometry is insufficient evidence.',
    'Each row is an accessibility element: its role, its name in quotes and its current value. A claimed name or value and its spatial relation must all match the same elements.',
    ...listed.map((item) => `${item.description} bounds=${JSON.stringify(item.bounds)}`),
    ...(neighbors.length ? ['Measured neighbors (nearest with perpendicular overlap; other relations still use bounds):', ...neighbors] : []),
    ...(truncated || items.length > listed.length ? [LAYOUT_TRUNCATED] : []),
  ]);
}
