#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ensureDependencies, root, runOrExit } from './install-deps.mjs';
const require = createRequire(import.meta.url);
ensureDependencies('plainwright', ['playwright']);
const { chromium } = await import('playwright');
if (!existsSync(chromium.executablePath())) {
  console.error('plainwright: installing Chromium (first run)…');
  const playwrightRoot = dirname(require.resolve('playwright/package.json'));
  runOrExit('plainwright', process.execPath, [join(playwrightRoot, 'cli.js'), 'install', 'chromium']);
}
await import(pathToFileURL(join(root, 'dist/cli.js')).href);
