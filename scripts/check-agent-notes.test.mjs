// Tests of the agent notes checker: its parsing on the edge cases real notes hold, then the CLI on a throwaway git
// repository whose notes hold one problem of each kind next to valid references.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  baseFolders, citations, codeWords, expandBraces, headings, noteLimit, pathCandidate, resolvePath, symbolRefs,
} from './check-agent-notes.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-agent-notes.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const TOP_LEVEL = new Set(['.claude', 'docs', 'e2e', 'package.json', 'plugins', 'scripts', 'src']);
const FILES = ['CLAUDE.md', 'src/cli.ts', 'src/native/cli.ts', 'src/native/session.ts', 'src/core/evidence.ts',
  'scripts/a.test.mjs', 'scripts/b.test.mjs', 'docs/x.mdx', '.claude/skills/demo/SKILL.md',
  'plugins/plain/bin/npx.mjs'];
const ENTRIES = new Set([...FILES, 'src', 'src/native', 'src/core', 'scripts', 'docs', '.claude', '.claude/skills',
  '.claude/skills/demo', 'plugins', 'plugins/plain', 'plugins/plain/bin']);

/** The entries `path` resolves to from `note`, or null. */
const resolved = (path, note = 'CLAUDE.md', context = []) =>
  resolvePath(path, baseFolders(note, context), ENTRIES)?.matches ?? null;

test('classifies the agent notes and gives each its line limit', () => {
  assert.equal(noteLimit('CLAUDE.md'), 40);
  assert.equal(noteLimit('CODING_STANDARDS.md'), 120);
  assert.equal(noteLimit('src/native/CLAUDE.md'), 60);
  assert.equal(noteLimit('.claude/skills/writing-docs/SKILL.md'), 150);
  for (const other of ['AGENTS.md', 'src/native/AGENTS.md', 'README.md', 'plugins/plain/skills/using-plain/SKILL.md',
    '.claude/skills/a/b/SKILL.md', 'docs/CLAUDE.mdx']) {
    assert.equal(noteLimit(other), undefined, other);
  }
});

test('takes paths from code words, not commands, flags, variables, specifiers or URLs', () => {
  const paths = (text) => text.split(' ').map((word) => pathCandidate(word, TOP_LEVEL)).filter(Boolean);
  assert.deepEqual(paths('node scripts/validate.mjs --only forms'), ['scripts/validate.mjs']);
  assert.deepEqual(paths("node --test 'dist/**/*.test.js' 'scripts/*.test.mjs';"),
    ['dist/**/*.test.js', 'scripts/*.test.mjs']);
  assert.deepEqual(paths('(src/core/lock.ts:12:3), CLAUDE.md. session.ts docs e2e/*.yaml'),
    ['src/core/lock.ts', 'CLAUDE.md', 'session.ts', 'docs', 'e2e/*.yaml']);
  assert.deepEqual(paths('src/{native,computer}/CLAUDE.md .claude/skills/<name>/SKILL.md "<file>.mdx#<old-slug>"'),
    ['src/{native,computer}/CLAUDE.md', '.claude/skills/<name>/SKILL.md', '<file>.mdx']);
  for (const word of ['@gabe4coding/plain@<version>', '${env.site}', '$VAR', '/tmp/x.json', '~/.claude/CLAUDE.md',
    '--only', '-rn', 'https://example.com/a.md', 'node:test', 'test:mods', 'npm', '.md', '`.mdx`,', '`file`,',
    'origin/main...HEAD', 'NativeSession.region(within,', 'plan|do', '#']) {
    assert.equal(pathCandidate(word, TOP_LEVEL), null, word);
  }
});

test('expands brace groups, nested and repeated', () => {
  assert.deepEqual(expandBraces('src/{native,computer,mobile}/CLAUDE.md'),
    ['src/native/CLAUDE.md', 'src/computer/CLAUDE.md', 'src/mobile/CLAUDE.md']);
  assert.deepEqual(expandBraces('{a,b}/{c,d}.ts'), ['a/c.ts', 'a/d.ts', 'b/c.ts', 'b/d.ts']);
  assert.deepEqual(expandBraces('x{a,b{c,d}}y').sort(), ['xay', 'xbcy', 'xbdy']);
  assert.deepEqual(expandBraces('src/{a}/x.ts'), ['src/{a}/x.ts']);
});

test('resolves a path from the nearest base: block folders, the note folder, its ancestors, the root', () => {
  assert.deepEqual(baseFolders('src/native/CLAUDE.md', ['src/core']), ['src/core', 'src/native', 'src', '']);
  assert.deepEqual(resolved('cli.ts', 'src/native/CLAUDE.md'), ['src/native/cli.ts']);
  assert.deepEqual(resolved('core/evidence.ts', 'src/native/CLAUDE.md'), ['src/core/evidence.ts']);
  assert.deepEqual(resolved('src/'), ['src']);
  assert.equal(resolved('cli.ts'), null);
  assert.equal(resolved('bin/npx.mjs'), null);
  assert.deepEqual(resolved('bin/npx.mjs', 'CLAUDE.md', ['plugins/*']), ['plugins/plain/bin/npx.mjs']);
  assert.deepEqual(resolved('../cli.ts', 'src/native/CLAUDE.md'), ['src/cli.ts']);
  assert.equal(resolved('../../outside.ts', 'src/CLAUDE.md'), null);
});

test('matches globs, placeholders and patterns with no fixed folder against the tracked entries', () => {
  assert.deepEqual(resolved('scripts/*.test.mjs'), ['scripts/a.test.mjs', 'scripts/b.test.mjs']);
  assert.deepEqual(resolved('src/**/session.ts'), ['src/native/session.ts']);
  assert.deepEqual(resolved('plugins/*/bin/'), ['plugins/plain/bin']);
  assert.deepEqual(resolved('.claude/skills/<name>/SKILL.md'), ['.claude/skills/demo/SKILL.md']);
  assert.deepEqual(resolved('<file>.mdx'), ['docs/x.mdx']);
  assert.equal(resolved('scripts/*.json'), null);
  assert.equal(resolved('docs/<name>/x.mdx'), null);
});

test('reads the words of inline code, double-backtick spans and fenced blocks, with their line and block', () => {
  const src = [
    'Run `node scripts/a.mjs` then `npm',
    'test`.',
    '',
    '- `src/core/` holds (`automation.ts`) and',
    '  `ask.ts`.',
    '- `other.ts`',
    '| `a.md` | `b.md` |',
    '```bash',
    'npm test   # src/',
    '```',
    'Cite as `` `docs/x.mdx`, "Heading" ``.',
  ].join('\n');
  const words = codeWords(src);
  const at = (word, line) => words.find((entry) => entry.word === word && (!line || entry.line === line));
  assert.deepEqual(words.map(({ word, line }) => [word, line]), [
    ['npm', 9], ['test', 9], ['#', 9], ['src/', 9],
    ['node', 1], ['scripts/a.mjs', 1], ['npm', 1], ['test', 2],
    ['src/core/', 4], ['automation.ts', 4], ['ask.ts', 5], ['other.ts', 6], ['a.md', 7], ['b.md', 7],
    ['`docs/x.mdx`,', 11], ['"Heading"', 11],
  ]);
  assert.equal(at('test', 2).block, at('node').block);
  assert.equal(at('ask.ts').block, at('src/core/').block);
  assert.notEqual(at('other.ts').block, at('ask.ts').block);
  assert.notEqual(at('a.md').block, at('other.ts').block);
  assert.notEqual(at('src/').block, at('b.md').block);
  assert.notEqual(at('"Heading"').block, at('src/').block);
});

test('parses cited sections: comma, section, and, the skill form, parentheses, a line break', () => {
  const src = [
    'See `docs/development.mdx`, "Releases" and "Plugin packaging".',
    'Follow `CODING_STANDARDS.md` section "Tests", "Code", and "Docs".',
    'Owners: the `writing-docs` skill, "Doc owners".',
    'The smoke (`docs/development.mdx`, "Desktop on',
    '  macOS") runs.',
    'Not cited: `CLAUDE.md` is "short", `` `x.md`, "Example" ``, `notes.txt`, "Heading".',
    '```',
    '`y.md`, "Fenced"',
    '```',
  ].join('\n');
  assert.deepEqual(citations(src).map(({ file, heading, line }) => [file, heading, line]), [
    ['docs/development.mdx', 'Releases', 1],
    ['docs/development.mdx', 'Plugin packaging', 1],
    ['CODING_STANDARDS.md', 'Tests', 2],
    ['CODING_STANDARDS.md', 'Code', 2],
    ['CODING_STANDARDS.md', 'Docs', 2],
    ['.claude/skills/writing-docs/SKILL.md', 'Doc owners', 3],
    ['docs/development.mdx', 'Desktop on macOS', 4],
  ]);
});

test('parses named symbols: in, parentheses, dotted names and calls, when the second span is a path', () => {
  const src = [
    'Bump `LOCK_VERSION` in `src/core/lock.ts` and `NativeSession` (`session.ts`).',
    'Then `NativeSession.firstSnapshot` in',
    '`session.ts` and `AppiumAdapter.keyboardShown()` (`adapter.ts`).',
    'Not symbols: `fill` (`password2`, `x.ts`), `goal` in `open`, `a b` in `x.ts`, `` `Name` in `path.ts` ``.',
  ].join('\n');
  assert.deepEqual(symbolRefs(src, TOP_LEVEL).map(({ symbol, path, line }) => [symbol, path, line]), [
    ['LOCK_VERSION', 'src/core/lock.ts', 1],
    ['NativeSession', 'session.ts', 1],
    ['firstSnapshot', 'session.ts', 2],
    ['keyboardShown', 'adapter.ts', 3],
  ]);
});

test('collects heading texts at any level, outside fenced blocks, without closing marks', () => {
  const src = ['---', 'title: X', '---', '# Development', '', '## Plugin packaging ##', '### `save` and C#', '```',
    '# not a heading', '```', '#tag', ''].join('\n');
  assert.deepEqual([...headings(src)], ['Development', 'Plugin packaging', '`save` and C#']);
});

let repo;

/** Write a file of the fixture repository, creating its folders. */
function write(path, text) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** Run the checker on the fixture repository, from another folder. */
function check() {
  const run = spawnSync(process.execPath, [script, '--root', repo], { cwd: tmpdir(), encoding: 'utf8', env });
  const problems = run.stderr.split('\n').filter((line) => /^\S+:\d+: /.test(line));
  return { code: run.status, stdout: run.stdout, problems };
}

/** An engine note of `lines` lines whose first line cites a symbol in a file of its own folder. */
const nestedNote = (lines) => ['`THING` (`thing.ts`) is the constant.', ...Array(lines - 1).fill('- a rule')]
  .join('\n');

before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plain-agent-notes-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  write('.gitignore', 'out/\n');
  write('docs/guide.mdx', '---\ntitle: Guide\n---\n# Guide\n\n## Setup\n');
  write('src/a/thing.ts', 'export const THING = 1;\n');
  write('scripts/run.mjs', '\n');
  write('.claude/skills/demo/SKILL.md', '# Demo\n\n## Rules\n');
  write('CLAUDE.md', [
    'Run `node scripts/run.mjs --only x`, then read `src/a/thing.ts:1` and `src/a/gone.ts`.',
    'Engines: `src/{a,b}/thing.ts`. Build output: `out/**/*.js`.',
    'See `docs/guide.mdx`, "Setup" and "Teardown".',
    'Follow the `demo` skill, "Rules", and the `missing` skill, "Rules".',
    'Bump `THING` in `src/a/thing.ts`, not `OTHER` (`src/a/thing.ts`).',
    '',
    '- `src/a/`: `thing.ts` holds the constant.',
    '',
  ].join('\n'));
  write('src/a/CLAUDE.md', nestedNote(61));
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('reports each problem as path:line: message and exits 1, then passes once the notes are fixed', () => {
  const broken = check();
  assert.equal(broken.code, 1);
  assert.deepEqual(broken.problems, [
    'CLAUDE.md:1: path not found: src/a/gone.ts',
    'CLAUDE.md:2: path not found: src/b/thing.ts (from src/{a,b}/thing.ts)',
    'CLAUDE.md:3: section not found: "Teardown" in docs/guide.mdx',
    'CLAUDE.md:4: path not found: .claude/skills/missing/SKILL.md',
    'CLAUDE.md:5: symbol not found in src/a/thing.ts: OTHER',
    'src/a/CLAUDE.md:61: 61 lines, over the limit of 60: split by when the rule applies: see '
      + '.claude/skills/writing-agent-notes/SKILL.md',
  ]);

  write('CLAUDE.md', [
    'Run `node scripts/run.mjs --only x`, then read `src/a/thing.ts:1`.',
    'Engines: `src/a/{thing.ts,CLAUDE.md}`. Build output: `out/**/*.js`.',
    'See `docs/guide.mdx`, "Setup" and "Guide".',
    'Follow the `demo` skill, "Rules".',
    'Bump `THING` in `src/a/thing.ts`.',
    '',
    '- `src/a/`: `thing.ts` holds the constant.',
    '',
  ].join('\n'));
  write('src/a/CLAUDE.md', nestedNote(60));
  assert.deepEqual(check(), { code: 0, stdout: 'agent notes ok: 3 file(s)\n', problems: [] });
});
