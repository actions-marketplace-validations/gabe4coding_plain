import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as candidatesMod from './candidates.js';
import * as pageMod from './page.js';

test('page.ts re-exports the candidate helpers from candidates.ts, not copies', () => {
  assert.equal(pageMod.candidates, candidatesMod.candidates);
  assert.equal(pageMod.elementById, candidatesMod.elementById);
  assert.equal(pageMod.CandidateKindSchema, candidatesMod.CandidateKindSchema);
  assert.deepEqual(candidatesMod.CandidateKindSchema.options, ['click', 'hover', 'fill', 'select', 'check', 'upload', 'region']);
});
