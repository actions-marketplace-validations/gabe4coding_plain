import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as candidatesMod from './candidates.js';
import { CandidateKindSchema, candidates, elementById } from './candidates.js';

test('candidates extract is importable from candidates.ts and does not export frameLabel', () => {
  assert.equal(typeof candidates, 'function');
  assert.equal(typeof elementById, 'function');
  assert.equal(CandidateKindSchema.parse('click'), 'click');
  assert.equal(CandidateKindSchema.parse('region'), 'region');
  assert.equal(Object.hasOwn(candidatesMod, 'frameLabel'), false);
});
