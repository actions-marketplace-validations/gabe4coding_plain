import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'node:net';
import { artifactsObserver } from './artifacts.js';
import { loadSpec } from './spec.js';
import { runSpec, closeSharedBrowser } from './runner.js';
import { runSuite } from './suite.js';
import type { SuiteOptions } from './suite-types.js';

test('real Chromium writes failure traces and screenshots, discards passing traces, and attaches artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-artifacts-browser-'));
  t.after(async () => { await closeSharedBrowser(); fs.rmSync(root, { recursive: true, force: true }); });
  const pass = path.join(root, 'pass.yaml');
  const fail = path.join(root, 'fail.yaml');
  fs.writeFileSync(pass, 'name: passes\nurl: "data:text/html,<h1>Offline</h1>"\nsteps:\n  - goto: "data:text/html,<h1>Loaded</h1>"\n');
  fs.writeFileSync(fail, 'name: fails\nurl: "data:text/html,<h1>Offline</h1>"\nsteps:\n  - goto: "data:text/html,<h1>Loaded</h1>"\n  - goto: "http://[invalid"\n');
  const dir = path.join(root, 'results');
  const opts: SuiteOptions = { files: [pass, fail], workers: 2, retries: 0, bail: 0, lastFailed: false, tags: [],
    list: false, reporters: [], timing: false, artifacts: { dir, screenshot: 'on-failure', trace: 'on-failure' } };
  const report = await runSuite({ engine: 'browser', maxWorkers: Infinity, load: loadSpec,
    meta: (spec) => ({ name: spec.name, tags: [] }),
    run: (spec, observer, info) => runSpec(spec, { headed: false, timeout: 5000 }, observer, info),
    close: closeSharedBrowser,
  }, opts, { provider: () => 'typesafe', warmUp: () => {} });
  assert.equal(report.specs[0].status, 'pass', report.specs[0].attempts[0].error);
  assert.deepEqual(report.specs[0].attempts[0].artifacts, []);
  assert.equal(report.specs[1].status, 'error');
  const artifacts = report.specs[1].attempts[0].artifacts;
  assert.deepEqual(artifacts.map((a) => a.kind), ['screenshot', 'trace']);
  const trace = artifacts.find((a) => a.kind === 'trace')!;
  const png = artifacts.find((a) => a.kind === 'screenshot')!;
  assert.equal(png.step, 1);
  assert.equal(fs.readFileSync(trace.path).subarray(0, 2).toString(), 'PK');
  assert.equal(fs.readFileSync(png.path).subarray(1, 4).toString(), 'PNG');
  assert.ok(fs.statSync(trace.path).size > 1000);
  const entries = fs.readdirSync(dir, { recursive: true }) as string[];
  assert.equal(entries.filter((entry) => entry.endsWith('trace.zip')).length, 1);
  assert.equal(entries.filter((entry) => entry.endsWith('attempt-0')).length, 1);
});

test('runner marks actual CDP sessions so artifact capture leaves attached contexts untraced', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-artifacts-cdp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const file = path.join(root, 'spec.yaml');
  fs.writeFileSync(file, 'name: attached\nurl: "data:text/html,<h1>Offline</h1>"\nsteps:\n  - goto: "data:text/html,<h1>Loaded</h1>"\n');
  const observer = artifactsObserver({ files: [file], workers: 1, retries: 0, bail: 0, lastFailed: false,
    tags: [], list: false, reporters: [], timing: false,
    artifacts: { dir: path.join(root, 'results'), screenshot: 'always', trace: 'always' } }, 'browser')!;
  const info = { file, name: 'attached', tags: [], attempt: 0 };
  await observer.runStart!({ engine: 'browser', specs: [info] });
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  let attached = false;
  let artifacts: Awaited<ReturnType<NonNullable<typeof observer.sessionClose>>> = [];
  const result = await runSpec(loadSpec(file), { headed: false, timeout: 5000, cdp: `http://127.0.0.1:${port}` }, {
    async sessionOpen(event) {
      attached = event.target.cdp === true;
      await observer.sessionOpen!(event);
    },
    stepEnd: observer.stepEnd,
    async sessionClose(event) { artifacts = await observer.sessionClose!(event); return artifacts; },
  }, info);
  assert.equal(result.status, 'pass');
  assert.ok(attached);
  assert.ok(browser.isConnected());
  assert.deepEqual(artifacts.map((a) => a.kind), ['screenshot', 'screenshot']);
  assert.equal(messages.filter((message) => message.includes('tracing skipped for --cdp')).length, 1);
  assert.ok(!artifacts.some((a) => a.path.endsWith('trace.zip')));
});
