import { z } from 'zod';
import { describeSnapshot } from './jev.js';
export const SnapshotOptions = {
    mode: z.enum(['raw', 'compact', 'smart']).default('raw'),
    maxChars: z.number().int().min(1).max(60000).optional(),
    intent: z.string().trim().min(1).max(2000).optional(),
};
export const SNAPSHOT_MODES_DESCRIPTION = ' mode: raw (default), compact (no classification call), or smart (Jev classifies state). ' +
    'compact/smart preserve exact evidence with omission counts; default evidence budget 6000 chars versus raw 20000. ' +
    'intent is smart-only and prioritizes relevant evidence. Inferences are advisory; omitted content is not absent. ' +
    'Known actions need no preceding snapshot: step finds its own targets.';
// Normalize only the role token for priority rules; emitted evidence remains verbatim.
function roleOf(text) {
    return (text.trim().replace(/^- /, '').match(/^[\w.]+/)?.[0] ?? '').replace(/^.*\./, '').replace(/^AX|^XCUIElementType/, '').replace(/_/g, '').toLowerCase();
}
const criticalRoles = new Set(['dialog', 'alertdialog', 'alert', 'status', 'sheet']);
const usefulRoles = new Set(['heading', 'header', 'button', 'link', 'textbox', 'textfield', 'securetextfield', 'edittext',
    'combobox', 'checkbox', 'radiobutton', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox', 'textview', 'progressbar']);
function prepare(snap) {
    const lines = [];
    const stack = [];
    const blocks = [];
    let blockChars = 0;
    // At most 24 blocks/questions even for large trees. Never split a source line.
    const blockSize = Math.max(2000, Math.ceil(snap.aria.length / 23));
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
        if (!blocks.length || blockChars >= blockSize && blocks.length < 24) {
            blocks.push({ aria: '', context: stack.map(s => lines[s.index].text) });
            blockChars = 0;
        }
        const block = blocks.length - 1;
        blocks[block].aria += (blocks[block].aria ? '\n' : '') + text;
        blockChars += text.length + 1;
        lines.push({ text, parent, priority, block,
            wrapper: /^\s*(?:- )?(?:generic|group|AXGroup|XCUIElementTypeOther)(?: "")?:?\s*$/.test(text) });
        stack.push({ indent, index: lines.length - 1 });
    }
    return { lines, blocks };
}
function selectEvidence(lines, maxChars, relevance) {
    const selected = new Set();
    let chars = 0;
    const ranked = lines.map((line, index) => ({ index, priority: line.priority === 4 ? 4 :
            // Relevance only orders evidence; it is not a claim or permission to act. Retain score
            // ordering among relevant blocks so a marginal match cannot crowd out a strong one.
            (relevance[line.block] ?? 0) >= .5 ? 2 + relevance[line.block] : line.priority }))
        .filter(({ index }) => !lines[index].wrapper)
        .sort((a, b) => b.priority - a.priority || a.index - b.index);
    for (const { index } of ranked) {
        const needed = [];
        let cursor = index;
        while (cursor !== undefined && !selected.has(cursor)) {
            if (!lines[cursor].wrapper)
                needed.push(cursor);
            cursor = lines[cursor].parent;
        }
        const cost = needed.reduce((sum, i) => sum + lines[i].text.length + 1, 0);
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
    let description;
    let inferenceError;
    let jevMs = 0;
    if (mode === 'smart' && blocks.length) {
        const start = performance.now();
        try {
            description = await describe({ url: snap.url, title: snap.title, truncated: snap.truncated, blocks }, intent);
        }
        catch (error) {
            inferenceError = error instanceof Error ? error.message : String(error);
        }
        jevMs = performance.now() - start;
    }
    const { aria, ...coverage } = selectEvidence(lines, maxChars, description?.relevance ?? []);
    return {
        url: snap.url, title: snap.title, mode,
        observed: { aria },
        ...(mode === 'smart' ? { inferred: description ? { status: 'available', screen: description.screen, signals: description.signals } :
                { status: 'unavailable', reason: inferenceError ?? 'empty capture; no classification requested' } } : {}),
        coverage: { ...coverage, sourceTruncated: snap.truncated, sourceLines: lines.length, sourceChars: snap.aria.length, returnedChars: aria.length },
        truncated: snap.truncated || coverage.omittedLines > 0,
        // A failed provider request may have consumed tokens without returning usage.
        jevTokens: inferenceError ? null : description?.tokens ?? 0,
        ms: { projection: performance.now() - started, jev: jevMs },
    };
}
