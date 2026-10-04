import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceRoutes, promptGroups, routeNeedsLayout } from './evidence.js';

test('prompt groups hold descriptions only, across browser, desktop and mobile step shapes', () => {
  assert.deepEqual(promptGroups({ kind: 'fill', target: 'the Name field', value: 'secret' } as never), [['the Name field']]);
  assert.deepEqual(promptGroups({ kind: 'expect', expectations: ['A is left of B'], within: 'the form' }), [['A is left of B'], ['the form']]);
  assert.deepEqual(promptGroups({ kind: 'wait', condition: 'css=.done', within: 'the form' }), []);
  assert.deepEqual(promptGroups({ kind: 'drag', source: 'css=#a', target: 'the bin' }), [['the bin']]);
  // A native scroll's direction is not a relation between elements; a swipe names only its region.
  assert.deepEqual(promptGroups({ kind: 'scroll', target: 'down: the results list' }), [['the results list']]);
  assert.deepEqual(promptGroups({ kind: 'swipe', direction: 'left', within: 'the carousel' } as never), [['the carousel']]);
  assert.deepEqual(promptGroups({ kind: 'swipe', direction: 'left' } as never), []);
  for (const kind of ['goto', 'press', 'mouse']) assert.deepEqual(promptGroups({ kind, target: 'x' }), []);
});

test('the first route classifies every queued group in one request; a failed request is asked again later', async () => {
  const routes = evidenceRoutes();
  const asked: string[][][] = [];
  let fail = true;
  const classify = async (groups: string[][]) => {
    asked.push(groups);
    if (fail) throw new Error('model down');
    return groups.map((group) => group[0].includes('left'));
  };
  routes.pending.set('["the left button"]', ['the left button']);
  await assert.rejects(routeNeedsLayout(routes, ['the Name field'], classify), /model down/);
  fail = false;
  assert.equal(await routeNeedsLayout(routes, ['the left button'], classify), true);
  assert.equal(await routeNeedsLayout(routes, ['the Name field'], classify), false);
  assert.deepEqual(asked.map((groups) => groups.length), [2, 2]);
});
