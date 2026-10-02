import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { StepKind } from './step-kind.js';
import { expandIncludes, splitSource } from './include.js';
const nonEmptyString = z.string().min(1);
const optional = z.boolean().optional();
const origin = z.string().optional();
/**
 * Where a step was written (absolute file, index in it): the pick cache key. Set by the loaders, never by YAML or
 * MCP. `templated`: the step holds a `${...}` placeholder, so its target may carry data (a user name, a secret) and
 * the cache stores a hash of the interpolated target instead of its text.
 */
const StepSourceSchema = z.object({ file: z.string(), index: z.number().int(), templated: z.boolean().optional() });
const at = StepSourceSchema.optional();
const target = nonEmptyString;
/** `tags: smoke` or `tags: [smoke, checkout]`; always a list after loading. */
export const TagsSchema = z.union([nonEmptyString.transform((tag) => [tag]), z.array(nonEmptyString)]).optional();
export const StepSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal(StepKind.goto), url: nonEmptyString, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.fill), target, value: z.string(), optional, origin, at }),
    z.object({ kind: z.literal(StepKind.click), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.hover), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.dblclick), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.rightclick), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.select), target, value: nonEmptyString, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.check), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.uncheck), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.upload), target, files: z.array(nonEmptyString).min(1), optional, origin, at }),
    z.object({ kind: z.literal(StepKind.scroll), target, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.wait), condition: nonEmptyString, within: nonEmptyString.optional(), optional, origin, at }),
    z.object({ kind: z.literal(StepKind.press), key: nonEmptyString, optional, origin, at }),
    z.object({ kind: z.literal(StepKind.drag), source: nonEmptyString, target, optional, origin, at }),
    // A negative y reaches above the viewport, for exit-intent triggers.
    z.object({ kind: z.literal(StepKind.mouse), x: z.number(), y: z.number(), optional, origin, at }),
    z.object({
        kind: z.literal(StepKind.expect), expectations: z.array(nonEmptyString).min(1), within: nonEmptyString.optional(),
        optional, origin, at,
    }),
]);
export const SpecSchema = z.object({
    name: nonEmptyString,
    url: nonEmptyString,
    /** Upload paths resolve against it. */
    dir: z.string(),
    dialogs: z.enum(['accept', 'dismiss']),
    /** What the whole flow is for: picks see it, claims never do. */
    goal: nonEmptyString.optional(),
    auth: z.object({ user: nonEmptyString, pass: nonEmptyString }).optional(),
    geolocation: z.object({ lat: z.number(), lon: z.number() }).optional(),
    tags: TagsSchema,
    timeout: z.number().int().positive().optional(),
    browser: z.object({
        viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
        device: nonEmptyString.optional(),
        locale: nonEmptyString.optional(),
        timezone: nonEmptyString.optional(),
        colorScheme: z.enum(['light', 'dark']).optional(),
        storageState: nonEmptyString.optional(),
        saveState: nonEmptyString.optional(),
    }).strict().optional(),
    /** Absent in an MCP session; `{}` for a spec file without one. */
    env: z.record(z.string(), z.unknown()).optional(),
    /** An absolute path after loading. */
    hooks: nonEmptyString.optional(),
    steps: z.array(StepSchema),
});
const FileSpecSchema = SpecSchema.omit({ dir: true, steps: true }).extend({
    dialogs: SpecSchema.shape.dialogs.nullish().transform((value) => value ?? 'accept'),
    steps: z.array(z.unknown()).min(1),
});
export function loadSpec(path, opts) {
    const raw = parseData(FileSpecSchema, parse(readFileSync(path, 'utf8')), path);
    const spec = {
        ...raw,
        dir: dirname(path),
        auth: raw.auth && resolveEnvBlock(path, 'auth', raw.auth, opts),
        env: resolveEnvBlock(path, 'env', raw.env ?? {}, opts),
        hooks: raw.hooks === undefined ? undefined : resolve(dirname(path), raw.hooks),
        steps: loadSteps(raw.steps, path, (step, file, index) => parseStep(file, index, step)),
    };
    checkSpecTimeout(spec, path);
    return spec;
}
/** Loads a desktop or mobile spec file: hooks resolved next to it, `$VAR` env leaves resolved, steps parsed. */
export function loadNativeSpec(file, schema, parseOne, opts) {
    const raw = schema.parse(parse(readFileSync(file, 'utf8')));
    const dir = dirname(resolve(file));
    const env = resolveEnvBlock(file, 'env', raw.env, opts);
    checkSpecTimeout(raw, file);
    return {
        ...raw,
        dir,
        hooks: raw.hooks ? resolve(dir, raw.hooks) : undefined,
        env,
        steps: loadSteps(raw.steps, file, parseOne),
    };
}
/** Expands includes and parses each step. Errors name the file and index where the step was written. */
function loadSteps(rawSteps, file, parseOne) {
    return expandIncludes(rawSteps, file).map((expanded, i) => {
        const { step, source } = splitSource(expanded);
        const parsed = withOrigin(step, (raw) => parseOne(raw, source?.file ?? file, source?.index ?? i));
        return withSource(parsed, step, file, source, i);
    });
}
const MappingSchema = z.record(z.string(), z.unknown());
const STEP_KINDS = StepSchema.options.map((schema) => schema.shape.kind.value);
/** Step kinds written as `kind: <value>`, and the field the value fills. */
const SINGLE_VALUE_FIELD = {
    goto: 'url', press: 'key', click: 'target', hover: 'target', dblclick: 'target',
    rightclick: 'target', check: 'target', uncheck: 'target', scroll: 'target',
};
/** Parses one step as YAML and MCP write it: one action key, plus an optional `optional`. */
export function parseStep(path, i, raw) {
    const where = `${path}: step ${i}`;
    const mapping = parseData(MappingSchema, raw, where);
    const keys = Object.keys(mapping).filter((key) => key !== 'optional');
    if (keys.length !== 1)
        fail(`${where} must have exactly one key (plus optional "optional"), got [${keys.join(', ')}]`);
    const [kind] = keys;
    if (!STEP_KINDS.some((key) => key === kind))
        fail(`${where} has unknown key "${kind}" (expected one of ${STEP_KINDS.join(', ')})`);
    const fields = stepFields(kind, mapping[kind], where);
    for (const reserved of ['at', 'origin']) {
        if (reserved in fields)
            fail(`${where} "${kind}": "${reserved}" is reserved for the loader`);
    }
    return parseData(StepSchema, { ...fields, kind, optional: mapping.optional === true }, where);
}
function stepFields(kind, value, where) {
    const field = SINGLE_VALUE_FIELD[kind];
    if (field)
        return { [field]: value };
    if (kind === StepKind.wait) {
        // `wait: <claim>`, or `wait: {that, within}` to poll one region.
        const wait = typeof value === 'string' ? { that: value } : parseData(MappingSchema, value, `${where} "wait"`);
        return { condition: wait.that, ...(wait.within === undefined ? {} : { within: wait.within }) };
    }
    if (kind === StepKind.expect) {
        const scoped = typeof value !== 'string' && !Array.isArray(value);
        const expect = scoped ? parseData(MappingSchema, value, `${where} "expect"`) : { that: value };
        return {
            expectations: typeof expect.that === 'string' ? [expect.that] : expect.that,
            ...(expect.within === undefined ? {} : { within: expect.within }),
        };
    }
    return parseData(MappingSchema, value, `${where} "${kind}"`);
}
/**
 * Only include expansion sets `origin`. It is taken off before the step is parsed, so `parseStep` keeps
 * rejecting it, and put back on the parsed step for its label.
 */
export function withOrigin(raw, parse) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('origin' in raw))
        return parse(raw);
    const { origin, ...rest } = raw;
    if (typeof origin !== 'string' || !origin)
        fail('origin must be a non-empty string');
    return { ...parse(rest), origin };
}
/**
 * Puts the step's source (absolute file, index in it) on the parsed step: the pick cache key. `templated` when
 * the step as written holds a placeholder: its key then hashes the interpolated target.
 */
function withSource(parsed, raw, root, source, i) {
    const file = source?.file === undefined ? resolve(root) : resolve(dirname(resolve(root)), source.file);
    const templated = JSON.stringify(raw).includes('${');
    return { ...parsed, at: { file, index: source?.index ?? i, ...(templated ? { templated } : {}) } };
}
/**
 * `$VAR` in an env or auth value reads process.env.VAR, so no credential sits in the spec file. Any depth: setup
 * data is often nested (`env.user.name`). A plain string passes through unchanged.
 */
function resolveEnvBlock(path, field, raw, opts) {
    const resolved = {};
    for (const [key, value] of Object.entries(raw)) {
        const childField = `${field}.${key}`;
        if (typeof value === 'string')
            resolved[key] = resolveEnvRef(path, childField, value, opts);
        else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            resolved[key] = resolveEnvBlock(path, childField, value, opts);
        }
        else
            resolved[key] = value;
    }
    return resolved;
}
function resolveEnvRef(path, field, value, opts) {
    if (!value.startsWith('$'))
        return value;
    const name = value.slice(1);
    const resolved = process.env[name];
    if (resolved)
        return resolved;
    const message = `${path}: "${field}" references $${name} but that env var is not set`;
    if (!opts?.onMissingEnv)
        fail(message);
    opts.onMissingEnv(message);
    return value;
}
export function checkSpecTimeout(spec, file) {
    if (spec.timeout !== undefined && (!Number.isSafeInteger(spec.timeout) || spec.timeout <= 0)) {
        throw new Error(`invalid spec: ${file}: timeout must be a positive safe integer`);
    }
}
/** Throws when a desktop or mobile step uses the browser-only `css=` escape hatch. */
export function rejectCss(step, what) {
    const fields = step;
    const targets = ['target', 'source', 'within', 'condition'].flatMap((key) => key in fields ? [String(fields[key])] : []);
    if (targets.some((value) => value.startsWith('css=')))
        throw new Error(`css= is browser-only; describe a ${what} accessibility element`);
}
function parseData(schema, raw, where) {
    const result = schema.safeParse(raw);
    if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue.path.length ? ` "${issue.path.join('.')}"` : '';
        fail(`${where}:${field} ${issue.message}`);
    }
    return result.data;
}
function fail(message) {
    throw new Error(`invalid spec: ${message}`);
}
