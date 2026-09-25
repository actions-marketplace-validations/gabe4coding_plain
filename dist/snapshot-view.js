import { z } from 'zod';
import { describeSnapshot } from './jev.js';
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
// Normalize only the role token for priority rules; emitted evidence remains verbatim.
function roleOf(text) {
    return (text.trim().replace(/^- /, '').match(/^[\w.]+/)?.[0] ?? '').replace(/^.*\./, '').replace(/^AX|^XCUIElementType/, '').replace(/_/g, '').toLowerCase();
}
const criticalRoles = new Set(['dialog', 'alertdialog', 'alert', 'status', 'sheet']);
const usefulRoles = new Set(['heading', 'header', 'button', 'link', 'textbox', 'textfield', 'securetextfield', 'edittext',
    'combobox', 'checkbox', 'radiobutton', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox', 'textview', 'progressbar']);
const regionRoles = new Set(['search', 'form', 'region', 'navigation', 'contentinfo', 'banner', 'main', 'complementary',
    'dialog', 'alertdialog', 'alert', 'status', 'sheet', 'window', 'table', 'list', 'tablist', 'toolbar', 'menubar']);
const MAX_REGIONS = 64;
export function prepare(snap) {
    const lines = [];
    const stack = [];
    const blocks = [];
    // A heading owns subsequent siblings until the next heading. Landmarks/groups own
    // their descendants, never their following siblings. This keeps unrelated chrome
    // out of a form even when they are adjacent in the serialized tree.
    const sections = new Map();
    let rootBlock;
    for (const text of snap.aria.split('\n')) {
        if (!text.trim())
            continue;
        const frameBoundary = /^--- iframe /.test(text);
        const indent = frameBoundary ? -1 : text.length - text.trimStart().length;
        while (stack.length && stack.at(-1).indent >= indent)
            stack.pop();
        const parent = stack.at(-1)?.index;
        const role = roleOf(text);
        const inherited = parent === undefined ? 0 : lines[parent].priority;
        const priority = criticalRoles.has(role) || inherited === 4 ? 4 :
            ['navigation', 'contentinfo', 'menubar'].includes(role) || inherited === -1 ? -1 : usefulRoles.has(role) ? 1 : 0;
        const heading = role === 'heading' || role === 'header';
        const boundary = frameBoundary || regionRoles.has(role) ||
            ['group', 'generic', 'other', 'view', 'viewgroup'].includes(role) && /"[^"\n]+"/.test(text);
        const section = sections.get(parent ?? -1);
        let block = section?.block ?? (parent === undefined ? rootBlock : lines[parent].block);
        if (boundary || heading || block === undefined) {
            block = blocks.length;
            const context = stack.map(s => lines[s.index].text);
            if (section && !heading)
                context.push(lines[section.heading].text);
            blocks.push({ aria: '', context });
            if (heading)
                sections.set(parent ?? -1, { block, heading: lines.length });
            // A top-level landmark ends the previous heading section.
            if (boundary && parent === undefined) {
                sections.delete(-1);
                rootBlock = undefined;
            }
            else if (parent === undefined && !heading)
                rootBlock = block;
        }
        blocks[block].aria += (blocks[block].aria ? '\n' : '') + text;
        lines.push({ text, parent, section: heading || parent === undefined && boundary ? undefined : section?.heading, priority, block,
            wrapper: /^\s*(?:- )?(?:generic|group|AXGroup|XCUIElementTypeOther)(?: "")?:?\s*$/.test(text) });
        stack.push({ indent, index: lines.length - 1 });
    }
    return { lines, blocks };
}
function selectEvidence(lines, maxChars, relevance, focused) {
    const selected = new Set();
    let chars = 0;
    const eligible = (line) => !focused || line.priority === 4 || (relevance[line.block] ?? 0) >= .5;
    const ranked = lines.map((line, index) => ({ index, priority: line.priority === 4 ? 4 :
            // Relevance chooses evidence, not actions. Score ordering determines which matching
            // regions fit when the budget cannot hold all of them.
            (relevance[line.block] ?? 0) >= .5 ? 2 + relevance[line.block] : line.priority }))
        .filter(({ index }) => !lines[index].wrapper && eligible(lines[index]))
        .sort((a, b) => b.priority - a.priority || a.index - b.index);
    for (const { index } of ranked) {
        const needed = new Set();
        const pending = [index];
        const visited = new Set();
        while (pending.length) {
            const cursor = pending.pop();
            if (selected.has(cursor) || visited.has(cursor))
                continue;
            visited.add(cursor);
            if (!lines[cursor].wrapper)
                needed.add(cursor);
            const { parent, section } = lines[cursor];
            if (parent !== undefined)
                pending.push(parent);
            if (section !== undefined)
                pending.push(section);
        }
        const cost = [...needed].reduce((sum, i) => sum + lines[i].text.length + 1, 0);
        if (chars + cost > maxChars + 1)
            continue;
        for (const i of needed)
            selected.add(i);
        chars += cost;
    }
    const removedWrappers = lines.filter(l => l.wrapper).length;
    return {
        aria: [...selected].sort((a, b) => a - b).map(i => lines[i].text).join('\n'),
        omittedLines: lines.length - removedWrappers - selected.size,
        filteredLines: lines.filter((l, i) => !l.wrapper && !eligible(l) && !selected.has(i)).length,
        omittedCriticalLines: lines.filter((l, i) => !l.wrapper && l.priority === 4 && !selected.has(i)).length,
        removedWrappers,
    };
}
/** A projection of a fresh capture, never a replacement for the adapter's action candidates. */
export async function snapshotView(snap, options = {}, describe = describeSnapshot) {
    const started = performance.now();
    const { mode, maxChars: requestedMax, intent } = z.object(SnapshotOptions).parse(options);
    if (intent && mode !== 'smart')
        throw new Error('snapshot intent requires mode: smart');
    const maxChars = requestedMax ?? (mode === 'raw' ? 20000 : 6000);
    if (mode === 'raw')
        return { ...snap, aria: snap.aria.slice(0, maxChars), truncated: snap.truncated || snap.aria.length > maxChars };
    const { lines, blocks } = prepare(snap);
    // Keep the request bounded without merging unrelated regions. Unassessed regions
    // remain visible in coverage; negative claims cannot treat them as absent.
    const regionPriority = blocks.map(() => 0);
    for (const line of lines)
        regionPriority[line.block] = Math.max(regionPriority[line.block], line.priority);
    const assessed = blocks.map((_, i) => i).sort((a, b) => regionPriority[b] - regionPriority[a] || a - b)
        .slice(0, MAX_REGIONS).sort((a, b) => a - b);
    let description;
    let inferenceError;
    let jevMs = 0;
    if (mode === 'smart' && blocks.length) {
        const start = performance.now();
        try {
            description = await describe({ url: snap.url, title: snap.title,
                truncated: snap.truncated || assessed.length < blocks.length, blocks: assessed.map(i => blocks[i]) }, intent);
        }
        catch (error) {
            inferenceError = error instanceof Error ? error.message : String(error);
        }
        jevMs = performance.now() - start;
    }
    const relevance = [];
    if (description)
        assessed.forEach((block, i) => { relevance[block] = description.relevance[i]; });
    const focused = Boolean(intent && description);
    const matches = relevance.filter(p => p >= .5).length;
    const selection = intent ? { status: !description ? 'fallback' : matches ? 'focused' : 'no-confident-match',
        matchedRegions: matches, uncertainRegions: relevance.filter(p => p > .1 && p < .5).length } : undefined;
    const { aria, ...coverage } = selectEvidence(lines, maxChars, relevance, focused);
    return {
        url: snap.url, title: snap.title, mode,
        observed: { aria },
        ...(mode === 'smart' ? { inferred: { ...(description ? { status: 'available', screen: description.screen, signals: description.signals } :
                    { status: 'unavailable', reason: inferenceError ?? 'empty capture; no classification requested' }), ...(selection ? { selection } : {}) } } : {}),
        coverage: { ...coverage, sourceTruncated: snap.truncated, sourceLines: lines.length, sourceChars: snap.aria.length, returnedChars: aria.length,
            ...(mode === 'smart' ? { unassessedRegions: blocks.length - (description ? assessed.length : 0) } : {}) },
        truncated: snap.truncated || coverage.omittedLines > 0,
        // A failed provider request may have consumed tokens without returning usage.
        jevTokens: inferenceError ? null : description?.tokens ?? 0,
        ms: { projection: performance.now() - started, jev: jevMs },
    };
}
