#!/usr/bin/env node
// Removes each compiled file in dist/ whose source in src/ is gone (a deleted or renamed module), so `npm test`
// does not run a stale test. tsc never deletes output. Pruning after tsc, instead of removing dist/ before it, keeps
// dist/ whole while it compiles: a run of this checkout can still import its modules. Part of `npm run build`.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (existsSync(dist)) {
  for (const name of readdirSync(dist, { recursive: true })) {
    if (name.endsWith('.js') && !existsSync(join(root, 'src', name.replace(/\.js$/, '.ts')))) rmSync(join(dist, name));
  }
}
