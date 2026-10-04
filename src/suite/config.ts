import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { errorMessage } from '../core/results.js';
import { TagsSchema } from '../core/spec.js';
import { PICKS_MODES } from '../core/pick-cache.js';
import { CAPTURE_MODES, type EngineFlags, type SuiteOptions } from './types.js';

const text = z.string().min(1);
const positive = z.number().int().positive();
const mode = z.enum(CAPTURE_MODES);
const reporter = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const colon = value.indexOf(':');
  return colon < 0 ? { name: value } : { name: value.slice(0, colon), output: value.slice(colon + 1) };
}, z.object({ name: text, output: text.optional() }).strict());
const ConfigSchema = z.object({
  files: z.array(text).optional(),
  workers: positive.optional(),
  retries: z.number().int().nonnegative().optional(),
  bail: z.number().int().nonnegative().optional(),
  maxTokens: positive.optional(),
  grep: z.string().optional(),
  grepInvert: z.string().optional(),
  tags: TagsSchema,
  reporters: z.array(reporter).min(1).optional(),
  timing: z.boolean().optional(),
  /** Each key may come alone (the modes here, --artifacts on the CLI); options.ts applies the defaults. */
  artifacts: z.object({ dir: text.optional(), screenshot: mode.optional(), trace: mode.optional() }).strict().optional(),
  specTimeout: positive.optional(),
  timeout: z.number().nonnegative().optional(),
  headless: z.boolean().optional(),
  profile: text.optional(),
  channel: text.optional(),
  cdp: text.optional(),
  server: text.optional(),
  picks: z.enum(PICKS_MODES).optional(),
}).strict();

const CONFIG_FILES = ['plain.config.yaml', 'plain.config.yml'];

/** `--config <file>`, else the cwd's plain.config.yaml/.yml. Paths in it resolve against its folder. */
export function loadConfig(cwd: string, explicit?: string): Partial<SuiteOptions & EngineFlags> {
  const file = explicit !== undefined
    ? path.resolve(cwd, explicit)
    : CONFIG_FILES.map((name) => path.resolve(cwd, name)).find((candidate) => fs.existsSync(candidate));
  if (file === undefined) return {};
  if (!fs.existsSync(file)) throw new Error(`--config: file not found: ${file}`);
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`);
  }
  const result = ConfigSchema.safeParse(raw ?? {}); // an empty or comment-only file is an empty config
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const key = issue.path.join('.');
      return issue.code === 'unrecognized_keys'
        ? issue.keys.map((name) => `${key ? `${key}.` : ''}${name}: unknown key`).join('; ')
        : `${key || 'config'}: ${issue.message}`;
    });
    throw new Error(`${file}: ${errors.join('; ')}`);
  }
  const config = result.data;
  const folder = path.dirname(file);
  if (config.files) config.files = config.files.map((input) => path.resolve(folder, input));
  // `~/...` stays as written: options.ts expands it to the home folder.
  if (config.profile !== undefined && !/^~(?=[\/\\]|$)/.test(config.profile)) config.profile = path.resolve(folder, config.profile);
  if (config.artifacts?.dir !== undefined) config.artifacts.dir = path.resolve(folder, config.artifacts.dir);
  if (config.reporters) {
    config.reporters = config.reporters.map((value) =>
      value.output === undefined ? value : { ...value, output: path.resolve(folder, value.output) });
  }
  // EngineFlags' index signature is broad on purpose: the shared parser checks numeric flags.
  return config as unknown as Partial<SuiteOptions & EngineFlags>;
}
