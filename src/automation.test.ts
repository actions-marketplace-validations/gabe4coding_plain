import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets, judgeState, type Intelligence } from './automation.js';
const adapter = { candidates: [{ id: 1, desc: 'button OK' }], state: { url: 'desktop://test', title: 'Test' }, element: () => 'handle' };
const ai: Intelligence = {
  pick: async () => [{ id: 1, probability: .4, confidence: .8, probabilities: { '1': .4 }, tokens: 12 }],
  judge: async () => ({ probabilities: [.95], tokens: 4 }),
};
test('shared resolver uses confidence, accounts once, and maps accepted IDs through adapter', async () => {
  const [r] = await resolveTargets(adapter, ['OK'], ai);
  assert.equal(r.element, 'handle'); assert.equal(r.tokens, 12); assert.equal(r.usedJev, true);
});
test('shared resolver rejects confident unknown IDs and low-confidence picks', async () => {
  for (const pick of [{ id: 99, probability: 1 }, { id: 1, probability: .49 }, { id: null, probability: 1 }]) {
    const [r] = await resolveTargets(adapter, ['OK'], { ...ai, pick: async () => [{ ...pick, probabilities: {}, tokens: 1 }] });
    assert.equal(r.element, null);
  }
});
test('empty candidate set makes no paid model request', async () => {
  const [r] = await resolveTargets({ ...adapter, candidates: [] }, ['OK'], { ...ai, pick: async () => { throw new Error('must not call'); } });
  assert.equal(r.usedJev, false); assert.equal(r.element, null);
});
test('shared judge halves oversized state and preserves all claims/events', async () => {
  const lengths: number[] = [];
  const result = await judgeState({ ...adapter.state, aria: 'x'.repeat(9000), truncated: false }, ['a', 'b'], ['downloaded'], {
    ...ai, judge: async (state, claims) => {
      const s = state as { aria: string; events: string[] }; lengths.push(s.aria.length);
      assert.deepEqual(claims, ['a', 'b']); assert.deepEqual(s.events, ['downloaded']);
      if (s.aria.length > 5000) throw new Error('max_tokens_exceeded');
      return { probabilities: [.95, .05], tokens: 9 };
    },
  });
  assert.deepEqual(lengths, [9000, 4500]); assert.equal(result.tokens, 9);
});
