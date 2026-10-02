import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateKindSchema } from './candidates.js';

test('candidate kinds are the element-acting step kinds plus region', () => {
  assert.deepEqual(CandidateKindSchema.options, ['click', 'hover', 'fill', 'select', 'check', 'upload', 'region']);
});
