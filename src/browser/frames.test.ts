import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from 'playwright';
import { frameLabel } from './frames.js';

const frame = (name: string, url: string) => ({ name: () => name, url: () => url }) as unknown as Frame;

test('frameLabel prefers the iframe name, then the URL pathname, then the raw URL', () => {
  assert.equal(frameLabel(frame('checkout', 'https://pay.example/embed/card')), 'checkout');
  assert.equal(frameLabel(frame('', 'https://pay.example/embed/card?x=1')), '/embed/card');
  assert.equal(frameLabel(frame('', 'about:blank')), 'blank');
  assert.equal(frameLabel(frame('', 'not a url')), 'not a url');
  assert.equal(frameLabel(frame('', '')), '');
});
