#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
function runOrExit(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
  if (result.status !== 0) { console.error(`plainwright: "${cmd} ${args.join(' ')}" failed`); process.exit(1); }
}
// Resolve normally: npm may hoist dependencies next to the shared runtime package.
try { require.resolve('playwright'); }
catch {
  console.error('plainwright: installing dependencies (first run)…');
  runOrExit(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts']);
}
const { chromium } = await import('playwright');
if (!existsSync(chromium.executablePath())) {
  console.error('plainwright: installing Chromium (first run)…');
  const playwrightRoot = dirname(require.resolve('playwright/package.json'));
  runOrExit(process.execPath, [join(playwrightRoot, 'cli.js'), 'install', 'chromium']);
}
await import(pathToFileURL(join(root, 'dist/cli.js')).href);
