// Checks the user docs against the rules in CLAUDE.md "Documentation": each file compiles as MDX 3 (GFM +
// frontmatter), stays GitHub-safe, follows the mechanical ASD-STE100 rules, and every relative link and heading
// anchor resolves. Links are also checked in the files that point into the docs (benchmarks, skills, CLAUDE.md).
//   node scripts/check-docs.mjs            # all user docs
//   node scripts/check-docs.mjs docs/x.mdx # only these files (links into them are not re-scanned)
import { compile } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import GithubSlugger from 'github-slugger';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir, test) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name), test) : test(e.name) ? [join(dir, e.name)] : []);

const userDocs = [
  join(root, 'README.md'),
  join(root, 'examples/mobile/README.md'),
  ...walk(join(root, 'docs'), (n) => n.endsWith('.mdx')),
];
// Not rewritten to these rules, but their links into the docs must keep working.
const linkOnly = [
  join(root, 'CLAUDE.md'),
  ...walk(join(root, 'docs/benchmarks'), (n) => n.endsWith('.md')),
  ...walk(join(root, 'plugins'), (n) => n.endsWith('.md')).filter((f) => f.includes('/skills/')),
];

const args = process.argv.slice(2).map((f) => resolve(f));
const docs = args.length ? args : userDocs;
const problems = [];
const report = (file, line, message) => problems.push(`${relative(root, file)}${line ? `:${line}` : ''}: ${message}`);

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const FENCE = /^\s*(```|~~~)/;

/** Lines of prose: no frontmatter, fenced code, tables, headings or HTML; inline code and link URLs blanked. */
function proseLines(src) {
  const offset = (FRONTMATTER.exec(src)?.[0].match(/\n/g) ?? []).length;
  let fenced = false;
  return src.replace(FRONTMATTER, '').split('\n').flatMap((raw, i) => {
    if (FENCE.test(raw)) { fenced = !fenced; return []; }
    if (fenced || /^\s*(\||<|#)/.test(raw)) return [];
    return [{ n: i + 1 + offset, raw, text: raw.replace(/`[^`]*`/g, 'X').replace(/\]\([^)]*\)/g, ']').replace(/\*\*/g, '') }];
  });
}

const STE_RULES = [
  [/\b\w+n't\b|\b(it's|you're|we're|they're|that's|there's|let's)\b/i, 'contraction: write the full form ("do not")'],
  [/\b(should|may|might|would|could)\b/i, 'modal verb: use "can", "must" or an imperative'],
  [/\b(please|simply|just|easily|obviously|basically)\b/i, 'filler word'],
  [/;/, 'semicolon: write two sentences'],
  [/\b(e\.g\.|i\.e\.|etc\.)/, 'Latin abbreviation: write "for example" or "that is"'],
];

async function checkDoc(file) {
  const src = readFileSync(file, 'utf8');
  try {
    await compile(src, { remarkPlugins: [remarkGfm, remarkFrontmatter] });
  } catch (error) {
    report(file, error.line, `MDX does not compile: ${error.reason ?? error.message}`);
  }

  if (file.endsWith('.mdx')) {
    const meta = FRONTMATTER.exec(src);
    const data = meta ? parseYaml(meta[1]) : null;
    if (!data?.title || !data?.description) report(file, 1, 'frontmatter needs a title and a description');
    const h1 = /^# (.+)$/m.exec(src.replace(FRONTMATTER, ''))?.[1];
    if (data?.title && h1 !== data.title) report(file, 0, `the H1 must be the frontmatter title "${data.title}"`);
  }

  let fenced = false;
  src.split('\n').forEach((raw, i) => {
    if (FENCE.test(raw)) fenced = !fenced;
    if (fenced) return;
    const line = raw.replace(/`[^`]*`/g, '');
    if (/\{\/\*|<!--/.test(line)) report(file, i + 1, 'comment that GitHub shows as text');
    if (/^(import|export)\s/.test(line)) report(file, i + 1, 'import/export is not GitHub-safe');
    if (/<[A-Z][A-Za-z]*[\s/>]/.test(line)) report(file, i + 1, 'JSX component is not GitHub-safe');
    if (/<https?:/.test(line)) report(file, i + 1, 'autolink: write [text](url)');
  });

  const prose = proseLines(src);
  for (const { n, text } of prose) {
    for (const [pattern, message] of STE_RULES) if (pattern.test(text)) report(file, n, message);
  }
  // A sentence ends at . ! ? or : followed by a space; list items and blank lines also end one.
  const text = prose.map((l) => l.text).join('\n');
  for (const sentence of text.split(/(?<=[.!?:])\s+|\n\s*\n|\n\s*[-*]\s|\n\s*\d+\.\s/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words > 25) report(file, 0, `sentence of ${words} words (max 25): "${sentence.trim().slice(0, 70)}…"`);
  }
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const slugger = new GithubSlugger();
    const anchors = new Set();
    let fenced = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (FENCE.test(line)) fenced = !fenced;
      const heading = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) anchors.add(slugger.slug(heading[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')));
    }
    anchorCache.set(file, anchors);
  }
  return anchorCache.get(file);
}

function checkLinks(file) {
  const src = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of src.matchAll(/\]\(([^)\s]+)\)|(?:src|href)="([^"]+)"/g)) {
    const link = match[1] ?? match[2];
    if (/^[a-z]+:/.test(link)) continue; // http(s), mailto
    const [path, hash] = link.split('#');
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    if (!existsSync(target)) { report(file, 0, `link to a missing file: ${link}`); continue; }
    if (hash && statSync(target).isFile() && /\.mdx?$/.test(target) && !anchorsOf(target).has(hash)) {
      report(file, 0, `link to a missing heading: ${link}`);
    }
  }
}

for (const file of docs) await checkDoc(file);
for (const file of args.length ? docs : [...docs, ...linkOnly]) checkLinks(file);

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s). The rules are in CLAUDE.md, section "Documentation".`);
  process.exit(1);
}
console.log(`docs ok: ${docs.length} file(s)`);
