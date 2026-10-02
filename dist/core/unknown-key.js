/** `unknown key "whithin"; did you mean "within"?`, or the keys it could be when none is close. */
export function unknownKey(key, known) {
    const near = closest(key, known);
    if (near !== undefined)
        return `unknown key "${key}"; did you mean "${near}"?`;
    return known.length ? `unknown key "${key}" (expected one of ${known.join(', ')})` : `unknown key "${key}"`;
}
/**
 * The known word a typo most likely meant: at most one edit away for a word under 5 letters, two otherwise.
 * Case is ignored and a swap of two neighbouring letters is one edit.
 */
export function closest(word, known) {
    let best;
    let bestDistance = (word.length < 5 ? 1 : 2) + 1;
    for (const candidate of known) {
        const d = distance(word.toLowerCase(), candidate.toLowerCase());
        if (d < bestDistance)
            [best, bestDistance] = [candidate, d];
    }
    return best;
}
/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps. */
function distance(a, b) {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i || j));
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
        }
    }
    return rows[a.length][b.length];
}
