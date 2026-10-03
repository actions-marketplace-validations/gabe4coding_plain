import { z } from 'zod';
import type { Snapshot } from './automation.js';
import { errorMessage } from './results.js';
import { describeSnapshot, type SnapshotEvidence } from '../jev/describe.js';

export const SnapshotOptions = {
  mode: z.enum(['raw', 'compact', 'smart']).default('raw'),
  maxChars: z.number().int().min(1).max(60000).optional(),
  intent: z.string().trim().min(1).max(2000).optional(),
};
export const SNAPSHOT_MODES_DESCRIPTION = ' mode: raw (default), compact (no classification call), or smart (Jev classifies state). ' +
  'compact/smart preserve exact evidence with omission counts; default evidence budget 6000 chars versus raw 20000. ' +
  'intent is smart-only: return relevant UI regions plus recognized critical messages, without filling unused space. ' +
  'Check inferred.selection for no confident match or fallback. Inferences are advisory; omitted content is not absent. ' +
  'Known actions need no preceding snapshot: step finds its own targets.';

const RAW_MAX_CHARS = 20000;
const COMPACT_MAX_CHARS = 6000;
const MAX_REGIONS = 64;
const RELEVANT_AT = 0.5;
const UNCERTAIN_ABOVE = 0.1;

/** Which lines a compact view keeps first. A line inherits `critical` and `chrome` from its parent. */
const PRIORITY = { critical: 4, useful: 1, plain: 0, chrome: -1 };

const CRITICAL_ROLES = new Set(['dialog', 'alertdialog', 'alert', 'status', 'sheet']);
const CHROME_ROLES = new Set(['navigation', 'contentinfo', 'menubar']);
const USEFUL_ROLES = new Set(['heading', 'header', 'button', 'link', 'textbox', 'textfield', 'securetextfield', 'edittext',
  'combobox', 'checkbox', 'radiobutton', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox', 'textview', 'progressbar']);
const REGION_ROLES = new Set(['search', 'form', 'region', 'navigation', 'contentinfo', 'banner', 'main', 'complementary',
  'dialog', 'alertdialog', 'alert', 'status', 'sheet', 'window', 'table', 'list', 'tablist', 'toolbar', 'menubar']);
const CONTAINER_ROLES = new Set(['group', 'generic', 'other', 'view', 'viewgroup']);
const WRAPPER_LINE = /^\s*(?:- )?(?:generic|group|AXGroup|XCUIElementTypeOther)(?: "")?:?\s*$/;

interface Line {
  text: string;
  parent: number | undefined;
  /** The heading line whose section holds this line. */
  section: number | undefined;
  /** A bare container: no text of its own. */
  wrapper: boolean;
  priority: number;
  /** The region (index in `blocks`) the line belongs to. */
  block: number;
}

/** The role token of a browser, desktop or mobile tree line, normalized for the priority rules only. */
function roleOf(text: string): string {
  const token = text.trim().replace(/^- /, '').match(/^[\w.]+/)?.[0] ?? '';
  return token.replace(/^.*\./, '').replace(/^AX|^XCUIElementType/, '').replace(/_/g, '').toLowerCase();
}

function priorityOf(role: string, inherited: number): number {
  if (CRITICAL_ROLES.has(role) || inherited === PRIORITY.critical) return PRIORITY.critical;
  if (CHROME_ROLES.has(role) || inherited === PRIORITY.chrome) return PRIORITY.chrome;
  return USEFUL_ROLES.has(role) ? PRIORITY.useful : PRIORITY.plain;
}

/**
 * Parses an aria tree into lines (with parents) and regions. A heading owns its following siblings until the
 * next heading; a landmark or a named group owns its descendants only, never its following siblings, so
 * unrelated chrome next to a form stays out of the form's region.
 */
export function parseAriaTree(snap: Snapshot) {
  const lines: Line[] = [];
  const openAncestors: { indent: number; index: number }[] = [];
  const blocks: SnapshotEvidence['blocks'] = [];
  /** Parent line (-1 for the root) → the heading section open under it. */
  const sections = new Map<number, { block: number; heading: number }>();
  let rootBlock: number | undefined;

  for (const text of snap.aria.split('\n')) {
    if (!text.trim()) continue;
    // An iframe's tree and an open dialog the cap would cut (page.ts) come under their own header.
    const isFrameStart = /^--- (iframe |open dialog ---)/.test(text);
    const indent = isFrameStart ? -1 : text.length - text.trimStart().length;
    while (openAncestors.length && openAncestors.at(-1)!.indent >= indent) openAncestors.pop();
    const parent = openAncestors.at(-1)?.index;
    const parentKey = parent ?? -1;
    const role = roleOf(text);
    const priority = priorityOf(role, parent === undefined ? PRIORITY.plain : lines[parent].priority);
    const isHeading = role === 'heading' || role === 'header';
    const isRegion = isFrameStart || REGION_ROLES.has(role) || (CONTAINER_ROLES.has(role) && /"[^"\n]+"/.test(text));
    const section = sections.get(parentKey);

    let block = section?.block ?? (parent === undefined ? rootBlock : lines[parent].block);
    if (isRegion || isHeading || block === undefined) {
      block = blocks.length;
      const context = openAncestors.map((ancestor) => lines[ancestor.index].text);
      if (section && !isHeading) context.push(lines[section.heading].text);
      blocks.push({ aria: '', context });
      if (isHeading) sections.set(parentKey, { block, heading: lines.length });
      if (isRegion && parent === undefined) {
        sections.delete(-1); // a top-level landmark ends the previous heading's section
        rootBlock = undefined;
      } else if (parent === undefined && !isHeading) {
        rootBlock = block;
      }
    }
    blocks[block].aria += (blocks[block].aria ? '\n' : '') + text;
    const ownSection = isHeading || (parent === undefined && isRegion) ? undefined : section?.heading;
    lines.push({ text, parent, section: ownSection, priority, block, wrapper: WRAPPER_LINE.test(text) });
    openAncestors.push({ indent, index: lines.length - 1 });
  }
  return { lines, blocks };
}

/**
 * Keeps the highest-ranked lines that fit `maxChars`, each with its ancestors and its section heading.
 * `focused`: only critical lines and lines of relevant regions qualify.
 */
function selectEvidence(lines: Line[], maxChars: number, relevance: number[], focused: boolean) {
  const isRelevant = (line: Line) => (relevance[line.block] ?? 0) >= RELEVANT_AT;
  const qualifies = (line: Line) => !focused || line.priority === PRIORITY.critical || isRelevant(line);
  // Relevance chooses evidence, not actions: the surer region wins when the budget cannot hold both.
  const rankOf = (line: Line) => line.priority === PRIORITY.critical ? PRIORITY.critical
    : isRelevant(line) ? 2 + relevance[line.block] : line.priority;
  const ranked = lines.map((line, index) => ({ index, rank: rankOf(line) }))
    .filter(({ index }) => !lines[index].wrapper && qualifies(lines[index]))
    .sort((a, b) => b.rank - a.rank || a.index - b.index);

  const selected = new Set<number>();
  let chars = 0;
  for (const { index } of ranked) {
    const needed = linesToShow(lines, index, selected);
    const cost = [...needed].reduce((sum, i) => sum + lines[i].text.length + 1, 0);
    if (chars + cost > maxChars + 1) continue;
    for (const i of needed) selected.add(i);
    chars += cost;
  }

  const removedWrappers = lines.filter((line) => line.wrapper).length;
  return {
    aria: [...selected].sort((a, b) => a - b).map((i) => lines[i].text).join('\n'),
    omittedLines: lines.length - removedWrappers - selected.size,
    filteredLines: lines.filter((line, i) => !line.wrapper && !qualifies(line) && !selected.has(i)).length,
    omittedCriticalLines: lines.filter((line, i) => !line.wrapper && line.priority === PRIORITY.critical && !selected.has(i)).length,
    removedWrappers,
  };
}

/** A line plus the ancestors and section headings it needs to make sense, minus what is already shown. */
function linesToShow(lines: Line[], index: number, shown: Set<number>): Set<number> {
  const needed = new Set<number>();
  const pending = [index];
  const visited = new Set<number>();
  while (pending.length) {
    const cursor = pending.pop()!;
    if (shown.has(cursor) || visited.has(cursor)) continue;
    visited.add(cursor);
    if (!lines[cursor].wrapper) needed.add(cursor);
    const { parent, section } = lines[cursor];
    if (parent !== undefined) pending.push(parent);
    if (section !== undefined) pending.push(section);
  }
  return needed;
}

type ViewOptions = { mode?: 'raw' | 'compact' | 'smart'; maxChars?: number; intent?: string };

/** A view of a fresh capture for the agent to read; never a replacement for the adapter's action candidates. */
export async function snapshotView(snap: Snapshot, options: ViewOptions = {}, describe: typeof describeSnapshot = describeSnapshot) {
  const started = performance.now();
  const { mode, maxChars: requestedMax, intent } = z.object(SnapshotOptions).parse(options);
  if (intent && mode !== 'smart') throw new Error('snapshot intent requires mode: smart');
  const maxChars = requestedMax ?? (mode === 'raw' ? RAW_MAX_CHARS : COMPACT_MAX_CHARS);
  if (mode === 'raw') return { ...snap, aria: snap.aria.slice(0, maxChars), truncated: snap.truncated || snap.aria.length > maxChars };

  const { lines, blocks } = parseAriaTree(snap);
  // The classification request is bounded to the highest-priority regions. The rest stay visible in `coverage`:
  // a negative claim must not treat them as absent.
  const regionPriority = blocks.map(() => 0);
  for (const line of lines) regionPriority[line.block] = Math.max(regionPriority[line.block], line.priority);
  const assessed = blocks.map((_, i) => i).sort((a, b) => regionPriority[b] - regionPriority[a] || a - b)
    .slice(0, MAX_REGIONS).sort((a, b) => a - b);

  let description: Awaited<ReturnType<typeof describeSnapshot>> | undefined;
  let inferenceError: string | undefined;
  let jevMs = 0;
  if (mode === 'smart' && blocks.length) {
    const jevStart = performance.now();
    try {
      const evidence = { url: snap.url, title: snap.title, truncated: snap.truncated || assessed.length < blocks.length,
        blocks: assessed.map((i) => blocks[i]) };
      description = await describe(evidence, intent);
    } catch (error) {
      inferenceError = errorMessage(error);
    }
    jevMs = performance.now() - jevStart;
  }

  const relevance: number[] = [];
  if (description) assessed.forEach((block, i) => { relevance[block] = description!.relevance[i]; });
  const matches = relevance.filter((p) => p >= RELEVANT_AT).length;
  const selection = intent ? {
    status: !description ? 'fallback' : matches ? 'focused' : 'no-confident-match',
    matchedRegions: matches,
    uncertainRegions: relevance.filter((p) => p > UNCERTAIN_ABOVE && p < RELEVANT_AT).length,
  } : undefined;
  const { aria, ...coverage } = selectEvidence(lines, maxChars, relevance, Boolean(intent && description));

  const inferred = description
    ? { status: 'available', screen: description.screen, signals: description.signals }
    : { status: 'unavailable', reason: inferenceError ?? 'empty capture; no classification requested' };
  return {
    url: snap.url,
    title: snap.title,
    mode,
    observed: { aria },
    ...(mode === 'smart' ? { inferred: { ...inferred, ...(selection ? { selection } : {}) } } : {}),
    coverage: {
      ...coverage,
      sourceTruncated: snap.truncated,
      sourceLines: lines.length,
      sourceChars: snap.aria.length,
      returnedChars: aria.length,
      ...(mode === 'smart' ? { unassessedRegions: blocks.length - (description ? assessed.length : 0) } : {}),
    },
    truncated: snap.truncated || coverage.omittedLines > 0,
    // A failed request may have used tokens without reporting them.
    jevTokens: inferenceError ? null : description?.tokens ?? 0,
    ms: { projection: performance.now() - started, jev: jevMs },
  };
}
