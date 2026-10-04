import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFor, evidenceForGroups } from './evidence.js';
import type { AskAnswer } from './ask.js';

test('uncertain evidence routes collect spatial evidence rather than discard it', async () => {
  const classify = (answer: AskAnswer) => evidenceFor(['a prompt'], async () => ({ answers: [answer], tokens: 4 }));
  assert.deepEqual(await classify({ choice: 'semantic', confidence: 0.99 }), { spatial: false, tokens: 4 });
  assert.equal((await classify({ choice: 'spatial', confidence: 0.99 })).spatial, true);
  assert.equal((await classify({ choice: 'semantic', confidence: 0.5, probabilities: { semantic: 0.99 } })).spatial, true);
  assert.equal((await classify({ choice: 'semantic', probabilities: { semantic: 0.95 } })).spatial, false);
  assert.equal((await classify({ choice: 'semantic' })).spatial, true);
  assert.equal((await classify({ choice: 'unknown', confidence: 1 })).spatial, true);
  await assert.rejects(evidenceFor(['prompt'], async () => ({ answers: [], tokens: 0 })), /no evidence route/);
});

test('batch routes stay independent, preserve order and reject incomplete answers', async () => {
  const groups = [['the first post'], ['the left button'], ['the button named Left']];
  let calls = 0;
  const result = await evidenceForGroups(groups, async (state, questions) => {
    calls++;
    assert.deepEqual(state, { groups });
    assert.equal(questions.length, 3);
    questions.forEach((question, index) => assert.ok(question.instructions.includes(`groups[${index}]`)));
    return { answers: [{ choice: 'semantic', confidence: 0.99 }, { choice: 'spatial', confidence: 0.99 },
      { choice: 'semantic', confidence: 0.5 }], tokens: 7 };
  });
  assert.deepEqual(result, { spatial: [false, true, true], tokens: 7 });
  assert.equal(calls, 1);
  assert.deepEqual(await evidenceForGroups([], async () => { throw new Error('must not ask'); }), { spatial: [], tokens: 0 });
  await assert.rejects(evidenceForGroups(groups, async () => ({ answers: [{ choice: 'semantic' }], tokens: 1 })), /group 1/);
});

test('oversized batches bisect only on the token limit and retain routes and per-request usage', async () => {
  const groups = Array.from({ length: 7 }, (_, index) => [String(index)]);
  let calls = 0;
  const usage: number[] = [];
  const result = await evidenceForGroups(groups, async (state) => {
    calls++;
    const batch = (state as { groups: string[][] }).groups;
    if (batch.length > 2) throw new Error('max_tokens_exceeded');
    return { answers: batch.map(([prompt]) => ({ choice: Number(prompt) % 2 ? 'spatial' : 'semantic', confidence: 1 })),
      tokens: batch.length * 3 };
  }, (tokens) => { usage.push(tokens); });
  assert.deepEqual(result, { spatial: [false, true, false, true, false, true, false], tokens: 21 });
  assert.equal(calls, 7);
  assert.equal(usage.length, 4);
  assert.equal(usage.reduce((sum, tokens) => sum + tokens, 0), 21);
  await assert.rejects(evidenceForGroups([['one']], async () => { throw new Error('max_tokens_exceeded'); }), /max_tokens_exceeded/);
  let failures = 0;
  await assert.rejects(evidenceForGroups(groups, async () => { failures++; throw new Error('invalid request'); }), /invalid request/);
  assert.equal(failures, 1);
});
