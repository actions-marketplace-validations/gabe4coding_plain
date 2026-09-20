#!/usr/bin/env node
// Generated into both plugins by build-plugins.mjs. Native/browser dependencies belong to
// the single root npm package in runtime.tgz; this is only an install/cache entrypoint.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).name;
if (!['plainwright', 'plainwright-computer'].includes(name)) throw new Error(`Unknown plugin ${name}`);
const archive = join(root, 'runtime.tgz');
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
const cache = join(root, '.runtime', hash);
const installed = join(cache, 'node_modules/plainwright');
const marker = join(cache, '.installed');
if (!existsSync(marker) || !existsSync(join(installed, 'dist/cli.js'))) {
  mkdirSync(cache, { recursive: true });
  console.error(`${name}: installing shared runtime (first run)…`);
  // stdin/stdout belong to MCP; npm's output goes exclusively to stderr.
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', cache, '--no-save', '--package-lock=false', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', archive],
    { cwd: cache, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
  if (result.status !== 0) { console.error(`${name}: runtime installation failed`); process.exit(1); }
  writeFileSync(marker, hash);
}
await import(pathToFileURL(join(installed, 'bin', `${name}.mjs`)).href);
