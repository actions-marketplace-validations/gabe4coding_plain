import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSnapshot, type SnapshotEvidence } from '../jev/describe.js';
import { type AskAnswer } from '../jev/ask.js';
import { snapshotView } from './snapshot-view.js';

const snap = (aria: string, truncated = false) => ({ url: 'test://fixture', title: 'Fixture', aria, truncated });
const evidence: SnapshotEvidence = { ...snap(''), blocks: [{ aria: '- heading "Sign in"', context: [] }] };
const answers = (overrides: AskAnswer[] = []): AskAnswer[] => [
  { choice: 'authentication', probabilities: { authentication: .97 }, confidence: .96 },
  { probability: .02 }, { probability: .5 }, { probability: .99 }, ...overrides,
];

test('raw stays byte-for-byte compatible and compact needs no model', async () => {
  const source = snap('- group:\n  - button "Save draft" [disabled]\n  - button "Publish"');
  const noModel = async (): Promise<never> => { throw new Error('unexpected model call'); };
  assert.deepEqual(await snapshotView(source, {}, noModel), source);
  const raw = await snapshotView(source, { maxChars: 5 }, noModel);
  assert.ok('aria' in raw);
  assert.equal(raw.aria, '- gro'); assert.equal(raw.truncated, true);
  const compact = await snapshotView(source, { mode: 'compact' }, noModel);
  assert.ok('observed' in compact);
  assert.equal(compact.observed?.aria, '  - button "Save draft" [disabled]\n  - button "Publish"');
  assert.equal(compact.coverage?.removedWrappers, 1);
  assert.equal(compact.coverage?.omittedLines, 0);
  assert.equal(compact.jevTokens, 0);
  assert.equal(compact.truncated, false);
});

test('a late dialog wins a tight budget and retains its named ancestor and exact messages', async () => {
  const source = snap('- main:\n' + Array.from({ length: 100 }, (_, i) => `  - button "Item ${i}"`).join('\n') +
    '\n  - dialog "Account":\n    - alert: "Email already in use"\n    - button "Try another email"');
  const view = await snapshotView(source, { mode: 'compact', maxChars: 130 });
  assert.ok('observed' in view);
  assert.match(view.observed!.aria, /main:[\s\S]*\n  - dialog "Account":\n    - alert: "Email already in use"/);
  assert.match(view.observed!.aria, /Try another email/);
  assert.ok(view.observed!.aria.length <= 130);
  assert.ok(view.coverage!.omittedLines > 0);
  assert.equal(view.coverage!.omittedCriticalLines, 0);
});

test('mobile and desktop role names preserve exact values and prioritize modal content', async () => {
  for (const [window, button, modal, field] of [
    ['AXWindow', 'AXButton', 'AXSheet', 'AXTextField'],
    ['XCUIElementTypeWindow', 'XCUIElementTypeButton', 'dialog', 'XCUIElementTypeTextField'],
    ['android.view.View', 'android.widget.Button', 'dialog', 'android.widget.EditText'],
  ]) {
    const source = snap(`${window} "Fixture"\n` + Array.from({ length: 50 }, (_, i) => `  ${button} "Item ${i}"`).join('\n') +
      `\n  ${modal} "Edit"\n    ${field} "Name" value="Original" [disabled]`);
    const view = await snapshotView(source, { mode: 'compact', maxChars: 200 });
    assert.ok('observed' in view);
    assert.match(view.observed!.aria, /value="Original" \[disabled\]/);
    assert.match(view.observed!.aria, /"Fixture"/);
    assert.match(view.observed!.aria, /"Edit"/);
  }
});

test('iframe identity and row ancestry survive excerpt selection', async () => {
  const view = await snapshotView(snap('- navigation:\n  - link "Home"\n--- iframe Payments ---\n- table:\n  - row "Order 27":\n    - button "Pay"'),
    { mode: 'compact', maxChars: 90 });
  assert.ok('observed' in view);
  assert.match(view.observed!.aria, /--- iframe Payments ---\n- table:\n  - row "Order 27":\n    - button "Pay"/);
});

test('an open dialog kept past the cap is its own region, not part of the page block before it', async () => {
  const view = await snapshotView(snap('- main:\n  - paragraph: Story 575\n--- open dialog ---\n- dialog "Cookie consent":\n  - button "Necessary Only"', true),
    { mode: 'compact', maxChars: 90 });
  assert.ok('observed' in view);
  assert.match(view.observed!.aria, /--- open dialog ---\n- dialog "Cookie consent":\n  - button "Necessary Only"/);
});

test('tiny budgets never cut labels and explicitly report omitted critical evidence', async () => {
  const view = await snapshotView(snap('- alert: "Important long message"', true), { mode: 'compact', maxChars: 3 });
  assert.ok('observed' in view);
  assert.equal(view.observed!.aria, '');
  assert.equal(view.coverage!.omittedCriticalLines, 1);
  assert.equal(view.coverage!.sourceTruncated, true);
  assert.equal(view.truncated, true);
});

test('smart classification batches all questions and keeps uncertainty separate from observations', async () => {
  let calls = 0;
  const description = await describeSnapshot(evidence, 'Sign in', async (state, questions) => {
    calls++;
    assert.equal((state as { intent: string }).intent, 'Sign in');
    assert.equal(questions.length, 5);
    assert.match(questions[4].instructions, /blocks\[0\]/);
    return { answers: answers([{ probability: .98 }]), tokens: 100 };
  });
  assert.equal(calls, 1);
  assert.equal(description.screen.type, 'authentication');
  assert.equal(description.signals.error.status, 'inconclusive');
  assert.equal(description.signals.blockingDialog.status, 'absent');
  assert.equal(description.signals.loading.status, 'present');
  assert.deepEqual(description.relevance, [.98]);
});

test('low choice confidence and negative judgments on truncated captures stay uncertain', async () => {
  const a = answers(); a[0].confidence = .6;
  const description = await describeSnapshot({ ...evidence, truncated: true }, undefined, async () => ({ answers: a, tokens: 9 }));
  assert.equal(description.screen.type, 'unknown');
  assert.equal(description.signals.blockingDialog.status, 'inconclusive');
  const gateway = answers(); delete gateway[0].confidence;
  assert.equal((await describeSnapshot(evidence, undefined, async () => ({ answers: gateway, tokens: 9 }))).screen.type, 'authentication');
});

test('missing and out-of-range model answers cannot turn into absent signals', async () => {
  for (const a of [answers().slice(0, 2), [answers()[0], {}, { probability: 0 }, { probability: 0 }],
    [answers()[0], { probability: -1 }, { probability: 0 }, { probability: 0 }]]) {
    await assert.rejects(describeSnapshot(evidence, undefined, async () => ({ answers: a, tokens: 9 })));
  }
});

test('smart relevance filters late task evidence and keeps critical context without filling the budget', async () => {
  const source = snap('- main:\n' + Array.from({ length: 1400 }, (_, i) => `  - text: "News ${i}"`).join('\n') +
    '\n  - region "Delivery address":\n    - text: "48 Example Road"\n- alert: "Session expires soon"');
  const view = await snapshotView(source, { mode: 'smart', intent: 'Change the delivery address', maxChars: 3000 }, async (state, intent) => {
    assert.equal(intent, 'Change the delivery address');
    assert.ok(state.blocks.length <= 64);
    assert.ok(state.blocks.length > 1);
    // The classifier sees the full capture, not the output budget's prefix.
    assert.ok(state.blocks.some(b => b.aria.includes('Delivery address')));
    return { screen: { type: 'form', probability: .99, confidence: .99 }, signals: {},
      relevance: state.blocks.map(b => b.aria.includes('Delivery address') ? .79 : .01), tokens: 500 };
  });
  assert.ok('observed' in view);
  assert.match(view.observed!.aria, /Delivery address/);
  assert.match(view.observed!.aria, /48 Example Road/);
  assert.match(view.observed!.aria, /Session expires soon/);
  assert.doesNotMatch(view.observed!.aria, /News/);
  assert.ok(view.observed!.aria.length < 200);
  assert.equal(view.inferred?.selection?.status, 'focused');
  assert.equal(view.coverage!.filteredLines, 1400);
  assert.equal(view.jevTokens, 500);
  assert.equal(view.inferred?.status, 'available');
});

const classifyRegions = (match: (aria: string) => boolean): typeof describeSnapshot => async state => ({
  screen: { type: 'form', probability: .99, confidence: .99 }, signals: {},
  relevance: state.blocks.map(b => match(b.aria) ? .85 : .02), tokens: 100,
});

test('adjacent navigation and form are separate regions even in a short tree', async () => {
  const source = snap('- banner:\n  - navigation:\n    - link "Hotels"\n- search "Journey":\n  - combobox "Origin": Turin\n' +
    '  - combobox "Destination"\n  - button "Search"\n- main:\n  - heading "Recommended trips"\n  - button "Browse offers"\n- alert: "Session expires soon"');
  const view = await snapshotView(source, { mode: 'smart', intent: 'Find journey search controls', maxChars: 6000 },
    classifyRegions(aria => aria.includes('search "Journey"')));
  assert.ok('observed' in view);
  assert.equal(view.observed.aria, '- search "Journey":\n  - combobox "Origin": Turin\n  - combobox "Destination"\n  - button "Search"\n- alert: "Session expires soon"');
  assert.ok(view.coverage.filteredLines > 0);
  assert.equal(view.coverage.omittedCriticalLines, 0);
});

test('heading sections preserve their labels and nested region context without unrelated siblings', async () => {
  const source = snap('- main:\n  - heading "News"\n  - text: "Sale today"\n  - heading "Delivery address"\n' +
    '  - group "Saved addresses":\n    - text: "48 Example Road"\n  - heading "Help"\n  - link "Contact us"');
  const view = await snapshotView(source, { mode: 'smart', intent: 'Read my address' }, classifyRegions(a => a.includes('48 Example Road')));
  assert.ok('observed' in view);
  assert.equal(view.observed.aria, '- main:\n  - heading "Delivery address"\n  - group "Saved addresses":\n    - text: "48 Example Road"');
});

test('named native groups keep unrelated components out of a task-focused view', async () => {
  for (const group of ['AXGroup', 'XCUIElementTypeOther', 'android.view.ViewGroup']) {
    const source = snap(`window "Fixture"\n  ${group} "Navigation"\n    button "Help"\n  ${group} "Address form"\n    text_field "Street" value="48 Example Road"`);
    const view = await snapshotView(source, { mode: 'smart', intent: 'Read the address form' }, classifyRegions(a => a.includes('48 Example Road')));
    assert.ok('observed' in view);
    assert.match(view.observed.aria, /window "Fixture"/);
    assert.match(view.observed.aria, /48 Example Road/);
    assert.doesNotMatch(view.observed.aria, /Navigation|Help/);
  }
});

test('no relevant region returns only critical messages with an explicit no-match result', async () => {
  const view = await snapshotView(snap('- button "Unrelated"\n- alert: "Connection lost"'),
    { mode: 'smart', intent: 'Find the address' }, classifyRegions(() => false));
  assert.ok('observed' in view);
  assert.equal(view.observed.aria, '- alert: "Connection lost"');
  assert.equal(view.inferred?.selection?.status, 'no-confident-match');
  assert.equal(view.inferred?.selection?.matchedRegions, 0);
});

test('region cap is explicit and cannot establish absence from unassessed evidence', async () => {
  const source = snap(Array.from({ length: 100 }, (_, i) => `- region "Section ${i}":\n  - text: "Content ${i}"`).join('\n') + '\n- alert: "Late alert"');
  const view = await snapshotView(source, { mode: 'smart', intent: 'Find something' }, async state => {
    assert.equal(state.blocks.length, 64);
    assert.equal(state.truncated, true);
    assert.ok(state.blocks.some(b => b.aria.includes('Late alert')));
    return classifyRegions(() => false)(state);
  });
  assert.ok('observed' in view);
  assert.equal(view.coverage.unassessedRegions, 37);
  assert.equal(view.observed.aria, '- alert: "Late alert"');
});

test('failed task filtering explicitly falls back to a compact overview', async () => {
  const view = await snapshotView(snap('- button "Retry"'), { mode: 'smart', intent: 'Sign in' }, async () => { throw new Error('offline'); });
  assert.ok('observed' in view);
  assert.equal(view.observed.aria, '- button "Retry"');
  assert.equal(view.inferred?.selection?.status, 'fallback');
});

test('provider failure returns compact evidence with explicit unavailable inference and unknown token usage', async () => {
  const source = snap('- button "Retry"');
  const view = await snapshotView(source, { mode: 'smart' }, async () => { throw new Error('provider offline'); });
  assert.ok('observed' in view);
  assert.equal(view.observed!.aria, source.aria);
  assert.deepEqual(view.inferred, { status: 'unavailable', reason: 'provider offline' });
  assert.equal(view.jevTokens, null);
  const empty = await snapshotView(snap(''), { mode: 'smart' }, async () => { throw new Error('must not call'); });
  assert.ok('observed' in empty);
  assert.equal(empty.jevTokens, 0);
  assert.equal(empty.inferred?.status, 'unavailable');
});

test('snapshot option validation rejects invalid budgets and intent outside smart mode', async () => {
  for (const maxChars of [-1, 0, 1.5, 60001]) await assert.rejects(snapshotView(snap(''), { maxChars }));
  await assert.rejects(snapshotView(snap(''), { mode: 'compact', intent: 'test' }), /requires mode: smart/);
});
