import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskClaims, askResult, jsonResult } from './mcp-result.js';

test('jsonResult copies JSON.stringify into text and the parsed object into structuredContent', () => {
  const data = { found: false, detail: 'none', extra: undefined };
  const text = JSON.stringify(data);
  const result = jsonResult(data);
  const block = result.content[0];
  assert.equal(block.type, 'text');
  assert.equal(block.type === 'text' ? block.text : '', text);
  assert.equal(text, '{"found":false,"detail":"none"}');
  assert.deepEqual(result.structuredContent, JSON.parse(text));
});

test('jsonResult lets legacyText override the text field', () => {
  const data = { items: [1, 2] };
  const result = jsonResult(data, '[1,2]');
  const block = result.content[0];
  assert.equal(block.type, 'text');
  assert.equal(block.type === 'text' ? block.text : '', '[1,2]');
  assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(data)));
});

// decide(p, 'expect') today: yes at p >= 0.9, no at p <= 0.1, else unsure.
test('askResult maps expect thresholds to yes/no/unsure and includes url and title', () => {
  const result = askResult(
    ['shown', 'hidden', 'maybe', 'at pass', 'at fail', 'below pass', 'above fail'],
    [0.95, 0.05, 0.5, 0.9, 0.1, 0.89, 0.11],
    { url: 'https://example.test/form', title: 'Form', truncated: false },
  );
  assert.deepEqual(result.answers, [
    { claim: 'shown', p: 0.95, answer: 'yes' },
    { claim: 'hidden', p: 0.05, answer: 'no' },
    { claim: 'maybe', p: 0.5, answer: 'unsure' },
    { claim: 'at pass', p: 0.9, answer: 'yes' },
    { claim: 'at fail', p: 0.1, answer: 'no' },
    { claim: 'below pass', p: 0.89, answer: 'unsure' },
    { claim: 'above fail', p: 0.11, answer: 'unsure' },
  ]);
  assert.equal(result.url, 'https://example.test/form');
  assert.equal(result.title, 'Form');
  assert.equal(result.note, undefined);
});

test('askResult rounds p to 3 decimals after decide sees the raw probability', () => {
  const result = askResult(
    ['just under pass', 'just over fail', 'long'],
    [0.8996, 0.1004, 0.123456],
    { url: 'u', title: 't', truncated: false },
  );
  assert.deepEqual(result.answers, [
    { claim: 'just under pass', p: 0.9, answer: 'unsure' },
    { claim: 'just over fail', p: 0.1, answer: 'unsure' },
    { claim: 'long', p: 0.123, answer: 'unsure' },
  ]);
});

test('askResult adds a truncation note only when state.truncated is true', () => {
  const state = { url: 'https://example.test', title: 'Page' };
  const full = askResult(['a'], [0.2], { ...state, truncated: false });
  assert.equal(full.note, undefined);
  const cut = askResult(['a'], [0.2], { ...state, truncated: true });
  assert.equal(cut.note, 'state truncated at 60k chars: a "no" may be content that was cut');
  assert.equal(cut.url, state.url);
  assert.equal(cut.title, state.title);
});

test('AskClaims accepts 1 to 16 non-empty strings', () => {
  assert.equal(AskClaims.safeParse(['one']).success, true);
  assert.equal(AskClaims.safeParse(Array.from({ length: 16 }, (_, i) => `c${i}`)).success, true);
  assert.equal(AskClaims.safeParse([]).success, false);
  assert.equal(AskClaims.safeParse(Array.from({ length: 17 }, (_, i) => `c${i}`)).success, false);
  assert.equal(AskClaims.safeParse(['']).success, false);
});
