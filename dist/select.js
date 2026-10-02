import path from 'node:path';
import { readLastFailed } from './last-run.js';
function regex(pattern, flag) {
    if (pattern === undefined)
        return undefined;
    try {
        return new RegExp(pattern);
    }
    catch (error) {
        throw new Error(`${flag}: invalid regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : error}`);
    }
}
/** Last-run persistence belongs to scheduling; keep its selection rule independently testable. */
export function filterLastFailed(specs, failed) {
    if (failed === undefined)
        return specs;
    return specs.filter(({ file }) => failed.has(path.resolve(file)));
}
export function select(specs, opts) {
    const include = regex(opts.grep, '--grep');
    const exclude = regex(opts.grepInvert, '--grep-invert');
    const matches = (re, spec) => re.test(spec.name) || re.test(path.relative(process.cwd(), spec.file).replaceAll(path.sep, '/'));
    let selected = specs.filter((spec) => (!include || matches(include, spec)) && (!exclude || !matches(exclude, spec)))
        .filter((spec) => opts.tags.every((tag) => spec.tags.includes(tag)));
    // runSuite keeps load errors separately and always reports them, regardless of selection.
    if (opts.lastFailed) {
        const failed = readLastFailed(process.cwd());
        if (failed === undefined)
            console.error('plainwright: no previous run found; running all selected specs');
        else if (failed.size === 0)
            console.error('plainwright: no failures in the last run');
        selected = filterLastFailed(selected, failed);
    }
    return selected;
}
export function formatList(specs) {
    return specs.map(({ file, name, tags }) => `${file}  ${name}  [${tags.join(', ')}]`).join('\n');
}
export function listSelected(specs, opts) {
    if (!opts.list)
        return false;
    const output = formatList(specs);
    if (output)
        console.log(output);
    return true;
}
