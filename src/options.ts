import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { checkArtifactModes } from './artifacts.js';
import type { Engine, EngineFlags, ReporterSpec, SuiteOptions } from './suite-types.js';

export interface ParsedSuiteArgs { command: 'run' | 'mcp' | 'validate'; opts: SuiteOptions; flags: EngineFlags }
const number = (name: string, value: unknown, min = 0): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be ${min > 0 ? 'a positive' : 'a non-negative'} number, got "${value}"`);
  return n;
};
const asString = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const flag = (v: unknown): boolean => v === true;
const regex = (glob: string): RegExp => new RegExp(`^${glob.split(/(\*\*\/|\*\*|\*)/g).map((part) =>
  part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('')}$`);

export function expandFiles(positionals: string[], cwd = process.cwd()): string[] {
  return positionals.flatMap((input) => {
    if (!input.includes('*')) {
      if (!fs.existsSync(path.resolve(cwd, input)) || !fs.statSync(path.resolve(cwd, input)).isDirectory()) return [input];
      const files = fs.readdirSync(path.resolve(cwd, input), { recursive: true }) as string[];
      return files.filter((name) => /\.ya?ml$/i.test(name) && fs.statSync(path.resolve(cwd, input, name)).isFile())
        .map((name) => path.join(input, name)).sort();
    }
    const first = input.indexOf('*');
    const prefix = input.slice(0, first);
    const root = path.resolve(cwd, prefix.slice(0, prefix.lastIndexOf('/') + 1) || '.');
    if (!fs.existsSync(root)) return [];
    const matches = regex(input.replaceAll(path.sep, '/').replace(/^\.\//, ''));
    return (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((name) => /\.ya?ml$/i.test(name) && fs.statSync(path.join(root, name)).isFile())
      .map((name) => (path.isAbsolute(input) ? path.join(root, name) : path.relative(cwd, path.join(root, name))).replaceAll(path.sep, '/'))
      .filter((name) => matches.test(name)).sort();
  });
}

export function parseSuiteArgs(argv: string[], engine: Engine, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ParsedSuiteArgs {
  const args = argv.map((arg, i) => arg === '--bail' && !/^\d+$/.test(argv[i + 1] ?? '') ? '--bail=1' : arg);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    workers: { type: 'string' }, retries: { type: 'string' }, bail: { type: 'string' },
    'last-failed': { type: 'boolean' }, 'max-tokens': { type: 'string' },
    grep: { type: 'string' }, 'grep-invert': { type: 'string' }, tag: { type: 'string', multiple: true },
    list: { type: 'boolean' }, config: { type: 'string' }, reporter: { type: 'string', multiple: true },
    artifacts: { type: 'string' }, screenshot: { type: 'string' }, trace: { type: 'string' },
    'spec-timeout': { type: 'string' }, timing: { type: 'boolean' }, timeout: { type: 'string' },
    headless: { type: 'boolean' }, profile: { type: 'string' }, channel: { type: 'string' }, cdp: { type: 'string' },
    server: { type: 'string' },
  } });
  const config = loadConfig(cwd, values.config);
  const existingEnv: Record<string, string> = { profile: 'PLAINWRIGHT_PROFILE', cdp: 'PLAINWRIGHT_CDP', channel: 'PLAINWRIGHT_CHANNEL' };
  const choice = (key: string, cli: unknown, fallback: unknown): unknown =>
    cli ?? (existingEnv[key] ? env[existingEnv[key]] : undefined) ?? config[key] ?? fallback;
  const command = positionals[0] === 'mcp' ? 'mcp' : positionals[0] === 'validate' ? 'validate' : 'run';
  const inputs = command === 'run' ? positionals : positionals.slice(1);
  if (!inputs.length && command !== 'mcp') throw new Error('usage: plainwright [options] <spec.yaml> [more.yaml ...] | validate <files...> | mcp');
  if (command === 'mcp' && positionals.length !== 1) throw new Error('mcp takes no positional arguments');
  const workers = number('workers', choice('workers', values.workers, 1), 1);
  const profile = asString(choice('profile', values.profile, undefined))?.replace(/^~(?=\/|$)/, homedir());
  const cdp = asString(choice('cdp', values.cdp, undefined));
  if (workers > 1 && engine !== 'browser') throw new Error('--workers > 1 is not supported for desktop or mobile');
  if (workers > 1 && (profile || cdp)) throw new Error('--workers > 1 needs isolated browsers; --profile opens one persistent profile (cannot be opened twice) and --cdp attaches to one shared browser context. Run those with --workers 1.');
  const reporters: ReporterSpec[] = (values.reporter ?? config.reporters ?? [{ name: engine === 'browser' ? 'text' : 'jsonl' }])
    .map((v: string | ReporterSpec) => typeof v === 'string' ? { name: v.split(':', 1)[0], output: v.includes(':') ? v.slice(v.indexOf(':') + 1) : undefined } : v);
  checkArtifactModes(values.screenshot, values.trace, values.artifacts);
  const files = expandFiles(inputs, cwd);
  if (command !== 'mcp' && files.length === 0) throw new Error('no YAML files matched the given paths');
  const opts: SuiteOptions = {
    files, workers, retries: number('retries', choice('retries', values.retries, 0)),
    bail: number('bail', choice('bail', values.bail, 0)), lastFailed: flag(values['last-failed']),
    maxTokens: values['max-tokens'] === undefined ? undefined : number('max-tokens', values['max-tokens'], 1),
    grep: values.grep, grepInvert: values['grep-invert'], tags: values.tag ?? [], list: flag(values.list),
    reporters, timing: engine === 'browser' && flag(values.timing),
    artifacts: values.artifacts ? { dir: values.artifacts, screenshot: 'on-failure', trace: 'on-failure' } : undefined,
    specTimeout: values['spec-timeout'] === undefined ? undefined : number('spec-timeout', values['spec-timeout'], 1),
  };
  const flags: EngineFlags = { timeout: String(choice('timeout', values.timeout, '15000')),
    headless: flag(values.headless), profile, cdp, channel: asString(choice('channel', values.channel, undefined)),
    server: asString(values.server ?? env.PLAINWRIGHT_APPIUM_URL) };
  number('timeout', flags.timeout, 1);
  if (engine !== 'browser' && (values.headless || values.profile || values.channel || values.cdp || values.timing || values.trace))
    throw new Error('browser-only flag');
  if (engine !== 'mobile' && values.server) throw new Error('--server is mobile-only');
  return { command, opts, flags };
}
