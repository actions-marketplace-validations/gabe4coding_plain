import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from '../suite.js';
import type { Status } from '../results.js';
import type { SuiteEngine, SuiteOptions } from '../suite-types.js';

const options = (files: string[], timing = false): SuiteOptions => ({ files, workers: 4, retries: 0, bail: 0,
  lastFailed: false, tags: [], list: false, reporters: [{ name: 'text' }], timing });
const services = { provider: () => 'typesafe' as const, warmUp: () => {} };
const capture = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const old = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = old; }
  return lines;
};

test('browser text golden output covers every status, load error, and input order with four workers', async () => {
  const files = ['pass', 'fail', 'inconclusive', 'skipped', 'error', 'missing'];
  const statuses: Status[] = ['pass', 'fail', 'inconclusive', 'skipped', 'error'];
  const finished: string[] = [];
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 4,
    load: (file) => { if (file === 'missing') throw new Error('bad yaml'); return file; },
    meta: (name) => ({ name, tags: [] }),
    run: async (name) => {
      await new Promise((resolve) => setTimeout(resolve, name === 'pass' ? 30 : 1));
      finished.push(name);
      const status = statuses[files.indexOf(name)];
      return { name, status, steps: [{ step: `click "${name}"`, status, detail: 'detail' }], jevCalls: 1, totalTokens: 10 };
    },
  };
  const lines = await capture(() => runSuite(engine, options(files), services));
  assert.notEqual(finished[0], 'pass');
  assert.deepEqual(lines, [
    '✔ pass  (1 Jev calls, 10 tokens)', '  ✔ click "pass" detail',
    '✘ fail  (1 Jev calls, 10 tokens)', '  ✘ click "fail" detail',
    '? inconclusive  (1 Jev calls, 10 tokens)', '  ? click "inconclusive" detail',
    '» skipped  (1 Jev calls, 10 tokens)', '  » click "skipped" detail',
    '✘ error  (1 Jev calls, 10 tokens)', '  ✘ click "error" detail',
    '✘ missing', '  error: bad yaml',
  ]);
});

test('browser timing golden output is unchanged on and off', async () => {
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 4, load: (file) => file,
    meta: (name) => ({ name, tags: [] }),
    run: async (name) => ({ name, status: 'pass', jevCalls: 0, totalTokens: 0,
      steps: [{ step: 'goto data:text/html,ok', status: 'pass', ms: { total: 12, settle: 3 } as Record<string, number> },
        { step: 'expect "ok"', status: 'pass', ms: { total: 8, jev: 2 } as Record<string, number> }] }),
  };
  assert.deepEqual(await capture(() => runSuite(engine, options(['case']), services)), [
    '✔ case  (0 Jev calls, 0 tokens)', '  ✔ goto data:text/html,ok', '  ✔ expect "ok"',
  ]);
  assert.deepEqual(await capture(() => runSuite(engine, options(['case'], true), services)), [
    '✔ case  (0 Jev calls, 0 tokens)', '  ✔ goto data:text/html,ok', '    ms total=12 settle=3',
    '  ✔ expect "ok"', '    ms total=8 jev=2', '  ms spec total=20 settle=3 jev=2',
    'ms run total=20 settle=3 jev=2',
  ]);
});
