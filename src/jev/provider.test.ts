import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProvider, USER_ENV_FILE } from './provider.js';

test('selectProvider: only TYPESAFE_API_KEY set → typesafe', () => {
  assert.equal(selectProvider({ TYPESAFE_API_KEY: 'k' }), 'typesafe');
});

test('selectProvider: only AI_GATEWAY_API_KEY set → gateway', () => {
  assert.equal(selectProvider({ AI_GATEWAY_API_KEY: 'k' }), 'gateway');
});

test('selectProvider: both keys set → typesafe wins', () => {
  assert.equal(selectProvider({ TYPESAFE_API_KEY: 'k', AI_GATEWAY_API_KEY: 'k' }), 'typesafe');
});

test('selectProvider: JEV_PROVIDER=gateway with both keys → gateway', () => {
  assert.equal(
    selectProvider({ JEV_PROVIDER: 'gateway', TYPESAFE_API_KEY: 'k', AI_GATEWAY_API_KEY: 'k' }),
    'gateway'
  );
});

test('selectProvider: JEV_PROVIDER=bogus throws', () => {
  assert.throws(() => selectProvider({ JEV_PROVIDER: 'bogus' }), /JEV_PROVIDER/);
});

test('selectProvider: no keys throws naming both variables', () => {
  assert.throws(() => selectProvider({}), /TYPESAFE_API_KEY/);
  assert.throws(() => selectProvider({}), /AI_GATEWAY_API_KEY/);
});

test('selectProvider: no keys names the user env file', () => {
  assert.throws(() => selectProvider({}), (err: Error) => err.message.includes(USER_ENV_FILE));
});

test('selectProvider: JEV_PROVIDER=typesafe without its key throws naming TYPESAFE_API_KEY', () => {
  assert.throws(() => selectProvider({ JEV_PROVIDER: 'typesafe', AI_GATEWAY_API_KEY: 'k' }), /TYPESAFE_API_KEY/);
});
