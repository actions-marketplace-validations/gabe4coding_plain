import { expect, test } from 'claude-code/testing';
import { MAX_ROWS, apply, counts, emptyState, payload, saveName, stepLabel } from './model.ts';

const DATA = { status: 'pass', url: 'https://example.test/', jevTokens: 12 };

test('payload reads structured content, a text block, a JSON string or the outcome text', async () => {
  expect(payload({ result: { structuredContent: DATA, content: [] } })).toEqual(DATA);
  expect(payload({ result: { content: [{ type: 'text', text: JSON.stringify(DATA) }] } })).toEqual(DATA);
  expect(payload({ result: [{ type: 'text', text: JSON.stringify(DATA) }] })).toEqual(DATA);
  expect(payload({ result: JSON.stringify(DATA) })).toEqual(DATA);
  expect(payload({ result: undefined, text: JSON.stringify(DATA) })).toEqual(DATA);
});

test('payload prefers the outcome text over an unrelated result record', async () => {
  expect(payload({ ref: 1, result: { record: true }, text: JSON.stringify(DATA) })).toEqual(DATA);
});

test('payload is null for a refused, failed or non-JSON result', async () => {
  expect(payload({ deny: 'no' })).toBe(null);
  expect(payload({ result: { content: [{ type: 'text', text: 'boom' }] }, isError: true })).toBe(null);
  expect(payload({ result: { content: [{ type: 'text', text: 'boom' }], isError: true } })).toBe(null);
  expect(payload({ result: 'not json' })).toBe(null);
  expect(payload(undefined)).toBe(null);
});

test('stepLabel names the kind and the words of its target or claim', async () => {
  expect(stepLabel({ click: 'Save' })).toBe('click "Save"');
  expect(stepLabel({ fill: { target: 'the Name field', value: 'Alex' } })).toBe('fill "the Name field"');
  expect(stepLabel({ expect: ['a heading', 'a list'] })).toBe('expect "a heading; a list"');
  expect(stepLabel({ wait: { that: 'results show', within: 'the list' } })).toBe('wait "results show"');
  expect(stepLabel({ optional: true, click: 'Accept cookies' })).toBe('click "Accept cookies"');
  expect(stepLabel({ press: 'Enter' })).toBe('press "Enter"');
  expect(stepLabel(undefined)).toBe('step');
});

test('browser open sets target and goal and adds a goto row; a later open keeps the goal', async () => {
  let state = apply(emptyState(), 'browser', 'open', { url: 'https://example.test', goal: 'Read the discussion' },
    { url: 'https://example.test/', title: 'Example', notes: [] });
  expect(state.target).toBe('https://example.test/');
  expect(state.goal).toBe('Read the discussion');
  expect(state.rows).toEqual([{ label: 'goto "https://example.test"', status: 'pass', tokens: 0 }]);
  state = apply(state, 'browser', 'open', { url: 'https://example.test/b' }, { url: 'https://example.test/b' });
  expect(state.goal).toBe('Read the discussion');
  expect(state.rows.length).toBe(2);
});

test('native open starts over, with the app as target', async () => {
  const before = apply(emptyState(), 'native', 'step', { step: { click: 'Add' } }, DATA);
  const state = apply(before, 'native', 'open', { app: 'Calculator' }, { placeholders: [] });
  expect(state).toEqual({ rows: [], tokens: 0, target: 'Calculator', goal: undefined });
});

test('native open names the app from what the server returned', async () => {
  const desktop = apply(emptyState(), 'native', 'open', { pid: 1234 }, { name: 'Calculator', pid: 1234, placeholders: [] });
  expect(desktop.target).toBe('Calculator');
  const mobile = apply(emptyState(), 'native', 'open', { app: '${hooks.bundle}', device: 'X', platform: 'ios' },
    { platform: 'ios', device: 'X', app: 'com.example.app' });
  expect(mobile.target).toBe('com.example.app');
});

test('a skipped step keeps its row and detail but is not a failure', async () => {
  const state = apply(emptyState(), 'browser', 'step', { step: { click: 'Accept cookies', optional: true } },
    { status: 'skipped', detail: 'not found', notes: [], url: 'https://example.test/', jevTokens: 5 });
  expect(state.rows).toEqual([{ label: 'click "Accept cookies"', status: 'skipped', tokens: 5, detail: 'not found' }]);
  expect(state.lastFailure).toBeUndefined();
});

test('a non-pass step keeps its detail, adds its tokens and becomes the last failure', async () => {
  const state = apply(emptyState(), 'browser', 'step', { step: { expect: 'comments are shown' } },
    { status: 'inconclusive', detail: 'p=0.62', notes: ['1 console error'], url: 'https://example.test/a', jevTokens: 340, changed: { added: 'x' } });
  expect(state.rows).toEqual([{ label: 'expect "comments are shown"', status: 'inconclusive', tokens: 340, detail: 'p=0.62' }]);
  expect(state.tokens).toBe(340);
  expect(state.target).toBe('https://example.test/a');
  expect(state.lastFailure).toEqual({ step: { expect: 'comments are shown' }, status: 'inconclusive', detail: 'p=0.62',
    notes: ['1 console error'], url: 'https://example.test/a', changed: { added: 'x' } });
});

test('a batch adds one row per attempted step and gives the batch change to its failure', async () => {
  const steps = [{ click: 'Next' }, { expect: 'page 2 shows' }, { click: 'Next' }];
  const state = apply(emptyState(), 'browser', 'batch', { steps }, {
    status: 'fail', stoppedAt: 1, url: 'https://example.test/2', jevTokens: 30, changed: { removed: 4 },
    results: [
      { index: 0, status: 'pass', notes: [], url: 'https://example.test/2', jevTokens: 10 },
      { index: 1, status: 'fail', detail: 'p=0.03', notes: [], url: 'https://example.test/2', jevTokens: 20 },
    ],
  });
  expect(state.rows.map((row) => row.label)).toEqual(['click "Next"', 'expect "page 2 shows"']);
  expect(state.tokens).toBe(30);
  expect(state.lastFailure?.changed).toEqual({ removed: 4 });
  expect(counts(state)).toEqual({ steps: 2, passed: 1 });
});

test('a batch result without an index borrows no other step label', async () => {
  const state = apply(emptyState(), 'browser', 'batch', { steps: [{ click: 'Next' }] }, { results: [{ status: 'pass' }] });
  expect(state.rows.map((row) => row.label)).toEqual(['step']);
});

test('reads add a dim row and their tokens; save adds nothing', async () => {
  let state = apply(emptyState(), 'browser', 'ask', { claims: ['a', 'b'] }, { jevTokens: 50 });
  state = apply(state, 'browser', 'read', { question: 'the price' }, { jevTokens: 7 });
  state = apply(state, 'browser', 'save', { path: 'x.yaml' }, { path: '/w/x.yaml', steps: 2 });
  expect(state.rows).toEqual([
    { label: 'ask "a; b"', tokens: 50, dim: true },
    { label: 'read "the price"', tokens: 7, dim: true },
  ]);
  expect(state.tokens).toBe(57);
  expect(counts(state)).toEqual({ steps: 0, passed: 0 });
});

test('rows are capped at MAX_ROWS, oldest dropped', async () => {
  let state = emptyState();
  for (let i = 0; i < MAX_ROWS + 5; i += 1) state = apply(state, 'browser', 'step', { step: { click: `b${i}` } }, DATA);
  expect(state.rows.length).toBe(MAX_ROWS);
  expect(state.rows[0].label).toBe('click "b5"');
});

test('saveName makes a file name from the goal', async () => {
  expect(saveName('Read the F-Droid 2.0 discussion!')).toBe('read-the-f-droid-2-0-discussion.yaml');
  expect(saveName(undefined)).toBe('plain-session.yaml');
  expect(saveName('???')).toBe('plain-session.yaml');
});
