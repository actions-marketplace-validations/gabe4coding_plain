import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { validate } from './validate.js';
import { loadComputerSpec } from '../computer/spec.js';
import { loadSpec } from '../core/spec.js';
import { runSuite } from './run-suite.js';
import type { SuiteEngine, SuiteOptions } from './types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-select-review-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string): string => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };

test('a ~ profile in the config stays as written for options.ts to expand', () => {
  write('plain.config.yaml', 'profile: ~/.chrome-profile\n');
  assert.equal(loadConfig(dir).profile, '~/.chrome-profile');
  fs.unlinkSync(path.join(dir, 'plain.config.yaml'));
});

test('validate checks every interpolated field and rejects unknown namespaces', () => {
  const desktop: SuiteEngine<ReturnType<typeof loadComputerSpec>> = { engine: 'desktop', maxWorkers: 1, load: loadComputerSpec,
    meta: (spec) => ({ name: spec.name, tags: [] }), run: async () => { throw new Error('not run'); } };
  const browser: SuiteEngine<ReturnType<typeof loadSpec>> = { engine: 'browser', maxWorkers: 1, load: loadSpec,
    meta: (spec) => ({ name: spec.name, tags: [] }), run: async () => { throw new Error('not run'); } };
  const app = write('app.yaml', "name: x\napp: '${env.nope}'\nsteps:\n  - click: Save\n");
  assert.match(validate(desktop, [app])[0].error ?? '', /env\.nope.*not defined/);
  const typo = write('typo.yaml', "name: x\nurl: https://example.com\nenv: {base: /}\nsteps:\n  - goto: '${envv.base}'\n");
  assert.match(validate(browser, [typo])[0].error ?? '', /envv\.base.*unknown namespace/);
  const hooks = write('hooks.yaml', "name: x\nurl: https://example.com\nsteps:\n  - goto: '${hooks.url}'\n");
  assert.equal(validate(browser, [hooks])[0].error, undefined);
});

test('--list reports load errors and fails, without running or asking for a key', async () => {
  const opts: SuiteOptions = { files: ['ok', 'bad'], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: true,
    reporters: [{ name: 'text' }], timing: false };
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 1, meta: (name) => ({ name, tags: [] }),
    load: (file) => { if (file === 'bad') throw new Error('invalid spec'); return file; },
    run: async () => { throw new Error('not run'); } };
  const [log, error] = [console.log, console.error];
  const out: string[] = []; const err: string[] = [];
  console.log = (line) => { out.push(line); }; console.error = (line) => { err.push(line); };
  try {
    const report = await runSuite(engine, opts, { provider: () => { throw new Error('key required'); }, warmUp: () => {} });
    assert.equal(report.status, 'fail');
    assert.deepEqual(report.specs.map((spec) => spec.file), ['bad']);
  } finally { console.log = log; console.error = error; }
  assert.deepEqual(out, ['ok  ok  []']);
  assert.match(err.join('\n'), /✘ bad: .*invalid spec/);
});
