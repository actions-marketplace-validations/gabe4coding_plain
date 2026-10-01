import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { EngineFlags, SuiteOptions } from './suite-types.js';

const text = z.string().min(1);
const positive = z.number().int().positive();
const mode = z.enum(['off', 'on-failure', 'always']);
const reporter = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const colon = value.indexOf(':');
  return colon < 0 ? { name: value } : { name: value.slice(0, colon), output: value.slice(colon + 1) };
}, z.object({ name: text, output: text.optional() }).strict());
const ConfigSchema = z.object({
  files: z.array(text).optional(),
  workers: positive.optional(), retries: z.number().int().nonnegative().optional(),
  bail: z.number().int().nonnegative().optional(), maxTokens: positive.optional(),
  grep: z.string().optional(), grepInvert: z.string().optional(), tags: z.array(text).optional(),
  reporters: z.array(reporter).min(1).optional(), timing: z.boolean().optional(),
  artifacts: z.object({ dir: text, screenshot: mode.default('on-failure'), trace: mode.default('on-failure') }).strict().optional(),
  specTimeout: positive.optional(), timeout: z.number().nonnegative().optional(),
  headless: z.boolean().optional(), profile: text.optional(), channel: text.optional(),
  cdp: text.optional(), server: text.optional(),
}).strict();

export function loadConfig(cwd: string, explicit?: string): Partial<SuiteOptions & EngineFlags> {
  const file = explicit !== undefined ? path.resolve(cwd, explicit) :
    ['plainwright.config.yaml', 'plainwright.config.yml'].map((name) => path.resolve(cwd, name)).find((candidate) => fs.existsSync(candidate));
  if (file === undefined) return {};
  if (!fs.existsSync(file)) {
    throw new Error(`--config: file not found: ${file}`);
  }
  let raw: unknown;
  try { raw = parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : error}`); }
  const result = ConfigSchema.safeParse(raw);
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
  if (config.profile !== undefined) config.profile = path.resolve(folder, config.profile);
  if (config.artifacts) config.artifacts.dir = path.resolve(folder, config.artifacts.dir);
  if (config.reporters) config.reporters = config.reporters.map((value) => ({ ...value,
    ...(value.output === undefined ? {} : { output: path.resolve(folder, value.output) }),
  }));
  // EngineFlags' index signature is intentionally broad; the shared parser handles numeric flags.
  return config as unknown as Partial<SuiteOptions & EngineFlags>;
}
