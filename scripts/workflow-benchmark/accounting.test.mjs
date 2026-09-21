import test from 'node:test';
import assert from 'node:assert/strict';
import { costs } from './accounting.mjs';
const pricing = { input: .2e-6, input_cache_read: .02e-6, input_cache_write: .25e-6, output: 1.2e-6 };
test('includes cache write premiums, cache reads and reasoning once', () => {
  const result = costs({ inputTokens: 1000, inputTokenDetails: { cacheReadTokens: 200, cacheWriteTokens: 700 }, outputTokens: 100, outputTokenDetails: { reasoningTokens: 40 } }, pricing, '0.000319');
  assert.ok(Math.abs(result.listCost - .000319) < 1e-12);
  assert.equal(result.reportedCost, .000319);
  assert.ok(Math.abs(result.noCacheCost - .00032) < 1e-12);
});
test('missing usage is not a free request', () => {
  assert.throws(() => costs({ inputTokenDetails: {}, outputTokens: 0 }, pricing), /Missing/);
});
test('applies long-context pricing tiers', () => {
  const result = costs({ inputTokens: 300000, inputTokenDetails: {}, outputTokens: 10 }, { ...pricing, input_tiers: [{ min: 0, max: 272000, cost: .2e-6 }, { min: 272000, cost: .4e-6 }] });
  assert.ok(Math.abs(result.listCost - .120012) < 1e-12);
});
