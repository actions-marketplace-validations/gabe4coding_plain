import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonlReporter } from './jsonl.js';
import { runSuite } from '../run-suite.js';
import { loadComputerSpec } from '../../computer/spec.js';
import type { SuiteEngine, SuiteOptions } from '../types.js';

test('native reporter prints one JSON line with the legacy result fields', async () => {
  const lines: string[] = [];
  const old = console.log;
  console.log = (line) => { lines.push(line); };
  try {
    await jsonlReporter().specEnd!({ report: { file: 'test.yaml', name: 'native', tags: [], status: 'pass', flaky: false,
      attempts: [{ name: 'native', status: 'pass', steps: [{ step: 'tap "Save"', status: 'pass' }],
        jevCalls: 2, totalTokens: 9, attempt: 0, durationMs: 12, artifacts: [] }] } });
  } finally { console.log = old; }
  assert.deepEqual(lines, ['{"name":"native","status":"pass","steps":[{"step":"tap \\"Save\\"","status":"pass"}],"jevCalls":2,"totalTokens":9}']);
});

test('native load errors go to stderr as file: error and write no stdout JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-jsonl-'));
  const good = path.join(dir, 'ok.yaml');
  const yaml = path.join(dir, 'bad.yaml');
  const schema = path.join(dir, 'schema.yaml');
  const step = path.join(dir, 'step.yaml');
  fs.writeFileSync(good, 'name: ok\napp: Notes\nsteps:\n  - click: Save\n');
  fs.writeFileSync(yaml, 'a: [\n');
  fs.writeFileSync(schema, 'name: 1\n');
  fs.writeFileSync(step, 'name: step\napp: Notes\nsteps:\n  - goto: /\n');
  const thrown = (file: string): string => {
    try { loadComputerSpec(file); }
    catch (error) { return `${file}: ${error}`; }
    throw new Error(`expected ${file} to fail to load`);
  };
  const expectedErrors = [yaml, schema, step].map(thrown);
  const opts: SuiteOptions = { files: [yaml, good, schema, step], workers: 1, retries: 0, bail: 0, lastFailed: false,
    tags: [], list: false, reporters: [{ name: 'jsonl' }], timing: false };
  const engine: SuiteEngine<ReturnType<typeof loadComputerSpec>> = { engine: 'desktop', maxWorkers: 1,
    load: loadComputerSpec, meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [] }),
    run: async (spec) => ({ name: spec.name, status: 'pass', steps: [{ step: 'click "Save"', status: 'pass' }], jevCalls: 1, totalTokens: 4 }) };
  const logs: string[] = [], errors: string[] = [];
  const oldLog = console.log, oldError = console.error;
  console.log = (line) => { logs.push(String(line)); };
  console.error = (line) => { errors.push(String(line)); };
  try {
    const report = await runSuite(engine, opts, { provider: () => 'typesafe', warmUp: () => {} });
    assert.equal(report.status, 'fail');
  } finally {
    console.log = oldLog; console.error = oldError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(logs, ['{"name":"ok","status":"pass","steps":[{"step":"click \\"Save\\"","status":"pass"}],"jevCalls":1,"totalTokens":4}']);
  assert.deepEqual(errors, expectedErrors);
});

test('native run exceptions go to stderr as file: error, with no stdout JSON', async () => {
  const out: string[] = []; const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (line) => { out.push(line); }; console.error = (line) => { err.push(line); };
  try {
    await jsonlReporter().specEnd!({ report: { file: 'run.yaml', name: 'native', tags: [], status: 'error', flaky: false,
      attempts: [{ name: 'native', status: 'error', steps: [], jevCalls: 0, totalTokens: 0, error: 'Error: no adapter',
        attempt: 0, durationMs: 1, artifacts: [] }] } });
  } finally { console.log = log; console.error = error; }
  assert.deepEqual(out, []);
  assert.deepEqual(err, ['run.yaml: Error: no adapter']);
});
