import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from './run-suite.js';
import { validate } from './validate.js';
import type { SuiteEngine, SuiteOptions, RunObserver } from './types.js';

const opts: SuiteOptions = { files: ['one'], workers: 1, retries: 0, bail: 0, lastFailed: false,
  tags: [], list: false, reporters: [{ name: 'jsonl' }], timing: false };
const engine: SuiteEngine<string> = { engine: 'desktop', maxWorkers: 1,
  load: (file) => { if (file === 'bad') throw new Error('invalid'); return file; },
  meta: (name) => ({ name, tags: ['smoke'] }),
  run: async (name, observer, info) => {
    const target = { engine: 'desktop' as const, screenshot: async () => {} };
    await observer?.sessionOpen?.({ ...info, target });
    const result = { step: 'click "Save"', status: 'pass' as const };
    await observer?.stepEnd?.({ ...info, index: 0, result, target });
    await observer?.sessionClose?.({ ...info, status: 'pass', target });
    return { name, status: 'pass', steps: [result], jevCalls: 1, totalTokens: 3 };
  },
};

test('suite observer lifecycle is ordered and errors never change status', async () => {
  const calls: string[] = [], warnings: string[] = [];
  const observer: RunObserver = {
    async runStart() { calls.push('runStart'); },
    async sessionOpen() { calls.push('sessionOpen'); },
    async stepEnd() { calls.push('stepEnd'); throw new Error('observer failed'); },
    async sessionClose() { calls.push('sessionClose'); throw new Error('again'); },
    async specEnd() { calls.push('specEnd'); },
    async runEnd() { calls.push('runEnd'); },
  };
  const oldError = console.error, oldLog = console.log;
  console.error = (line) => { warnings.push(String(line)); };
  console.log = () => {};
  try {
    const report = await runSuite(engine, opts, { provider: () => 'typesafe', warmUp: () => {}, observers: [observer] });
    assert.equal(report.status, 'pass');
    assert.deepEqual(report.totals, { jevCalls: 1, tokens: 3, passed: 1, failed: 0, flaky: 0, skipped: 0, replayed: 0, healed: 0 });
  } finally { console.error = oldError; console.log = oldLog; }
  assert.deepEqual(calls, ['runStart', 'sessionOpen', 'stepEnd', 'sessionClose', 'specEnd', 'runEnd']);
  assert.equal(warnings.filter((s) => s.includes('observer failed')).length, 1);
  assert.equal(warnings.filter((s) => s.includes('again')).length, 0);
});

test('validate only loads: load errors, no run', () => {
  assert.deepEqual(validate(engine, ['one', 'bad']), [
    { file: 'one', warnings: [] }, { file: 'bad', error: 'invalid', warnings: [] },
  ]);
});

test('RunReport.stopped names the first skip reason lane C reports', async () => {
  const stopEngine: SuiteEngine<string> = { ...engine, run: async (name) => ({ name, status: 'fail', steps: [], jevCalls: 0, totalTokens: 0 }) };
  const oldLog = console.log; console.log = () => {};
  try {
    const report = await runSuite(stopEngine, { ...opts, files: ['one', 'two'], bail: 1 }, { provider: () => 'typesafe', warmUp: () => {} });
    assert.equal(report.stopped, 'bail');
    assert.deepEqual(report.specs.map((s) => s.status), ['fail', 'skipped']);
  } finally { console.log = oldLog; }
});
