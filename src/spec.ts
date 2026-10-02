import { StepKind } from './step-kind.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { expandIncludes, splitSource } from './include.js';
import { checkSpecFeatures } from './spec-features.js';

const nonEmptyString = z.string().min(1);
const optional = z.boolean().optional();
const origin = z.string().optional();
const target = nonEmptyString;
/** `tags: smoke` or `tags: [smoke, checkout]`; always a list after loading. */
export const TagsSchema = z.union([nonEmptyString.transform((tag) => [tag]), z.array(nonEmptyString)]).optional();

// Schemas are the source of truth for normalized data and its TypeScript types.
export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(StepKind.goto), url: nonEmptyString, optional, origin }),
  z.object({ kind: z.literal(StepKind.fill), target, value: z.string(), optional, origin }),
  z.object({ kind: z.literal(StepKind.click), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.hover), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.dblclick), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.rightclick), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.select), target, value: nonEmptyString, optional, origin }),
  z.object({ kind: z.literal(StepKind.check), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.uncheck), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.upload), target, files: z.array(nonEmptyString).min(1), optional, origin }),
  z.object({ kind: z.literal(StepKind.scroll), target, optional, origin }),
  z.object({ kind: z.literal(StepKind.wait), condition: nonEmptyString, within: nonEmptyString.optional(), optional, origin }),
  z.object({ kind: z.literal(StepKind.press), key: nonEmptyString, optional, origin }),
  z.object({ kind: z.literal(StepKind.drag), source: nonEmptyString, target, optional, origin }),
  // Negative y is the escape hatch for exit-intent triggers above the viewport.
  z.object({ kind: z.literal(StepKind.mouse), x: z.number(), y: z.number(), optional, origin }),
  z.object({ kind: z.literal(StepKind.expect), expectations: z.array(nonEmptyString).min(1), within: nonEmptyString.optional(), optional, origin }),
]);
export type Step = z.infer<typeof StepSchema>;

export const SpecSchema = z.object({
  name: nonEmptyString,
  url: nonEmptyString,
  dir: z.string(), // directory used to resolve upload paths
  dialogs: z.enum(['accept', 'dismiss']),
  // What the whole flow is for; picks see it and settle vague targets toward it (claims never see it).
  goal: nonEmptyString.optional(),
  auth: z.object({ user: nonEmptyString, pass: nonEmptyString }).optional(),
  geolocation: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: TagsSchema,
  timeout: z.number().int().positive().optional(),
  browser: z.object({
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
    device: nonEmptyString.optional(), locale: nonEmptyString.optional(), timezone: nonEmptyString.optional(),
    colorScheme: z.enum(['light', 'dark']).optional(), storageState: nonEmptyString.optional(), saveState: nonEmptyString.optional(),
  }).strict().optional(),
  // MCP-built specs have no env block; loadSpec supplies {} for file-based specs.
  env: z.record(z.string(), z.unknown()).optional(),
  hooks: nonEmptyString.optional(), // absolute path after loading
  steps: z.array(StepSchema), // an MCP session starts with no steps
});
export type Spec = z.infer<typeof SpecSchema>;

const FileSpecSchema = SpecSchema.omit({ dir: true, steps: true }).extend({
  dialogs: SpecSchema.shape.dialogs.nullish().transform((value) => value ?? 'accept'),
  steps: z.array(z.unknown()).min(1),
});

function parseData<T extends z.ZodType>(schema: T, raw: unknown, where: string): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.length ? ` "${issue.path.join('.')}"` : '';
    fail(`${where}:${field} ${issue.message}`);
  }
  return result.data;
}

function fail(msg: string): never {
  throw new Error(`invalid spec: ${msg}`);
}

// `$VAR` in an auth value means "read process.env.VAR" so a credential never sits in the spec file
// itself. A plain string (e.g. the-internet's public demo creds) passes through unchanged.
export interface LoadOptions { onMissingEnv?: (message: string) => void }
function resolveEnvRef(path: string, field: string, value: string, opts?: LoadOptions): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  const resolved = process.env[name];
  if (!resolved) {
    const message = `${path}: "${field}" references $${name} but that env var is not set`;
    if (opts?.onMissingEnv) { opts.onMissingEnv(message); return value; }
    fail(message);
  }
  return resolved;
}

// `env` mirrors auth/geolocation's `$VAR` convention but at arbitrary depth, since setup data
// (dataset lookups, feature flags, ...) is naturally nested (`env.user.name`, not `env["user.name"]`).
export function resolveEnvBlock(path: string, field: string, raw: Record<string, unknown>, opts?: LoadOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const childField = `${field}.${key}`;
    if (typeof value === 'string') out[key] = resolveEnvRef(path, childField, value, opts);
    else if (value !== null && typeof value === 'object' && !Array.isArray(value))
      out[key] = resolveEnvBlock(path, childField, value as Record<string, unknown>, opts);
    else out[key] = value;
  }
  return out;
}

const MappingSchema = z.record(z.string(), z.unknown());
const STEP_KINDS = StepSchema.options.map((schema) => schema.shape.kind.value);

// YAML/MCP use one action key; normalize that syntax before schema validation.
export function parseStep(path: string, i: number, raw: unknown): Step {
  const where = `${path}: step ${i}`;
  const obj = parseData(MappingSchema, raw, where);
  const keys = Object.keys(obj).filter((key) => key !== 'optional');
  if (keys.length !== 1) fail(`${where} must have exactly one key (plus optional "optional"), got [${keys.join(', ')}]`);
  const [kind] = keys;
  if (!STEP_KINDS.some((key) => key === kind))
    fail(`${where} has unknown key "${kind}" (expected one of ${STEP_KINDS.join(', ')})`);

  const val = obj[kind];
  const field = { goto: 'url', press: 'key', click: 'target', hover: 'target', dblclick: 'target',
    rightclick: 'target', check: 'target', uncheck: 'target', scroll: 'target' }[kind as string];
  let fields: Record<string, unknown>;
  if (field) fields = { [field]: val };
  else if (kind === StepKind.wait) {
    // wait: <claim>, or wait: {that, within} to poll one region instead of the whole page.
    const scoped = typeof val !== 'string';
    const w = scoped ? parseData(MappingSchema, val, `${where} "wait"`) : { that: val };
    fields = { condition: w.that, ...(w.within === undefined ? {} : { within: w.within }) };
  } else if (kind === StepKind.expect) {
    const scoped = typeof val !== 'string' && !Array.isArray(val);
    const expectation = scoped ? parseData(MappingSchema, val, `${where} "expect"`) : { that: val };
    fields = {
      expectations: typeof expectation.that === 'string' ? [expectation.that] : expectation.that,
      ...(expectation.within === undefined ? {} : { within: expectation.within }),
    };
  } else fields = parseData(MappingSchema, val, `${where} "${kind}"`);
  // Preserve the existing flag convention: only literal true enables optional execution.
  return parseData(StepSchema, { ...fields, kind, optional: obj.optional === true }, where);
}

/** `origin` is set only by include expansion, never by a spec author or an MCP step: it is taken off before the
 *  step is parsed (so `parseStep` keeps rejecting it) and put back on the parsed step for its label. */
export function withOrigin<S>(raw: unknown, parse: (raw: unknown) => S): S {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('origin' in raw)) return parse(raw);
  const { origin, ...rest } = raw as Record<string, unknown>;
  if (typeof origin !== 'string' || !origin) fail('origin must be a non-empty string');
  return { ...parse(rest), origin };
}

export function loadSpec(path: string, opts?: LoadOptions): Spec {
  const raw = parseData(FileSpecSchema, parse(readFileSync(path, 'utf8')), path);
  const spec: Spec = {
    ...raw,
    dir: dirname(path),
    auth: raw.auth && (resolveEnvBlock(path, 'auth', raw.auth, opts) as typeof raw.auth),
    env: resolveEnvBlock(path, 'env', raw.env ?? {}, opts),
    hooks: raw.hooks === undefined ? undefined : resolve(dirname(path), raw.hooks),
    steps: expandIncludes(raw.steps, path).map((expanded, i) => {
      // Errors name the file and index the step was written at, also for included steps.
      const { step, source } = splitSource(expanded);
      return withOrigin(step, (s) => parseStep(source?.file ?? path, source?.index ?? i, s));
    }),
  };
  checkSpecFeatures(spec, path);
  return spec;
}

// Deep-walks `value`, replacing every `${a.b.c}` in any string with the leaf it names under
// `vars.env`/`vars.hooks` (the spec's env block, and whatever the hooks module's setup returned).
// Pure and side-effect-free: returns a new value, never mutates `value`.
export function interpolate<T>(value: T, vars: { env: Record<string, unknown>; hooks: Record<string, unknown> }, where: string): T {
  if (typeof value === 'string') {
    if (!value.includes('${')) return value;
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [namespace, ...rest] = expr.split('.');
      let leaf: unknown = namespace === 'env' || namespace === 'hooks' ? vars[namespace] : undefined;
      for (const key of rest) {
        if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) { leaf = undefined; break; }
        leaf = (leaf as Record<string, unknown>)[key];
      }
      if (leaf === undefined || leaf === null || typeof leaf === 'object')
        fail(
          `${where}: \${${expr}} is not defined (use \${env.*} from the spec's env block or \${hooks.*} from what setup returned)`
        );
      return String(leaf);
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, where)) as unknown as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars, where)])) as T;
  return value;
}

/** Throws when a desktop/mobile step uses the browser-only `css=` escape hatch. */
export function rejectCss(step: object, what: string): void {
  const targets = ['target', 'source', 'within', 'condition'].flatMap((key) => key in step ? [String((step as Record<string, unknown>)[key])] : []);
  if (targets.some((v) => v.startsWith('css='))) throw new Error(`css= is browser-only; describe a ${what} accessibility element`);
}

/** Loads a desktop/mobile spec file: hooks resolved next to it, `$VAR` env leaves resolved, steps parsed. */
export function loadNativeSpec<R extends { hooks?: string; env: Record<string, unknown>; steps: unknown[] }, S>(file: string,
  schema: z.ZodType<R>, parseOne: (raw: unknown, where: string, index: number) => S, opts?: LoadOptions) {
  const raw = schema.parse(parse(readFileSync(file, 'utf8')));
  const dir = dirname(resolve(file));
  const env = resolveEnvBlock(file, 'env', raw.env, opts);
  checkSpecFeatures(raw as { timeout?: number }, file);
  return { ...raw, dir, hooks: raw.hooks ? resolve(dir, raw.hooks) : undefined,
    env, steps: expandIncludes(raw.steps, file).map((expanded, i) => {
      const { step, source } = splitSource(expanded);
      return withOrigin(step, (s) => parseOne(s, source?.file ?? file, source?.index ?? i));
    }) };
}
