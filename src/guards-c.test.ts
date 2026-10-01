// Lane C's "not implemented yet" guards. Lane C deletes this file (or turns it into real tests) when it
// removes them; no other test file asserts them, so lanes never edit the same test lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchedule } from './schedule.js';
import type { SuiteOptions } from './suite-types.js';

const base: SuiteOptions = { files: ['case.yaml'], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false,
  reporters: [{ name: 'text' }], timing: false };

test('lane C guards: --retries, --bail, --max-tokens, --last-failed', () => {
  checkSchedule(base);
  for (const patch of [{ retries: 1 }, { bail: 1 }, { maxTokens: 10 }, { lastFailed: true }])
    assert.throws(() => checkSchedule({ ...base, ...patch }), /not implemented yet/);
});
