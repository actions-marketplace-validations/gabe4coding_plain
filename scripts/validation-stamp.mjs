// The record that scripts/validate.mjs passed on a given file tree, and the check scripts/pr-gate.mjs makes. The
// stamp holds a git tree hash of the working files (tracked and untracked, ignored files left out), so validating
// before the commit counts once the commit has exactly those files. It lives in the worktree's git dir: never
// committed, one per worktree. Each function takes the checkout to look at (default: the process working
// directory), because a hook can run in another checkout than the one the command targets.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (dir, args, env = process.env) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stampFile = (dir) => git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'plainwright-validated.json']);

/** The tree hash of the working files, from a scratch index so the real index is never touched. */
export function workingTree(dir = process.cwd()) {
  const scratch = mkdtempSync(join(tmpdir(), 'plainwright-stamp-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    git(dir, ['read-tree', 'HEAD'], env);
    git(dir, ['add', '-A'], env);
    return git(dir, ['write-tree'], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const headTree = (dir = process.cwd()) => git(dir, ['rev-parse', 'HEAD^{tree}']);

/** The repository's shared git dir: equal for the main checkout and all its worktrees. */
export const commonDir = (dir = process.cwd()) =>
  git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

export function writeStamp(tree, details, dir = process.cwd()) {
  writeFileSync(stampFile(dir), JSON.stringify({ tree, at: new Date().toISOString(), ...details }, null, 1) + '\n');
}

export function readStamp(dir = process.cwd()) {
  try { return JSON.parse(readFileSync(stampFile(dir), 'utf8')); } catch { return undefined; }
}
