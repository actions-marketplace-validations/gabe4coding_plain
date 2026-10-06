// The routing eval's grader and its cases file, without an agent: scripts/eval-routing.mjs runs the agents only as
// the entry point.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { grade, loadCases } from './eval-routing.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'plain-routing-cases-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Loads `cases` from a file, as the eval loads scripts/routing-cases.json. */
function load(cases) {
  const file = join(scratch, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(cases));
  return loadCases(file);
}

const lockVersion = { id: 'lock-version', expect: ['LOCK_VERSION', 'lock\\.ts'] };

test('an answer passes only when it matches every expect', () => {
  assert.deepEqual(grade(lockVersion, 'Bump `LOCK_VERSION` in `src/core/lock.ts` (CODING_STANDARDS.md).'), []);
  assert.deepEqual(grade(lockVersion, 'Bump LOCK_VERSION so old lock files are ignored.'), ['missing /lock\\.ts/']);
  assert.deepEqual(grade(lockVersion, ''), ['missing /LOCK_VERSION/', 'missing /lock\\.ts/']);
});

test('expect and forbid ignore case', () => {
  assert.deepEqual(grade(lockVersion, 'bump lock_version in Lock.TS'), []);
  const testCase = { id: 'mcp-logging', expect: ['console\\.error'], forbid: ['\\bis fine\\b'] };
  assert.deepEqual(grade(testCase, 'No: log with Console.Error, stdout is the JSON-RPC channel.'), []);
  assert.deepEqual(grade(testCase, 'It IS FINE, or use console.error.'), ['forbidden /\\bis fine\\b/']);
});

test('an invalid regex fails with the case and the pattern', () => {
  assert.throws(() => grade({ id: 'broken', expect: ['lock(\\.ts'] }, 'lock.ts'),
    /routing case "broken": invalid regex \/lock\(\\\.ts\//);
  assert.throws(() => grade({ id: 'broken', expect: ['ok'], forbid: ['[z-a]'] }, 'ok'), /invalid regex \/\[z-a\]\//);
});

test('the cases file has unique ids, a question and an expect per case, and only valid regexes', () => {
  assert.ok(loadCases().length > 0);
});

test('a malformed case fails the load, before any agent runs', () => {
  const ok = { id: 'a', question: 'Q?', expect: ['x'] };
  assert.throws(() => load([ok, { ...ok }]), /routing case "a": needs a unique id/);
  assert.throws(() => load([{ ...ok, id: '' }]), /needs a unique id/);
  assert.throws(() => load([{ ...ok, question: ' ' }]), /routing case "a": needs a question/);
  assert.throws(() => load([{ ...ok, expect: [] }]), /routing case "a": needs an expect/);
  assert.throws(() => load([{ ...ok, forbid: ['('] }]), /routing case "a": invalid regex/);
  assert.throws(() => load([{ ...ok, forbid: 'x' }]), /routing case "a": forbid is a list/);
  assert.throws(() => load([{ ...ok, forbit: ['x'] }]), /routing case "a": unknown key forbit/);
  assert.equal(load([ok]).length, 1);
});

test('notes-over-limit: raising the limit alone does not pass, moving rules to a narrower owner does', () => {
  const testCase = loadCases().find((c) => c.id === 'notes-over-limit');
  assert.notDeepEqual(grade(testCase, 'Raise the limit constant in scripts/check-agent-notes.mjs and say why.'), []);
  assert.notDeepEqual(grade(testCase, 'Split the file into two notes.'), []);
  assert.deepEqual(grade(testCase, 'Remove no-ops, then move each one-folder rule to that folder\'s CLAUDE.md ' +
    '(.claude/skills/writing-agent-notes/SKILL.md, "Size limits"). Raise the limit only as a last step.'), []);
});

test('doc-language: the STE rules of the writing-docs skill pass, under any of their names', () => {
  const testCase = loadCases().find((c) => c.id === 'doc-language');
  assert.deepEqual(grade(testCase, 'The `writing-docs` skill, "Language": at most 25 words per sentence. ' +
    'Run `npm run check:docs`: it enforces the mechanical STE rules.'), []);
  assert.deepEqual(grade(testCase, 'ASD-STE100, in .claude/skills/writing-docs/SKILL.md.'), []);
  assert.notDeepEqual(grade(testCase, 'Use the ASD-STE100 rules.'), []);
  assert.notDeepEqual(grade(testCase, 'Follow the writing-docs skill and keep the sentences short.'), []);
  assert.notDeepEqual(grade(testCase, 'The writing-docs skill: write in a steady style.'), []);
});
