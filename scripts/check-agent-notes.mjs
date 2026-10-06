// Checks the agent notes for mechanical decay, so the pull request that renames a path, a heading or a symbol also
// fixes the notes that cite it, and a note that grows past its limit gets split. Agent notes: the root CLAUDE.md,
// CODING_STANDARDS.md, every CLAUDE.md below the root and every .claude/skills/*/SKILL.md that git tracks (a new note
// is covered once it is added). The plugin skills are product docs: check-docs.mjs checks their links.
//   1. size: a note stays within its line limit (the constants below);
//   2. paths: each path in inline code or a fenced block names a tracked file or folder, or one git ignores. A path
//      is relative to the repo root, the note's folder or an ancestor, or a folder cited in the same list item;
//   3. sections: each cited heading (`docs/x.mdx`, "Heading", or the `name` skill, "Heading") exists in that file;
//   4. symbols: each `name` in `path` and `name` (`path`) occurs in that file as a whole word.
//   node scripts/check-agent-notes.mjs              # this checkout
//   node scripts/check-agent-notes.mjs --root <dir> # another checkout
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT_NOTE_LINES = 40;
const STANDARDS_LINES = 120;
const NESTED_NOTE_LINES = 60;
const SKILL_LINES = 150;
const SPLIT_ADVICE = 'split by when the rule applies: see .claude/skills/writing-agent-notes/SKILL.md';
const PATH_EXTENSIONS = ['ts', 'mjs', 'cjs', 'js', 'json', 'md', 'mdx', 'yaml', 'yml', 'sh'];

// A name before the extension, so a bare `.md` (the extension itself) is not a path.
const NAMED_FILE = new RegExp(`[^/]\\.(?:${PATH_EXTENSIONS.join('|')})$`);
const FENCE = /^\s*(```|~~~)/;
// A run of backticks, the content (within one paragraph) and a run of the same length.
const CODE_SPAN = /(?<!`)(`+)(?!`)((?:(?!\n\s*\n)[\s\S])*?[^`])\1(?!`)/g;
const BLOCK_START = /^\s*(?:[-*+]|\d+\.)\s|^\s*[#|]/;
const WILDCARD = /[*<]/;
const GLOB_TOKENS = { '**/': '(?:[^/]+/)*', '/**': '(?:/[^/]+)*', '**': '.*', '*': '[^/]*' };
const IDENT = '[A-Za-z_$][\\w$]*';
const QUOTED = '"[^"]+"';
const CITATION = new RegExp(`(?:\`([^\`\\s]+\\.mdx?)\`|\\b[Tt]he \`([\\w-]+)\` skill)(?:,?\\s+section)?,?\\s+`
  + `(${QUOTED}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${QUOTED})*)`, 'g');
const SYMBOL = new RegExp(`\`(${IDENT}(?:\\.${IDENT})*)(?:\\(\\))?\`\\s+`
  + `(?:in\\s+\`([^\`]+)\`|\\(\`([^\`]+)\`\\))`, 'g');

/** The line limit of `path` (repo-relative) when it is an agent note, else undefined. */
export function noteLimit(path) {
  if (path === 'CLAUDE.md') return ROOT_NOTE_LINES;
  if (path === 'CODING_STANDARDS.md') return STANDARDS_LINES;
  if (path.endsWith('/CLAUDE.md')) return NESTED_NOTE_LINES;
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(path)) return SKILL_LINES;
  return undefined;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** The note with its fenced blocks blanked (every line keeps its number), and the lines inside those blocks. */
function splitFences(src) {
  const fencedLines = [];
  let fenced = false;
  const prose = src.split('\n').map((raw, i) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return '';
    }
    if (fenced) fencedLines.push({ text: raw, line: i + 1 });
    return fenced ? '' : raw;
  }).join('\n');
  return { prose, fencedLines };
}

/** For each line, the index of its Markdown block: a paragraph, a list item, a table row, a heading or a fence. */
function lineBlocks(src) {
  let block = 0;
  let fenced = false;
  let closed = false;
  return src.split('\n').map((raw) => {
    const fence = FENCE.test(raw);
    if (fenced) {
      fenced = !fence;
      closed = fence;
      return block;
    }
    if (closed || fence || !raw.trim() || BLOCK_START.test(raw)) block++;
    closed = false;
    fenced = fence;
    return block;
  });
}

/** Each whitespace-separated word of the inline code spans and fenced blocks, with its line and block. */
export function codeWords(src) {
  const blocks = lineBlocks(src);
  const { prose, fencedLines } = splitFences(src);
  const inline = [...prose.matchAll(CODE_SPAN)].map((m) => ({ text: m[2], line: lineAt(prose, m.index) }));
  const spans = [...fencedLines, ...inline];
  return spans.flatMap(({ text, line }) => [...text.matchAll(/\S+/g)].map((m) => {
    const at = line + lineAt(text, m.index) - 1;
    return { word: m[0], line: at, block: blocks[at - 1] };
  }));
}

/**
 * The path a code word names, or null. Surrounding punctuation, a trailing `:<line>` and a `#anchor` are dropped.
 * Not a path: absolute, a URL or `scheme:` specifier, `$VAR`, `~/…`, a flag, an npm scope. A path starts with a
 * top-level entry of the repo (`topLevel`) or ends in a source or doc extension.
 */
export function pathCandidate(word, topLevel) {
  const path = word.replace(/^[("'`[]+|[)"'`\],.;:!?]+$/g, '').replace(/(?::\d+)+$/, '').replace(/#.*$/, '');
  if (!path || /^[$~@/-]/.test(path) || /^[a-z][\w+.-]*:/i.test(path)) return null;
  return topLevel.has(path.split('/')[0]) || NAMED_FILE.test(path) ? path : null;
}

/** `a{b,c}d` → `abd`, `acd`, nested groups too; a brace group without a comma stays as written. */
export function expandBraces(path) {
  const group = /\{([^{}]*,[^{}]*)\}/.exec(path);
  if (!group) return [path];
  const before = path.slice(0, group.index);
  const after = path.slice(group.index + group[0].length);
  return [...new Set(group[1].split(',').flatMap((part) => expandBraces(before + part + after)))];
}

/** A RegExp for a path with `*`, `**` or `<placeholder>` parts: `**` spans folders, the others stay in a segment. */
function pathPattern(path) {
  const source = path.replace(/\*\*\/|\/\*\*$|\*\*|\*|<[^<>/]*>|[.+?^${}()|[\]\\]/g, (token) =>
    GLOB_TOKENS[token] ?? (token.startsWith('<') ? '[^/]+' : `\\${token}`));
  return new RegExp(`^${source}$`);
}

/**
 * The folders a path in `note` can be relative to, nearest first: `context` (the folders cited in the same block, for
 * a list item that names a folder and then its files), the note's folder, each ancestor, the root.
 */
export function baseFolders(note, context = []) {
  const bases = [...context];
  for (let dir = posix.dirname(note); dir !== '.'; dir = posix.dirname(dir)) bases.push(dir);
  bases.push('');
  return [...new Set(bases)];
}

/**
 * What `path` names from the first base where it names any of `entries` (repo-relative files and folders): the joined
 * path and its matches, or null. A pattern with no literal segment (`*.md`, `<file>.mdx`) can sit in any folder.
 */
export function resolvePath(path, bases, entries) {
  const trimmed = path.replace(/\/+$/, '');
  const anchored = trimmed.split('/').some((segment) => segment && !WILDCARD.test(segment));
  for (const base of anchored ? bases : ['']) {
    const full = anchored ? posix.join(base, trimmed) : `**/${trimmed}`;
    if (full === '..' || full.startsWith('../')) continue;
    if (!WILDCARD.test(full)) {
      if (entries.has(full)) return { full, matches: [full] };
      continue;
    }
    const pattern = pathPattern(full);
    const matches = [...entries].filter((entry) => pattern.test(entry));
    if (matches.length) return { full, matches };
  }
  return null;
}

/** The prose that can cite: no fenced block, no double-backtick span (a literal example that holds backticks). */
function citableProse(src) {
  const blank = (span) => span.replace(/[^\n]/g, ' ');
  return splitFences(src).prose.replace(CODE_SPAN, (span, ticks) => ticks.length > 1 ? blank(span) : span);
}

/** Each heading a note cites: the file as written (a skill's SKILL.md for the skill form), the heading, its line. */
export function citations(src) {
  const prose = citableProse(src);
  return [...prose.matchAll(CITATION)].flatMap((m) => {
    const file = m[1] ?? `.claude/skills/${m[2]}/SKILL.md`;
    const start = m.index + m[0].length - m[3].length;
    return [...m[3].matchAll(/"([^"]+)"/g)].map((q) => ({
      file, skill: !m[1], heading: q[1].replace(/\s+/g, ' ').trim(), line: lineAt(prose, start + q.index),
    }));
  });
}

/**
 * Each `name` in `path` and `name` (`path`) of a note whose second span is a path (see pathCandidate): the last
 * segment of the name, the path, its line.
 */
export function symbolRefs(src, topLevel) {
  const prose = citableProse(src);
  return [...prose.matchAll(SYMBOL)].flatMap((m) => {
    const path = pathCandidate(m[2] ?? m[3], topLevel);
    return path ? [{ symbol: m[1].split('.').pop(), path, line: lineAt(prose, m.index) }] : [];
  });
}

/** The text of each Markdown heading outside fenced blocks, without the `#` marks. */
export function headings(src) {
  return new Set(splitFences(src).prose.split('\n').flatMap((line) => {
    const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    return heading ? [heading[1]] : [];
  }));
}

/**
 * The problems of one note, as { line, message, ignorable }. `ignorable` lists the repo paths an unresolved path can
 * be: the caller drops the problem when git ignores one of them. `repo` holds the tracked `files` and `folders`, the
 * `topLevel` entries and `read(path)`.
 */
function checkNote(note, src, repo) {
  const problems = [];
  const entries = new Set([...repo.files, ...repo.folders]);
  const blocks = lineBlocks(src);
  const lines = src.replace(/\n$/, '').split('\n').length;
  const limit = noteLimit(note);
  if (lines > limit) {
    problems.push({ line: limit + 1, message: `${lines} lines, over the limit of ${limit}: ${SPLIT_ADVICE}` });
  }

  const refs = codeWords(src).flatMap(({ word, line, block }) => {
    const path = pathCandidate(word, repo.topLevel);
    return path ? expandBraces(path).map((expanded) => ({ path, expanded, line, block })) : [];
  });
  const context = new Map();
  for (const ref of refs) {
    ref.found = resolvePath(ref.expanded, baseFolders(note), entries);
    if (ref.found?.matches.every((match) => repo.folders.has(match))) {
      context.set(ref.block, [...context.get(ref.block) ?? [], ref.found.full]);
    }
  }
  const basesAt = (line) => baseFolders(note, context.get(blocks[line - 1]));
  for (const { path, expanded, line, found } of refs) {
    if (found || resolvePath(expanded, basesAt(line), entries)) continue;
    const shown = expanded === path ? path : `${expanded} (from ${path})`;
    const ignorable = basesAt(line).map((base) => posix.join(base, expanded));
    problems.push({ line, message: `path not found: ${shown}`, ignorable });
  }

  for (const { file, skill, heading, line } of citations(src)) {
    const found = resolvePath(file, basesAt(line), entries);
    if (!found) {
      if (skill) problems.push({ line, message: `path not found: ${file}` });
      continue;
    }
    if (!filesOf(found, repo.files).some((path) => headings(repo.read(path)).has(heading))) {
      problems.push({ line, message: `section not found: "${heading}" in ${found.full}` });
    }
  }

  for (const { symbol, path, line } of symbolRefs(src, repo.topLevel)) {
    const found = resolvePath(path, basesAt(line), entries);
    if (!found) continue;
    const word = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`);
    if (!filesOf(found, repo.files).some((file) => word.test(repo.read(file)))) {
      problems.push({ line, message: `symbol not found in ${found.full}: ${symbol}` });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** The tracked files a resolved path covers: the matched files, and every file below a matched folder. */
function filesOf(found, files) {
  const below = (folder) => [...files].filter((file) => file.startsWith(`${folder}/`));
  return found.matches.flatMap((match) => files.has(match) ? [match] : below(match));
}

/** The tracked entries of the checkout, split into files and folders (a symlink to a folder counts as a folder). */
function trackedEntries(root) {
  const files = new Set();
  const folders = new Set();
  for (const path of execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0')) {
    const stat = path && statSync(join(root, path), { throwIfNoEntry: false });
    if (!stat) continue;
    (stat.isDirectory() ? folders : files).add(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return { files, folders, topLevel: new Set([...files, ...folders].map((path) => path.split('/')[0])) };
}

/** The subset of `paths` git ignores, in one call. */
function ignoredPaths(root, paths) {
  if (!paths.length) return new Set();
  const run = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--stdin', '-z'],
    { input: `${paths.join('\0')}\0`, encoding: 'utf8' });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore failed: ${run.stderr}`);
  return new Set(run.stdout.split('\0').filter(Boolean));
}

function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' } } });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) cache.set(path, readFileSync(join(root, path), 'utf8'));
    return cache.get(path);
  };
  const repo = { ...trackedEntries(root), read };
  const notes = [...repo.files].filter((path) => noteLimit(path) !== undefined).sort();
  const reported = notes.flatMap((note) => checkNote(note, read(note), repo).map((problem) => ({ note, ...problem })));
  const ignorable = new Set(reported.flatMap((problem) => problem.ignorable ?? []));
  const ignored = ignoredPaths(root, [...ignorable].filter((path) => !path.startsWith('../')));
  const problems = [...new Set(reported
    .filter((problem) => !problem.ignorable?.some((path) => ignored.has(path)))
    .map(({ note, line, message }) => `${note}:${line}: ${message}`))];

  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s) in the agent notes.`);
    process.exit(1);
  }
  console.log(`agent notes ok: ${notes.length} file(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
