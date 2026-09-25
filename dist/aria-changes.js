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
