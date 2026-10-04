import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '@typesafe-ai/sdk';
import { decide } from './decide.js';
import { mergePicks, pickElements, withoutContext, type PickPage, type PickResult } from './pick.js';

test('pickElements halves a request that is over the token limit and merges the answers', async () => {
  const candidates = Array.from({ length: 8 }, (_, id) => ({ id, desc: `button ${id}` }));
  const sizes: number[] = [];
  const ask = async (cands: { id: number }[], instructions: string[]) => {
    sizes.push(cands.length);
    if (cands.length > 2) throw new BadRequestError(400, { detail: { error_type: 'max_tokens_exceeded' } }, new Headers(), 'Bad Request');
    const hit = cands.find((c) => c.id === 5);
    return instructions.map(() => hit
      ? { id: 5, probability: 0.95, confidence: 0.95, probabilities: { '5': 0.95, none: 0.05 }, tokens: 10 }
      : { id: null, probability: 0.9, confidence: 0.9, probabilities: { none: 0.9 }, tokens: 10 });
  };
  const [pick] = await pickElements(candidates, ['button five'], { url: 'u', title: 't' }, ask as never);
  assert.equal(pick.id, 5);
  assert.deepEqual(sizes, [8, 4, 4, 2, 2, 2, 2]);
});

test('pickElements: two chunks each sure of a different element are settled by one question over both', async () => {
  const candidates = Array.from({ length: 300 }, (_, id) => ({ id, desc: id === 56 ? 'empty select' : id === 200 ? 'select, no options' : `link ${id}` }));
  const asked: number[][] = [];
  const ask = async (cands: { id: number }[], instructions: string[]) => {
    asked.push(cands.map((c) => c.id));
    const ids = cands.map((c) => c.id);
    const sure = ids.length === 2 ? 56 : ids.includes(56) ? 56 : 200;
    const p = ids.length === 2 ? 0.93 : 0.9;
    return instructions.map(() => ({ id: sure, probability: p, confidence: p, probabilities: { [sure]: p, none: 1 - p }, tokens: 10 }));
  };
  const [result] = await pickElements(candidates, ['the empty select'], { url: 'u', title: 't' }, ask as never);
  assert.deepEqual(asked.at(-1), [56, 200]);
  assert.equal(asked.length, 3);
  assert.equal(result.id, 56);
  assert.equal(result.probability, 0.93);
  assert.equal(result.tokens, 30);
  assert.equal(decide(result.confidence!, 'pick'), 'pass');
});

test('pickElements: a runoff that finds neither finalist stays none', async () => {
  const candidates = Array.from({ length: 300 }, (_, id) => ({ id, desc: `link ${id}` }));
  const ask = async (cands: { id: number }[], instructions: string[]) => instructions.map(() => cands.length === 2
    ? { id: null, probability: 0.8, confidence: 0.8, probabilities: { none: 0.8 }, tokens: 1 }
    : { id: cands[0].id, probability: 0.9, confidence: 0.9, probabilities: { [cands[0].id]: 0.9, none: 0.1 }, tokens: 1 });
  const [result] = await pickElements(candidates, ['the link'], { url: 'u', title: 't' }, ask as never);
  assert.equal(result.id, null);
});

test('reference geometry remains available in candidate chunks, token-limit splits and the finalist runoff', async () => {
  const candidates = Array.from({ length: 300 }, (_, id) => ({ id, desc: `field ${id}` }));
  const state = { url: 'u', title: 't', layout: 'Shipping heading bounds={"top":80,"bottom":100}' };
  const sizes: number[] = [];
  const ask = async (cands: { id: number }[], _instructions: string[], page: PickPage) => {
    assert.equal(page.layout, state.layout);
    sizes.push(cands.length);
    if (cands.length > 100) throw new BadRequestError(400, { detail: { error_type: 'max_tokens_exceeded' } }, new Headers(), 'Bad Request');
    return [{ id: cands[0].id, probability: 1, confidence: 1, probabilities: { [cands[0].id]: 1 }, tokens: 1 }];
  };
  await pickElements(candidates, ['the field below Shipping'], state, ask as never);
  assert.ok(sizes.includes(150));
  assert.ok(sizes.includes(75));
  assert.ok(sizes.includes(2));
});

const pick = (id: number | null, p: number, probabilities: Record<string, number>, tokens = 0): PickResult => ({
  id,
  probability: p,
  confidence: p,
  probabilities,
  tokens,
});

test('mergePicks: the element found in a later chunk wins; tokens add up; maps merge with the winner\'s none', () => {
  const [r] = mergePicks([
    [pick(null, 0.98, { none: 0.98, '3': 0.02 }, 1000)],
    [pick(467, 0.95, { '467': 0.95, none: 0.05 }, 1200)],
  ]);
  assert.equal(r.id, 467);
  assert.equal(r.probability, 0.95);
  assert.equal(r.tokens, 2200);
  assert.deepEqual(r.probabilities, { '3': 0.02, '467': 0.95, none: 0.05 });
});

test('mergePicks: all none stays none, and shows the least sure chunk\'s guesses', () => {
  const [r] = mergePicks([[pick(null, 0.99, { none: 0.99, '1': 0.01 })], [pick(null, 0.6, { none: 0.6, '300': 0.4 })]]);
  assert.equal(r.id, null);
  assert.equal(r.probabilities.none, 0.6);
  assert.equal(r.probabilities['300'], 0.4);
});

test('mergePicks: two chunks each sure of a different element split the score below acceptance', () => {
  const [r] = mergePicks([[pick(7, 0.9, { '7': 0.9, none: 0.1 })], [pick(400, 0.8, { '400': 0.8, none: 0.2 })]]);
  assert.equal(r.id, 7);
  assert.equal(r.confidence, 0.45);
  assert.equal(decide(r.confidence!, 'pick'), 'inconclusive');
  assert.equal(r.probabilities['400'], 0.8); // both guesses stay visible in the detail
});

test('mergePicks: several instructions merge independently, only the first carries tokens', () => {
  const rs = mergePicks([
    [pick(1, 0.9, { '1': 0.9, none: 0.1 }, 500), pick(null, 0.9, { none: 0.9 })],
    [pick(null, 0.9, { none: 0.9 }, 500), pick(300, 0.7, { '300': 0.7, none: 0.3 })],
  ]);
  assert.deepEqual(rs.map((r) => r.id), [1, 300]);
  assert.deepEqual(rs.map((r) => r.tokens), [1000, 0]);
});

test('withoutContext drops the container part and keeps quoted names that contain the word', () => {
  assert.equal(withoutContext('a "new" href=/newest context: tr text="Hacker News | past"'), 'a "new" href=/newest');
  assert.equal(withoutContext('button "Show context: details" context: section name="A"'), 'button "Show context: details"');
  assert.equal(withoutContext('input value="see context: notes" label="X" context: form name="Y"'), 'input value="see context: notes" label="X"');
  assert.equal(withoutContext('android.widget.Button "A" in android.widget.FrameLayout "B"'), 'android.widget.Button "A" in android.widget.FrameLayout "B"');
});
