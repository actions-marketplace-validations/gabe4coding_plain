import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textReporter } from './text.js';
import { attempt, capture, run, spec } from './fixtures.js';

test('flaky output shows the passing attempt and only earlier failing step lines', async () => {
  const report = spec('pass', { flaky: true, attempts: [attempt('fail', { steps: [
    { step: 'goto /', status: 'pass' }, { step: 'expect "Order complete"', status: 'fail', detail: 'not found' },
    { step: 'expect "Total"', status: 'inconclusive' }, { step: 'click "Pay"', status: 'skipped' },
  ] }), attempt('error', { attempt: 1, steps: [], error: 'Error: browser closed' }), attempt('pass', { attempt: 2 })] });
  const reporter = textReporter(false);
  assert.deepEqual(await capture(() => reporter.specEnd!({ report })), [
    '✔ Checkout  (flaky, passed on attempt 3; 2 Jev calls, 30 tokens)',
    '  attempt 1:  ✘ expect "Order complete" not found', '  attempt 1:  ? expect "Total"',
    '  attempt 2: error: browser closed', '  ✔ expect "Order complete" page detail',
  ]);
});

test('suite stop skips print the file and reason, while optional skipped steps stay unchanged', async () => {
  const reporter = textReporter(false);
  assert.deepEqual(await capture(async () => {
    for (const skipReason of ['bail', 'max-tokens'] as const) {
      await reporter.specEnd!({ report: spec('skipped', { attempts: [], skipReason }) });
    }
    await reporter.specEnd!({ report: spec('skipped') });
  }), [
    '» tests/checkout.yaml  (skipped: bail)', '» tests/checkout.yaml  (skipped: max-tokens)',
    '» Checkout  (2 Jev calls, 30 tokens)', '  » expect "Order complete" page detail',
  ]);
});

test('multi-spec retry/stop summary uses suite totals, including every retry', async () => {
  const report = run([spec('pass', { flaky: true, attempts: [attempt('fail'), attempt('pass', { attempt: 1 })] }),
    spec('fail'), spec('skipped', { attempts: [], skipReason: 'bail' })]);
  assert.deepEqual(await capture(() => textReporter(false).runEnd!({ report })), [
    '1 passed, 1 failed, 1 flaky, 1 skipped  (6 Jev calls, 90 tokens, 5.25s)',
  ]);
});

test('single executed spec and ordinary multi-spec output retain Phase 0 behavior', async () => {
  for (const specs of [[], [spec('pass')], [spec('pass'), spec('fail')],
    [spec('pass', { flaky: true, attempts: [attempt('fail'), attempt('pass', { attempt: 1 })] })],
    [spec('fail'), spec('skipped', { attempts: [], skipReason: 'bail' })]]) {
    assert.deepEqual(await capture(() => textReporter(false).runEnd!({ report: run(specs) })), []);
  }
});
