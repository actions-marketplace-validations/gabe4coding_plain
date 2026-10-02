import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
/** Where an expanded step was written: its file (relative to the root spec's folder; undefined for the root
 *  spec itself) and its index in that file. A symbol key, so the step's own keys stay as written. */
const SOURCE = Symbol('plainwright.include.source');
/** Takes the source off an expanded step, for the loader's error messages (file and index as the author wrote them). */
export function splitSource(step) {
    if (step === null || typeof step !== 'object' || !(SOURCE in step))
        return { step };
    const { [SOURCE]: source, ...rest } = step;
    return { step: rest, source: source };
}
/** Expand raw YAML before validation; only this loader may produce step origins. */
export function expandIncludes(rawSteps, file) {
    const root = resolve(file);
    const folder = dirname(root);
    const display = (file) => relative(folder, file).split(sep).join('/');
    // Real paths also catch cycles through symlinks. The root may be virtual in unit tests.
    const identity = (file) => { try {
        return realpathSync(file);
    }
    catch {
        return file;
    } };
    function expand(steps, source, chain) {
        return steps.flatMap((step, index) => {
            if (step === null || typeof step !== 'object' || Array.isArray(step))
                return [step];
            const mapping = step;
            if ('origin' in mapping)
                throw new Error(`invalid spec: ${display(source)}: origin: reserved for included steps`);
            const at = { file: source === root ? undefined : display(source), index };
            if (!('include' in mapping))
                return [source === root ? { ...mapping, [SOURCE]: at } : { ...mapping, origin: display(source), [SOURCE]: at }];
            if (mapping.optional === true)
                throw new Error(`invalid spec: ${display(source)}: optional: true on include is not supported in v1`);
            for (const key of Object.keys(mapping)) {
                if (key !== 'include' && key !== 'optional')
                    throw new Error(`invalid spec: ${display(source)}: include has unexpected key "${key}"`);
            }
            if (typeof mapping.include !== 'string' || !mapping.include.trim())
                throw new Error(`invalid spec: ${display(source)}: include must be a non-empty path`);
            const included = resolve(dirname(source), mapping.include);
            if (chain.some((file) => identity(file) === identity(included)))
                throw new Error(`invalid spec: include cycle: ${[...chain, included].map(display).join(' → ')}`);
            let raw;
            try {
                raw = parse(readFileSync(included, 'utf8'));
            }
            catch (error) {
                throw new Error(`invalid spec: ${display(included)}: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
                throw new Error(`invalid spec: ${display(included)}: included file must contain only steps:`);
            const flow = raw;
            for (const key of Object.keys(flow)) {
                if (key !== 'steps')
                    throw new Error(`invalid spec: ${display(included)}: included file has unexpected key "${key}" (only steps: is allowed)`);
            }
            if (!Array.isArray(flow.steps))
                throw new Error(`invalid spec: ${display(included)}: steps must be an array`);
            return expand(flow.steps, included, [...chain, included]);
        });
    }
    return expand(rawSteps, root, [root]);
}
