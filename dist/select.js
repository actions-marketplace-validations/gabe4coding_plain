export function select(specs, opts) {
    if (opts.grep !== undefined)
        throw new Error('--grep: not implemented yet');
    if (opts.grepInvert !== undefined)
        throw new Error('--grep-invert: not implemented yet');
    if (opts.tags.length)
        throw new Error('--tag: not implemented yet');
    return specs;
}
export function listSelected(specs, opts) {
    if (opts.list)
        throw new Error('--list: not implemented yet');
    return false;
}
