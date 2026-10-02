import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSchedule, schedule } from './schedule.js';
import { runSuite } from './suite.js';
import type { Attempt, Loaded, SpecReport, SuiteEngine, SuiteOptions } from './suite-types.js';

const base: SuiteOptions = { files: [], workers: 1, retries: 0, bail: 0, lastFailed: false,
  tags: [], list: false, reporters: [{ name: 'jsonl' }], timing: false };
const specs = (count: number): Loaded<number>[] => Array.from({ length: count }, (_, spec) =>
  ({ file: `${spec}.yaml`, name: `case ${spec}`, tags: ['smoke'], spec }));
const attempt = (status: Attempt['status'] = 'pass', number = 0, totalTokens = 0): Attempt =>
  ({ name: 'case', status, attempt: number, steps: [], jevCalls: 1, totalTokens, durationMs: 10, artifacts: [] });
async function collect(iterable: AsyncIterable<SpecReport>): Promise<SpecReport[]> {
  const reports: SpecReport[] = [];
  for await (const report of iterable) reports.push(report);
  return reports;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('schedule validates numeric flags and accepts supported combinations', () => {
  checkSchedule({ ...base, workers: 4, retries: 2, bail: 1, maxTokens: 10, lastFailed: true });
  for (const flag of ['workers', 'retries', 'bail', 'maxTokens'] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => checkSchedule({ ...base, [flag]: value }));
  }
  assert.throws(() => checkSchedule({ ...base, workers: 0 }), /--workers/);
  assert.throws(() => checkSchedule({ ...base, maxTokens: 0 }), /--max-tokens/);
});

test('non-pass attempts retry immediately in the same slot and a later pass is flaky', async () => {
  const calls: [number, number][] = [];
  const reports = await collect(schedule(specs(2), { ...base, retries: 2 }, async ({ spec }, number) => {
    calls.push([spec, number]);
    return attempt(spec === 0 && number < 2 ? 'fail' : 'pass', number);
  }));
  assert.deepEqual(calls, [[0, 0], [0, 1], [0, 2], [1, 0]]);
  assert.equal(reports[0].status, 'pass');
  assert.equal(reports[0].flaky, true);
  assert.deepEqual(reports[0].attempts.map((a) => a.attempt), [0, 1, 2]);
  assert.equal(reports[1].flaky, false);
  assert.deepEqual(reports.map(({ file, name, tags }) => ({ file, name, tags })),
    specs(2).map(({ file, name, tags }) => ({ file, name, tags })));
});

for (const status of ['fail', 'inconclusive', 'error', 'skipped'] as const) {
  test(`${status} retries stop after N additional attempts`, async () => {
    const [report] = await collect(schedule(specs(1), { ...base, retries: 2 }, async (_, number) =>
      ({ ...attempt(status, number), ...(status === 'error' ? { error: 'launch failed' } : {}) })));
    assert.equal(report.status, status);
    assert.equal(report.flaky, false);
    assert.deepEqual(report.attempts.map((a) => a.attempt), [0, 1, 2]);
  });
}

test('no retries by default and a passing attempt never retries', async () => {
  const [failed] = await collect(schedule(specs(1), base, async () => attempt('fail')));
  const [passed] = await collect(schedule(specs(1), { ...base, retries: 5 }, async () => attempt()));
  assert.equal(failed.attempts.length, 1);
  assert.equal(passed.attempts.length, 1);
  assert.equal(passed.flaky, false);
});

test('bail counts final failures and ignores flaky passes', async () => {
  const calls: [number, number][] = [];
  const reports = await collect(schedule(specs(5), { ...base, retries: 1, bail: 2 }, async ({ spec }, number) => {
    calls.push([spec, number]);
    return attempt(spec === 1 && number === 1 ? 'pass' : 'fail', number);
  }));
  assert.deepEqual(calls, [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
  assert.equal(reports[1].flaky, true);
  assert.deepEqual(reports.map((r) => r.status), ['fail', 'pass', 'fail', 'skipped', 'skipped']);
  for (const report of reports.slice(3)) {
    assert.equal(report.skipReason, 'bail');
    assert.deepEqual(report.attempts, []);
  }
});

test('bail with four workers lets running specs and their retries finish', { timeout: 3000 }, async () => {
  const gates = Array.from({ length: 4 }, () => deferred<Attempt>());
  const calls: [number, number][] = [];
  const pending = collect(schedule(specs(7), { ...base, workers: 4, retries: 1, bail: 1 }, async ({ spec }, number) => {
    calls.push([spec, number]);
    return number ? attempt(spec === 0 ? 'fail' : 'pass', number) : gates[spec].promise;
  }));
  assert.deepEqual(calls, [[0, 0], [1, 0], [2, 0], [3, 0]]);
  gates[0].resolve(attempt('fail'));
  await setImmediate();
  gates[1].resolve(attempt('fail'));
  gates[2].resolve(attempt());
  gates[3].resolve(attempt());
  const reports = await pending;
  assert.deepEqual(calls, [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1]]);
  assert.equal(reports[1].flaky, true);
  assert.deepEqual(reports.slice(4).map((r) => [r.status, r.skipReason, r.attempts.length]),
    Array.from({ length: 3 }, () => ['skipped', 'bail', 0]));
});

test('token limit is checked before new specs; completed attempts may overshoot', async () => {
  const reports = await collect(schedule(specs(4), { ...base, maxTokens: 10 }, async () => attempt('pass', 0, 6)));
  assert.deepEqual(reports.map((r) => r.status), ['pass', 'pass', 'skipped', 'skipped']);
  for (const report of reports.slice(2)) {
    assert.equal(report.skipReason, 'max-tokens');
    assert.deepEqual(report.attempts, []);
  }
});

test('retries consume tokens; a spec whose retry is blocked keeps its real status', async () => {
  const calls: number[] = [];
  const reports = await collect(schedule(specs(2), { ...base, retries: 3, maxTokens: 10 }, async (_, number) => {
    calls.push(number);
    return attempt('fail', number, 5);
  }));
  assert.deepEqual(calls, [0, 1]);
  assert.equal(reports[0].status, 'fail');
  assert.equal(reports[0].skipReason, undefined);
  assert.equal(reports[0].flaky, false);
  assert.equal(reports[0].attempts.reduce((sum, a) => sum + a.totalTokens, 0), 10);
  assert.equal(reports[1].attempts.length, 0);
  assert.equal(reports[1].skipReason, 'max-tokens');
});

test('concurrent token limit stops new specs and retries, but running attempts finish', { timeout: 3000 }, async () => {
  const gates = Array.from({ length: 4 }, () => deferred<Attempt>());
  const calls: [number, number][] = [];
  const pending = collect(schedule(specs(6), { ...base, workers: 4, retries: 1, maxTokens: 10 }, async ({ spec }, number) => {
    calls.push([spec, number]);
    return gates[spec].promise;
  }));
  gates[2].resolve(attempt('pass', 0, 10));
  await setImmediate();
  gates[0].resolve(attempt('fail', 0, 5));
  gates[1].resolve(attempt('pass', 0, 5));
  gates[3].resolve(attempt('pass', 0, 5));
  const reports = await pending;
  assert.deepEqual(calls, [[0, 0], [1, 0], [2, 0], [3, 0]]);
  // Spec 0 ran and failed; only its retry was cut by the budget, so it stays `fail`.
  assert.deepEqual(reports.map((r) => r.status), ['fail', 'pass', 'pass', 'pass', 'skipped', 'skipped']);
  assert.equal(reports[0].attempts.length, 1);
  assert.equal(reports[0].skipReason, undefined);
  assert.deepEqual(reports.slice(4).map((r) => r.skipReason), ['max-tokens', 'max-tokens']);
  assert.equal(reports.flatMap((r) => r.attempts).reduce((sum, a) => sum + a.totalTokens, 0), 25);
});

test('input order streams each final result without waiting for later specs', { timeout: 3000 }, async () => {
  const gates = Array.from({ length: 4 }, () => deferred<Attempt>());
  const calls: [number, number][] = [];
  const iterable = schedule(specs(3), { ...base, workers: 2, retries: 1 }, async ({ spec }, number) => {
    calls.push([spec, number]);
    return gates[spec === 0 && number === 1 ? 3 : spec].promise;
  });
  const iterator = iterable[Symbol.asyncIterator]();
  let yielded = false;
  const first = iterator.next().then((result) => { yielded = true; return result; });
  assert.deepEqual(calls, [[0, 0], [1, 0]]);
  gates[1].resolve(attempt());
  await setImmediate();
  assert.deepEqual(calls, [[0, 0], [1, 0], [2, 0]]);
  assert.equal(yielded, false);
  gates[0].resolve(attempt('fail'));
  await setImmediate();
  assert.equal(yielded, false);
  gates[3].resolve(attempt('pass', 1));
  assert.equal((await first).value?.file, '0.yaml');
  assert.equal((await iterator.next()).value?.file, '1.yaml');
  gates[2].resolve(attempt());
  assert.equal((await iterator.next()).value?.file, '2.yaml');
  assert.equal((await iterator.next()).done, true);
});

test('bail has precedence when both limits block a new spec', async () => {
  const reports = await collect(schedule(specs(2), { ...base, bail: 1, maxTokens: 10 }, async () => attempt('fail', 0, 10)));
  assert.equal(reports[1].skipReason, 'bail');
});

test('a later rejected runOne is handled while waiting for an earlier spec', { timeout: 3000 }, async () => {
  const gates = [deferred<Attempt>(), deferred<Attempt>()];
  const iterator = schedule(specs(2), { ...base, workers: 2 }, ({ spec }) => gates[spec].promise)[Symbol.asyncIterator]();
  const first = iterator.next();
  gates[1].reject(new Error('unexpected runOne rejection'));
  await setImmediate();
  gates[0].resolve(attempt());
  assert.equal((await first).value?.file, '0.yaml');
  await assert.rejects(iterator.next(), /unexpected runOne rejection/);
});

test('last-failed is accepted without filtering in the scheduler', async () => {
  const reports = await collect(schedule(specs(2), { ...base, lastFailed: true }, async () => attempt()));
  assert.equal(reports.length, 2);
  assert.deepEqual(await collect(schedule([], base, async () => { throw new Error('unexpected run'); })), []);
});

test('suite keeps load errors out of retries and retries thrown runs as error attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plainwright-schedule-'));
  const cwd = process.cwd();
  const calls: number[] = [];
  const loads: string[] = [];
  const engine: SuiteEngine<string> = { engine: 'desktop', maxWorkers: 1,
    load(file) { loads.push(file); if (file === 'bad') throw new Error('invalid YAML'); return file; },
    meta: (name) => ({ name, tags: [] }),
    async run(_, __, info) {
      calls.push(info.attempt);
      if (!info.attempt) throw new Error('launch failed');
      return attempt('pass', info.attempt);
    },
  };
  const oldLog = console.log, oldError = console.error;
  console.log = console.error = () => {};
  try {
    process.chdir(dir);
    const report = await runSuite(engine, { ...base, files: ['bad', 'good'], retries: 2 },
      { provider: () => 'typesafe', warmUp: () => {} });
    assert.deepEqual(loads, ['bad', 'good']);
    assert.deepEqual(calls, [0, 1]);
    assert.equal(report.specs[0].status, 'error');
    assert.match(report.specs[0].loadError!, /invalid YAML/);
    assert.deepEqual(report.specs[0].attempts, []);
    assert.equal(report.specs[1].flaky, true);
    assert.match(report.specs[1].attempts[0].error!, /launch failed/);
    assert.equal(report.totals.flaky, 1);
  } finally {
    process.chdir(cwd);
    console.log = oldLog; console.error = oldError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after runOne rejects, no new spec or retry starts', async () => {
  const started: number[] = [];
  await assert.rejects(collect(schedule(specs(4), { ...base, workers: 1, retries: 1 }, async ({ spec }) => {
    started.push(spec);
    if (spec === 0) throw new Error('boom');
    return attempt('pass', 0, 1);
  })), /boom/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, [0]);
});
