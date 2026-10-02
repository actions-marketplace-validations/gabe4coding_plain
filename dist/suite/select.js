import path from 'node:path';
import { errorMessage } from '../core/results.js';
import { readLastFailed } from './last-run.js';
function compileFlagRegex(pattern, flag) {
    if (pattern === undefined)
        return undefined;
    try {
        return new RegExp(pattern);
    }
    catch (error) {
        throw new Error(`${flag}: invalid regex ${JSON.stringify(pattern)}: ${errorMessage(error)}`);
    }
}
/** Keeps only the specs that did not pass in the last run; `undefined` (no usable last run) keeps them all. */
export function filterLastFailed(specs, failed) {
    if (failed === undefined)
        return specs;
    return specs.filter(({ file }) => failed.has(path.resolve(file)));
}
export function select(specs, opts) {
    const include = compileFlagRegex(opts.grep, '--grep');
    const exclude = compileFlagRegex(opts.grepInvert, '--grep-invert');
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
