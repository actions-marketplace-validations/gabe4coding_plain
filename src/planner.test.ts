import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, candidates, readings, spans, keysFrom, type Ask } from './planner.js';
import type { AskAnswer, Question } from './jev.js';

test('keysFrom maps spoken keys to Playwright names', () => {
  assert.equal(keysFrom('command S'), 'Meta+s');
  assert.equal(keysFrom('the enter key'), 'Enter');
  assert.equal(keysFrom('control shift tab'), 'Control+Shift+Tab');
});

test('candidates: sentence ends and sequencing words split in code, "and" and commas are left to Jev', () => {
  const parts = candidates('Open TextEdit. Type milk and eggs in the body, then press enter. Mail tom@example.com');
  assert.deepEqual(parts.map((p) => p.piece), ['Open TextEdit', 'Type milk and eggs in the body', 'press enter', 'Mail tom@example.com']);
  assert.equal(parts[1].cuts.length, 1);
  assert.deepEqual(readings(parts[1].piece, parts[1].cuts), [['Type milk and eggs in the body'], ['Type milk', 'eggs in the body']]);
});

test('spans are every run of consecutive words, punctuation trimmed', () => {
  assert.deepEqual(spans('Click OK.'), ['Click', 'OK', 'Click OK']);
});

// Answers questions by matching their instructions; every choice defaults to its first option.
function fake(rules: [RegExp, (q: Question) => AskAnswer][]): Ask & { calls: number } {
  const ask = async (_state: unknown, questions: Question[]) => {
    ask.calls++;
    return { tokens: 10, answers: questions.map((q) => {
      const rule = rules.find(([re]) => re.test(q.instructions));
      if (rule) return rule[1](q);
      return q.kind === 'choice' ? { choice: 'none', probabilities: {}, confidence: 1 } : { probability: 0 };
    }) };
  };
  ask.calls = 0;
  return ask;
}
const option = (q: Question, text: string): AskAnswer => {
  const key = Object.entries(q.kind === 'choice' ? q.criteria : {}).find(([, v]) => v === text)?.[0];
  assert.ok(key, `no option "${text}"`);
  return { choice: key, probabilities: { [key]: 0.6 }, confidence: 0.3 }; // low confidence: spans overlap, still taken
};

test('plan: picks a reading, routes each piece and copies its arguments verbatim', async () => {
  const ask = fake([
    [/Which reading/, (q) => option(q, '1. type salt and pepper in the box  2. press enter')],
    [/What does `segments\[0\]`/, () => ({ choice: 'fill', probabilities: { fill: 1 }, confidence: 1 })],
    [/What does `segments\[1\]`/, () => ({ choice: 'press', probabilities: { press: 1 }, confidence: 1 })],
    [/segments\[0\].*control or field/, (q) => option(q, 'the box')],
    [/segments\[0\].*text to type/, (q) => option(q, 'salt and pepper')],
    [/segments\[1\].*key or shortcut/, (q) => option(q, 'enter')],
  ]);
  const { items, tokens } = await plan('type salt and pepper in the box and press enter', ask);
  assert.deepEqual(items, [
    { kind: 'step', step: { fill: { target: 'the box', value: 'salt and pepper' } }, risky: false },
    { kind: 'step', step: { press: 'Enter' }, risky: false },
  ]);
  assert.equal(ask.calls, 2); assert.equal(tokens, 20);
});

test('plan: no ambiguous boundary skips the split request; unsure and other actions are reported, not guessed', async () => {
  const ask = fake([[/What does/, () => ({ choice: 'other', probabilities: { other: 0.9 }, confidence: 0.9 })]]);
  const { items } = await plan('Delete the selected email', ask);
  assert.equal(ask.calls, 1);
  assert.deepEqual(items, [{ kind: 'unknown', text: 'Delete the selected email', reason: 'say which button or key does it' }]);
  const unsure = fake([[/What does/, () => ({ choice: 'click', probabilities: { click: 0.4 }, confidence: 0.2 })]]);
  assert.equal((await plan('Maybe the thing', unsure)).items[0].kind, 'unknown');
});
