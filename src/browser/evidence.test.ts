import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { intelligence, type Snapshot } from '../core/automation.js';
import type { Spec } from '../core/spec.js';
import { runSpec } from './runner.js';
import { closeSharedBrowser, openSession } from './session.js';
import { askPage } from './judge-page.js';

after(closeSharedBrowser);
const options = { headed: false, timeout: 5000 };
const html = '<input aria-label="Name"><input aria-label="Email"><section aria-label="Button pair" ' +
  'style="display:flex;flex-direction:row-reverse;width:300px;justify-content:space-between">' +
  '<button>A</button><button onclick="document.querySelector(\'output\').textContent=\'B clicked\'">B</button></section><output></output>';
const url = `data:text/html,${encodeURIComponent(html)}`;
const spec = (steps: Spec['steps']): Spec => ({ name: 'batch evidence', url, dir: process.cwd(), dialogs: 'accept', steps });

test('a real spec batches resolved descriptions once and keeps each route independent', async (t) => {
  const { ask, pick, judge } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; intelligence.judge = judge; });
  let routes = 0;
  intelligence.ask = async (state, questions) => {
    routes++;
    assert.deepEqual(state, { groups: [['the first field'], ['the button nearest the edge'], ['B clicked is shown', 'the first field contains entry']] });
    assert.equal(questions.length, 3);
    return { answers: [{ choice: 'semantic', confidence: 1 }, { choice: 'spatial', confidence: 1 },
      { choice: 'semantic', confidence: 1 }], tokens: 11 };
  };
  intelligence.pick = async (candidates, targets, state) => {
    const spatial = targets[0] === 'the button nearest the edge';
    assert.equal(state.layout !== undefined, spatial);
    assert.equal(candidates.some((candidate) => candidate.bounds), spatial);
    const chosen = spatial ? candidates.filter((candidate) => candidate.desc.startsWith('button '))
      .sort((a, b) => a.bounds!.left - b.bounds!.left)[0]
      : candidates.find((candidate) => candidate.desc.includes('Name'))!;
    return [{ id: chosen.id, probability: 1, probabilities: {}, tokens: 2 }];
  };
  intelligence.judge = async (state, claims) => {
    const snap = state as Snapshot;
    assert.equal(snap.layout, undefined);
    assert.match(snap.aria, /B clicked/);
    assert.match(snap.aria, /entry/);
    return { probabilities: claims.map(() => 1), tokens: 3 };
  };
  const result = await runSpec({ ...spec([
    { kind: 'goto', url },
    { kind: 'fill', target: '${env.field}', value: 'private entry' },
    { kind: 'fill', target: '${env.field}', value: 'entry' },
    { kind: 'click', target: 'the button nearest the edge' },
    { kind: 'expect', expectations: ['B clicked is shown', 'the first field contains entry'], within: 'css=body' },
  ]), env: { field: 'the first field' } }, options);
  assert.equal(result.status, 'pass', JSON.stringify(result.steps));
  assert.equal(routes, 1);
  assert.equal(result.jevCalls, 5);
  assert.equal(result.totalTokens, 20);
});

test('CSS-only steps never start the queued classifier', async (t) => {
  const { ask } = intelligence;
  t.after(() => { intelligence.ask = ask; });
  intelligence.ask = async () => { throw new Error('must not request a model'); };
  const result = await runSpec(spec([
    { kind: 'goto', url }, { kind: 'fill', target: 'css=input[aria-label=Name]', value: 'entry' },
    { kind: 'wait', condition: 'css=input' }, { kind: 'scroll', target: 'bottom' },
  ]), options);
  assert.equal(result.status, 'pass', JSON.stringify(result.steps));
  assert.equal(result.jevCalls, 0);
});

test('a scoped interactive claim batches the region and claim while retaining their separate routes', async (t) => {
  const { ask, pick, judge } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; intelligence.judge = judge; });
  const session = await openSession(spec([]), options, () => {});
  t.after(() => session.close());
  await session.ctx.page.goto(url);
  let routes = 0;
  intelligence.ask = async (state, questions) => {
    routes++;
    assert.deepEqual(state, { groups: [['B comes before A visually'], ['the Button pair row']] });
    assert.equal(questions.length, 2);
    return { answers: [{ choice: 'spatial', confidence: 1 }, { choice: 'semantic', confidence: 1 }], tokens: 1 };
  };
  intelligence.pick = async (candidates, _targets, state) => {
    assert.equal(state.layout, undefined);
    return [{ id: candidates.find((candidate) => candidate.desc.includes('Button pair'))!.id,
      probability: 1, probabilities: {}, tokens: 1 }];
  };
  intelligence.judge = async (state) => {
    const snap = state as Snapshot;
    assert.ok(snap.layout);
    assert.doesNotMatch(snap.layout, /Name|Email/);
    return { probabilities: [1], tokens: 1 };
  };
  const result = await askPage(session.ctx, ['B comes before A visually'], 'the Button pair row');
  assert.ok('probabilities' in result);
  assert.deepEqual(result.probabilities, [1]);
  assert.equal(routes, 1);
});

test('an optional failed batch route leaves later groups available for one retry', async (t) => {
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  let calls = 0;
  intelligence.ask = async (state, questions) => {
    calls++;
    assert.deepEqual(state, { groups: [['the first field'], ['the second field']] });
    if (calls === 1) throw new Error('temporary classifier failure');
    return { answers: questions.map(() => ({ choice: 'semantic', confidence: 1 })), tokens: 1 };
  };
  intelligence.pick = async (candidates) => [{ id: candidates.find((candidate) => candidate.desc.includes('Email'))!.id,
    probability: 1, probabilities: {}, tokens: 1 }];
  const result = await runSpec(spec([{ kind: 'goto', url },
    { kind: 'fill', target: 'the first field', value: 'entry', optional: true },
    { kind: 'fill', target: 'the second field', value: 'entry' },
  ]), options);
  assert.equal(result.status, 'pass', JSON.stringify(result.steps));
  assert.equal(result.steps[1].status, 'skipped');
  assert.equal(calls, 2);
});

test('a scroll to the page edge is not routed with the other descriptions', async (t) => {
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  const routed: unknown[] = [];
  intelligence.ask = async (state, questions) => {
    routed.push(state);
    return { answers: questions.map(() => ({ choice: 'semantic', confidence: 1 })), tokens: 1 };
  };
  intelligence.pick = async (candidates) => [{ id: candidates.find((candidate) => candidate.desc.includes('Email'))!.id,
    probability: 1, probabilities: {}, tokens: 1 }];
  const result = await runSpec(spec([{ kind: 'goto', url }, { kind: 'scroll', target: 'bottom' },
    { kind: 'fill', target: 'the second field', value: 'entry' }]), options);
  assert.equal(result.status, 'pass', JSON.stringify(result.steps));
  assert.deepEqual(routed, [{ groups: [['the second field']] }]);
});
