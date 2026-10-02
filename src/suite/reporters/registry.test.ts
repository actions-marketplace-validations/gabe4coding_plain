import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReporters } from './index.js';
import { jsonReporter } from './json.js';
import { runSuite } from '../run-suite.js';
import { parseSuiteArgs } from '../options.js';
import type { SuiteEngine } from '../types.js';
import { attempt, capture, options, run, spec } from './fixtures.test.js';

test('registry validates unknown names, mandatory file paths, and unsupported stdout file outputs', () => {
  for (const name of ['junit', 'json']) {
    for (const output of [undefined, '', '   ']) {
      assert.throws(() => createReporters({ ...options, reporters: [{ name, output }] }), /output file is required/);
    }
  }
  for (const name of ['text', 'jsonl']) {
    assert.throws(() => createReporters({ ...options, reporters: [{ name, output: 'out.txt' }] }), /output files are not supported/);
  }
  assert.throws(() => createReporters({ ...options, reporters: [{ name: 'nope' }] }), /unknown reporter/);
});

test('registry rejects two stdout reporters, including duplicate names, before running an engine', async () => {
  for (const names of [['text', 'jsonl'], ['text', 'text'], ['jsonl', 'jsonl']]) {
    let ran = false, checkedKey = false;
    const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 1, load: (file) => file,
      meta: (name) => ({ name, tags: [] }), run: async () => { ran = true; return attempt('pass'); } };
    await assert.rejects(runSuite(engine, { ...options, reporters: names.map((name) => ({ name })) },
      { provider: () => { checkedKey = true; return 'typesafe'; }, warmUp: () => {} }), /at most one stdout reporter/);
    assert.equal(ran, false);
    assert.equal(checkedKey, false);
  }
});

test('JSON report preserves the full RunReport with schemaVersion 1 and creates parent directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plainwright-json-'));
  try {
    const file = path.join(dir, 'nested', 'run.json');
    const report = { ...run([spec('pass', { flaky: true, attempts: [attempt('fail'), attempt('pass', { attempt: 1,
      artifacts: [{ kind: 'trace' as const, path: '/tmp/trace.zip' }] })] }),
      spec('skipped', { attempts: [], skipReason: 'max-tokens' }), spec('error', { attempts: [], loadError: 'bad YAML' })]),
      stopped: 'max-tokens' as const };
    await jsonReporter(file).runEnd!({ report });
    const contents = await fs.readFile(file, 'utf8');
    assert.ok(contents.startsWith('{\n  "schemaVersion": 1,'));
    assert.deepEqual(JSON.parse(contents), { schemaVersion: 1, ...report });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('repeatable CLI reporters create exactly one observer each, in order, and write together', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plainwright-reporters-'));
  try {
    const xml = path.join(dir, 'out.xml'), json = path.join(dir, 'out.json');
    const parsed = parseSuiteArgs(['--reporter', `junit:${xml}`, '--reporter', 'text', '--reporter', `json:${json}`, 'case.yaml'], 'browser');
    const observers = createReporters(parsed.opts);
    assert.equal(observers.length, 3);
    assert.equal(observers[0].specEnd, undefined);
    assert.equal(typeof observers[1].specEnd, 'function');
    assert.equal(observers[2].specEnd, undefined);
    const report = run();
    const lines = await capture(async () => {
      for (const observer of observers) await observer.specEnd?.({ report: report.specs[0] });
      for (const observer of observers) await observer.runEnd?.({ report });
    });
    assert.deepEqual(lines, ['✔ Checkout  (2 Jev calls, 30 tokens)', '  ✔ expect "Order complete" page detail']);
    assert.match(await fs.readFile(xml, 'utf8'), /<testsuites name="plainwright browser"/);
    assert.deepEqual(JSON.parse(await fs.readFile(json, 'utf8')), { schemaVersion: 1, ...report });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('two reporters writing the same file are rejected', () => {
  assert.throws(() => createReporters({ ...options, reporters: [{ name: 'junit', output: 'out/a.xml' }, { name: 'json', output: './out/a.xml' }] }),
    /two reporters write .*out\/a\.xml/);
});

test('jsonl prints skipped specs on stderr with their reason, never "undefined"', async () => {
  const lines: string[] = [];
  const old = console.error;
  console.error = (line) => { lines.push(line); };
  try {
    const reporter = createReporters({ ...options, reporters: [{ name: 'jsonl' }] })[0];
    await reporter.specEnd!({ report: spec('skipped', { file: 'tests/z.yaml', attempts: [], skipReason: 'bail' }) });
    await reporter.specEnd!({ report: spec('skipped', { file: 'tests/y.yaml', attempts: [] }) });
  } finally { console.error = old; }
  assert.deepEqual(lines, ['tests/z.yaml: skipped (bail)', 'tests/y.yaml: skipped']);
});
