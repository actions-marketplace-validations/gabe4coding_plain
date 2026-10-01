#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Xa11yAdapter } from './computer-adapter.js';
import { ComputerSession, runComputerSpec } from './computer.js';
import { loadComputerSpec, parseComputerStep } from './computer-spec.js';
import { nativeCli } from './native.js';
import { loadEnvFiles } from './jev.js';

const [mode] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (mode === 'plan' || mode === 'do') await planOrDo(mode);
else await nativeCli('plainwright-computer', 'plan|do "<sentence>" | ', 'desktop', {
  serve: async (timeout) => (await import('./computer-mcp.js')).serveComputerMcp(timeout), // MCP SDK only when serving
  load: loadComputerSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
  run: (spec, timeout, _values, observer, info, specTimeout) => runComputerSpec(spec,
    new ComputerSession(new Xa11yAdapter(timeout), timeout), observer, info, specTimeout),
});

// `plan "<sentence>"` prints the plan Jev makes of a sentence (src/planner.ts); `do` also runs it as a
// desktop spec in the app it names (or --app). Everything is checked before the first action.
async function planOrDo(mode: 'plan' | 'do') {
  loadEnvFiles();
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      timeout: { type: 'string', default: '15000' }, app: { type: 'string' }, yes: { type: 'boolean', default: false } } });
    const text = positionals.slice(1).join(' ').trim();
    if (!text) throw new Error(`usage: plainwright-computer ${mode} [--app NAME] [--yes] [--timeout 15000] "<sentence>"`);
    const { plan } = await import('./planner.js');
    const { items, tokens } = await plan(text);
    if (mode === 'plan') { console.log(JSON.stringify({ items, tokens })); return; }

    const unknown = items.filter((i) => i.kind === 'unknown');
    if (unknown.length) throw new Error(`not understood: ${unknown.map((i) => `"${i.text}" (${i.reason})`).join('; ')}`);
    const risky = items.filter((i) => i.kind === 'step' && i.risky);
    if (risky.length && !values.yes) throw new Error(`hard to undo, rerun with --yes to allow: ${risky.map((i) => JSON.stringify(i.kind === 'step' && i.step)).join('; ')}`);
    const until = items.findIndex((i) => i.kind === 'stop');
    const run = until < 0 ? items : items.slice(0, until);
    const opens = run.filter((i) => i.kind === 'open');
    if (opens.length > 1 || (opens.length && run[0].kind !== 'open')) throw new Error('one app per run: name it first ("open Notes, then ...") or pass --app');
    const app = opens[0]?.kind === 'open' ? opens[0].app : values.app;
    if (!app) throw new Error('which app? Start with "open <app>" or pass --app');
    const steps = run.flatMap((i, n) => i.kind === 'step' ? [parseComputerStep(i.step, 'do', n)] : i.kind === 'ask' ? [parseComputerStep({ expect: i.claim }, 'do', n)] : []);
    if (!steps.length) throw new Error('nothing to do after opening the app');
    const timeout = Number(values.timeout);
    const result = await runComputerSpec({ name: text, app, dir: process.cwd(), env: {}, steps }, new ComputerSession(new Xa11yAdapter(timeout), timeout));
    console.log(JSON.stringify({ ...result, planTokens: tokens }));
    process.exitCode = result.status === 'pass' ? 0 : 1;
  } catch (error) { console.error(`plainwright-computer ${mode}: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; }
}
