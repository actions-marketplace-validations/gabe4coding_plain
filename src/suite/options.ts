import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { PICKS_MODES, type PicksMode } from '../core/pick-cache.js';
import type { Engine, EngineFlags, ReporterSpec, SuiteOptions } from './types.js';

export interface ParsedSuiteArgs { command: 'run' | 'mcp' | 'validate'; opts: SuiteOptions; flags: EngineFlags }
/** No spec paths given: each CLI prints its own usage line. */
export class UsageError extends Error { constructor() { super('usage'); } }
type Config = Partial<SuiteOptions & EngineFlags> & { artifacts?: Partial<NonNullable<SuiteOptions['artifacts']>> };
const MODES = ['off', 'on-failure', 'always'] as const;
const mode = (name: string, value: unknown): 'off' | 'on-failure' | 'always' => {
  if (!MODES.includes(value as never)) throw new Error(`--${name} must be one of ${MODES.join(', ')}, got "${value}"`);
  return value as 'off' | 'on-failure' | 'always';
};
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

export function parseSuiteArgs(argv: string[], engine: Engine, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
  readConfig: typeof loadConfig = loadConfig): ParsedSuiteArgs {
  const args = argv.map((arg, i) => arg === '--bail' && !/^\d+$/.test(argv[i + 1] ?? '') ? '--bail=1' : arg);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    workers: { type: 'string' }, retries: { type: 'string' }, bail: { type: 'string' },
    'last-failed': { type: 'boolean' }, 'max-tokens': { type: 'string' },
    grep: { type: 'string' }, 'grep-invert': { type: 'string' }, tag: { type: 'string', multiple: true },
    list: { type: 'boolean' }, config: { type: 'string' }, reporter: { type: 'string', multiple: true },
    artifacts: { type: 'string' }, screenshot: { type: 'string' }, trace: { type: 'string' },
    'spec-timeout': { type: 'string' }, timing: { type: 'boolean' }, timeout: { type: 'string' },
    headless: { type: 'boolean' }, profile: { type: 'string' }, channel: { type: 'string' }, cdp: { type: 'string' },
    server: { type: 'string' }, picks: { type: 'string' },
  } });
  const command = positionals[0] === 'mcp' ? 'mcp' : positionals[0] === 'validate' ? 'validate' : 'run';
  // MCP keeps today's behavior: no config file, no suite options.
  const config: Config = command === 'mcp' ? {} : readConfig(cwd, values.config) as Config;
  const existingEnv: Record<string, string> = { profile: 'PLAINWRIGHT_PROFILE', cdp: 'PLAINWRIGHT_CDP', channel: 'PLAINWRIGHT_CHANNEL', server: 'PLAINWRIGHT_APPIUM_URL' };
  // CLI > existing PLAINWRIGHT_* env > config file > default, for every key.
  const choice = (key: string, cli: unknown, fallback: unknown): unknown =>
    cli ?? (existingEnv[key] ? env[existingEnv[key]] : undefined) ?? (config as Record<string, unknown>)[key] ?? fallback;
  const inputs = command === 'run' ? positionals : positionals.slice(1);
  if (command === 'mcp' && positionals.length !== 1) throw new Error('mcp takes no positional arguments');
  const paths = inputs.length ? inputs : command === 'run' ? config.files ?? [] : [];
  if (!paths.length && command !== 'mcp') throw new UsageError();
  const workers = number('workers', choice('workers', values.workers, 1), 1);
  const profile = asString(choice('profile', values.profile, undefined))?.replace(/^~(?=\/|$)/, homedir());
  const cdp = asString(choice('cdp', values.cdp, undefined));
  if (workers > 1 && engine !== 'browser') throw new Error('--workers > 1 is not supported for desktop or mobile');
  if (workers > 1 && (profile || cdp)) throw new Error('plainwright: --workers > 1 needs isolated browsers; --profile opens one persistent profile (cannot be opened twice) and --cdp attaches to one shared browser context. Run those with --workers 1.');
  const reporters: ReporterSpec[] = (values.reporter ?? config.reporters ?? [{ name: engine === 'browser' ? 'text' : 'jsonl' }])
    .map((v: string | ReporterSpec) => typeof v === 'string' ? { name: v.split(':', 1)[0], output: v.includes(':') ? v.slice(v.indexOf(':') + 1) : undefined } : v);
  // Capture is off until a dir is set; the modes alone change nothing.
  const dir = asString(values.artifacts ?? config.artifacts?.dir);
  const screenshot = mode('screenshot', values.screenshot ?? config.artifacts?.screenshot ?? 'on-failure');
  // Desktop/mobile have no trace: default off there, so --artifacts alone works; an explicit mode still errors (lane B).
  const trace = mode('trace', values.trace ?? config.artifacts?.trace ?? (engine === 'browser' ? 'on-failure' : 'off'));
  if (!dir && (values.screenshot !== undefined || values.trace !== undefined))
    console.error('plainwright: --screenshot and --trace have no effect without --artifacts <dir>');
  const files = expandFiles(paths, cwd);
  if (command !== 'mcp' && files.length === 0) throw new Error('no YAML files matched the given paths');
  const picks = choice('picks', values.picks, 'on');
  if (!PICKS_MODES.includes(picks as PicksMode)) throw new Error(`--picks must be one of ${PICKS_MODES.join(', ')}, got "${picks}"`);
  const optional = (name: string, value: unknown): number | undefined => value === undefined ? undefined : number(name, value, 1);
  const opts: SuiteOptions = {
    files, workers, retries: number('retries', choice('retries', values.retries, 0)),
    bail: number('bail', choice('bail', values.bail, 0)), lastFailed: flag(values['last-failed']),
    maxTokens: optional('max-tokens', choice('maxTokens', values['max-tokens'], undefined)),
    grep: asString(choice('grep', values.grep, undefined)), grepInvert: asString(choice('grepInvert', values['grep-invert'], undefined)),
    tags: values.tag ?? config.tags ?? [], list: flag(values.list),
    reporters, timing: engine === 'browser' && flag(choice('timing', values.timing, false)),
    artifacts: dir ? { dir, screenshot, trace } : undefined,
    specTimeout: optional('spec-timeout', choice('specTimeout', values['spec-timeout'], undefined)),
    picks: picks as PicksMode,
  };
  const timeout = String(choice('timeout', values.timeout, '15000'));
  // Browser: 0 is Playwright's "no timeout", as before; desktop/mobile always required a positive value.
  const ms = Number(timeout);
  if (!Number.isFinite(ms) || (engine === 'browser' ? ms < 0 : ms <= 0))
    throw new Error(engine === 'browser' ? `--timeout must be a number of milliseconds, got "${timeout}"` : '--timeout must be a positive number of milliseconds');
  const flags: EngineFlags = { timeout, headless: flag(choice('headless', values.headless, false)), profile, cdp,
    channel: asString(choice('channel', values.channel, undefined)), server: asString(choice('server', values.server, undefined)) };
  const browserOnly = (['headless', 'profile', 'channel', 'cdp', 'timing'] as const).find((name) => values[name] !== undefined);
  if (engine !== 'browser' && browserOnly) throw new Error(`--${browserOnly} is browser-only`);
  if (engine !== 'mobile' && values.server) throw new Error('--server is mobile-only');
  return { command, opts, flags };
}
