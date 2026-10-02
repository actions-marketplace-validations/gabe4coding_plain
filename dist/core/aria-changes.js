// Step (and batch) results in every MCP server carry `changed`, what the action did to the page or screen: the
// agent reads the outcome there instead of a snapshot/ask call (browser: -30% tool calls, -20% agent cost;
// docs/benchmarks/agent-changes.md). PLAINWRIGHT_CHANGES=0 turns it off, to measure against (scripts/benchmark-agent.mjs).
export const CHANGES = process.env.PLAINWRIGHT_CHANGES !== '0';
export const CHANGES_NOTE = !CHANGES ? '' : ' The result also has `changed`: the page title/URL if they changed, and the accessibility-tree ' +
    'lines the action added (`added`, in page order, capped) and how many it removed. Read it before calling snapshot or ask.';
// About a compact snapshot's worth of the new lines: a navigation shows the top of the new page.
export const ADDED_CHARS = 1500;
/** What an action changed in the page: a line-multiset diff of two aria snapshots. */
export function ariaChanges(before, after, cap = ADDED_CHARS) {
    const left = new Map();
    const lines = (aria) => aria.split('\n').filter((l) => l.trim() !== '');
    for (const l of lines(before.aria))
        left.set(l, (left.get(l) ?? 0) + 1);
    const added = [];
    let chars = 0, omitted = 0;
    for (const l of lines(after.aria)) {
        const n = left.get(l) ?? 0;
        if (n > 0) {
            left.set(l, n - 1);
            continue;
        }
        if (chars + l.length + 1 > cap) {
            omitted++;
            continue;
        }
        added.push(l);
        chars += l.length + 1;
    }
    const removed = [...left.values()].reduce((a, b) => a + b, 0);
    return {
        ...(after.title !== before.title ? { title: after.title } : {}),
        ...(after.url !== before.url ? { url: after.url } : {}),
        added, addedOmitted: omitted, removed,
    };
}
