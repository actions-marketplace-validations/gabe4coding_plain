// The record that scripts/validate.mjs passed on a given file tree, and the check scripts/pr-gate.mjs makes. The
// stamp holds a git tree hash of the working files (tracked and untracked, ignored files left out), so validating
// before the commit counts once the commit has exactly those files. It lives in the worktree's git dir: never
// committed, one per worktree.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (args, env = process.env) => execFileSync('git', args, { encoding: 'utf8', env }).trim();
const stampFile = () => git(['rev-parse', '--path-format=absolute', '--git-path', 'plainwright-validated.json']);

/** The tree hash of the working files, from a scratch index so the real index is never touched. */
export function workingTree() {
  const dir = mkdtempSync(join(tmpdir(), 'plainwright-stamp-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    git(['read-tree', 'HEAD'], env);
    git(['add', '-A'], env);
    return git(['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const headTree = () => git(['rev-parse', 'HEAD^{tree}']);

export function writeStamp(tree, details) {
  writeFileSync(stampFile(), JSON.stringify({ tree, at: new Date().toISOString(), ...details }, null, 1) + '\n');
}

export function readStamp() {
  try { return JSON.parse(readFileSync(stampFile(), 'utf8')); } catch { return undefined; }
}
