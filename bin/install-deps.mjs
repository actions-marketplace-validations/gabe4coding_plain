// First-run dependency install shared by the three launchers in bin/. stdout belongs to MCP: npm's output and the
// progress lines go to stderr only.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
export const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
export function runOrExit(name, cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
  if (result.status !== 0) { console.error(`${name}: "${cmd} ${args.join(' ')}" failed`); process.exit(1); }
}
/** Installs the root package's npm dependencies (optional ones too: xa11y) when any of `probes` does not resolve. */
export function ensureDependencies(name, probes) {
  // Resolve normally: npm may hoist dependencies next to the shared runtime package.
  try { for (const probe of probes) require.resolve(probe); return; }
  catch { /* install below */ }
  console.error(`${name}: installing dependencies (first run)…`);
  runOrExit(name, process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', '--ignore-scripts']);
}
