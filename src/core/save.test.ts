import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryKey, type LockEntry, type LockRef } from './lock.js';
import { savedLockEntries, secretEnv, secretKeyName } from './save.js';

test('secretKeyName names one secret password, a second password2 and a third password3', () => {
  assert.equal(secretKeyName(0), 'password');
  assert.equal(secretKeyName(1), 'password2');
  assert.equal(secretKeyName(2), 'password3');
});

test('secretEnv is empty with no secrets, and $PASSWORD then $PASSWORD_2', () => {
  assert.deepEqual(secretEnv([]), {});
  assert.deepEqual(secretEnv(['password']), { env: { password: '$PASSWORD' } });
  assert.deepEqual(secretEnv(new Map([['a', 'password'], ['b', 'password2']]).values()),
    { env: { password: '$PASSWORD', password2: '$PASSWORD_2' } });
});

test('savedLockEntries drops a record at the transcript length or past it, in recorded order', () => {
  const ref = (index: number): LockRef => ({ at: { file: '', index }, kind: 'click', slot: 'target:Go' });
  const entry = (n: number): LockEntry => ({ locator: { n }, text: `button ${n}` });
  const recorded = [1, 2, 0, 3].map((index) => ({ ref: ref(index), entry: entry(index) }));
  const entries = savedLockEntries(recorded, 2);
  assert.deepEqual([...entries.entries()], [
    [entryKey(ref(1)), entry(1)],
    [entryKey(ref(0)), entry(0)],
  ]);
});
