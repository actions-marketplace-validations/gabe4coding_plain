import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AskAnswer, Question } from '../jev/jev.js';
import { readAnswer, READ_LINES } from './read.js';

const snap = (aria: string) => ({ url: 'test://fixture', title: 'Fixture', aria, truncated: false });
const books = [
  '- main:',
  '  - list:',
  '    - listitem:',
  '      - heading "Sharp Objects" [level=3]:',
  '        - link "Sharp Objects":',
  '          - /url: /sharp',
  '      - paragraph: £47.82',
  '    - listitem:',
  '      - heading "Olio" [level=3]:',
  '        - link "Olio":',
  '      - paragraph: £23.88',
].join('\n');

// A fake Jev that answers the first/last-line questions with the lines whose text matches.
function fake(first: RegExp | null, last: RegExp | null = first, seen: { state: any; questions: Question[] }[] = []) {
  return async (state: any, questions: Question[]) => {
    seen.push({ state, questions });
    const pick = (re: RegExp | null): AskAnswer => {
      const line = re && (state.lines as string[]).find((l) => re.test(l));
      const choice = line ? line.split(':')[0] : 'none';
      return { choice, probabilities: { [choice]: 0.97 }, confidence: 0.96 };
    };
    return { tokens: 100, answers: [pick(first), pick(last)] };
  };
}

test('copies the lines between the first and the last pick, verbatim, with ancestors as context', async () => {
  const seen: { state: any; questions: Question[] }[] = [];
  const r = await readAnswer(snap(books), 'the price of Sharp Objects', fake(/"Sharp Objects" \[level/, /£47/, seen));
  assert.equal(r.found, true);
  assert.equal(r.answer, '      - heading "Sharp Objects" [level=3]:\n        - link "Sharp Objects":\n          - /url: /sharp\n      - paragraph: £47.82');
  assert.deepEqual(r.context, ['- main:', '- list:', '- listitem:']);
  // Options: text lines only. Bare containers, /url lines and a link repeating its heading are not offered.
  const options = Object.keys((seen[0].questions[0] as { criteria: Record<string, string> }).criteria);
  assert.deepEqual(options.sort(), ['10', '3', '6', '8', 'none']);
  assert.equal(r.tokens, 100);
});

test('a none or unsure answer is not found and lists guesses', async () => {
  const r = await readAnswer(snap(books), 'the ISBN of Sharp Objects', fake(null));
  assert.equal(r.found, false);
  assert.equal(r.answer, undefined);
  const unsure = async (_state: unknown, questions: Question[]) => ({ tokens: 5, answers: questions.map((): AskAnswer =>
    ({ choice: '3', probabilities: { '3': 0.3, '8': 0.3, none: 0.4 }, confidence: 0.2 })) });
  const u = await readAnswer(snap(books), 'the cheapest book', unsure);
  assert.equal(u.found, false);
  assert.deepEqual(u.guesses?.map((g) => g.line), ['- heading "Sharp Objects" [level=3]:', '- heading "Olio" [level=3]:']);
});

test('a line and its ancestor count as one answer when the probability splits between them', async () => {
  const aria = '- row "Doe Jason $100.00":\n  - cell "Doe Jason":\n  - cell "$100.00"';
  const split = async (_state: unknown, questions: Question[]) => ({ tokens: 5, answers: questions.map((): AskAnswer =>
    ({ choice: '2', probabilities: { '0': 0.45, '2': 0.5, none: 0.05 }, confidence: 0.3 })) });
  const r = await readAnswer(snap(aria), 'the amount due for Jason Doe', split);
  assert.equal(r.found, true);
  assert.equal(r.confidence, 0.95);
});

test('more option lines than one Choice holds are asked in parallel chunks; the sure chunk wins', async () => {
  const aria = Array.from({ length: READ_LINES + 10 }, (_, i) => `- text: item ${i}`).join('\n');
  const seen: { state: any; questions: Question[] }[] = [];
  const r = await readAnswer(snap(aria), 'item 260', fake(/item 260$/, /item 260$/, seen));
  assert.equal(seen.length, 2);
  assert.ok(seen.every((c) => c.state.lines.length <= READ_LINES));
  assert.equal(r.answer, '- text: item 260');
  assert.equal(r.tokens, 200);
});
