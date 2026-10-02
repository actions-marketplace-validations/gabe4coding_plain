import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeholderPaths } from './hooks.js';

// MCP `open` lists these paths and never the leased values (src/core/hooks.ts). Browser, desktop and
// mobile tests only exercise flat keys such as ${hooks.text}.
test('placeholderPaths names nested leaves and never includes the values', () => {
  const secret = 'SuperSecretPassword!';
  const paths = placeholderPaths({
    user: { name: 'tomsmith', pass: secret },
    tags: ['admin', { role: secret }],
    count: 0,
    ok: false,
    missing: null,
    note: '',
  });
  assert.deepEqual(paths, [
    '${hooks.user.name}',
    '${hooks.user.pass}',
    '${hooks.tags}',
    '${hooks.count}',
    '${hooks.ok}',
    '${hooks.missing}',
    '${hooks.note}',
  ]);
  assert.equal(paths.some((p) => p.includes(secret) || p.includes('tomsmith') || p.includes('admin')), false);
  assert.deepEqual(placeholderPaths({}), []);
  assert.deepEqual(placeholderPaths({ user: {} }), []);
});
