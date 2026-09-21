// One npm package owns all engines. Plugin hosts copy subdirectories independently, so each
// plugin ships an identical, reproducible runtime tarball built from the root manifest/lockfile.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = mkdtempSync(join(tmpdir(), 'plainwright-package-'));
try {
  const packageDir = join(stage, 'package');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  mkdirSync(join(packageDir, 'bin'));
  copyFileSync(join(root, 'package.json'), join(packageDir, 'package.json'));
  // npm installs honor a published shrinkwrap (package-lock.json alone is ignored in packages).
  copyFileSync(join(root, 'package-lock.json'), join(packageDir, 'npm-shrinkwrap.json'));
  copyFileSync(join(root, 'LICENSE'), join(packageDir, 'LICENSE'));
  for (const name of readdirSync(join(root, 'dist'))) {
    if (name.endsWith('.js') && !name.endsWith('.test.js')) copyFileSync(join(root, 'dist', name), join(packageDir, 'dist', name));
  }
  for (const name of ['plainwright.mjs', 'plainwright-computer.mjs', 'plainwright-mobile.mjs']) copyFileSync(join(root, 'bin', name), join(packageDir, 'bin', name));
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', stage],
    { cwd: packageDir, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, npm_config_cache: join(stage, 'npm-cache') } });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.error}`);
  const archive = join(stage, JSON.parse(packed.stdout)[0].filename);
  for (const name of ['plainwright', 'plainwright-computer', 'plainwright-mobile']) {
    const plugin = join(root, 'plugins', name);
    mkdirSync(join(plugin, 'bin'), { recursive: true });
    copyFileSync(archive, join(plugin, 'runtime.tgz'));
    copyFileSync(join(root, 'scripts/plugin-launcher.mjs'), join(plugin, 'bin/launch.mjs'));
    copyFileSync(join(root, 'LICENSE'), join(plugin, 'LICENSE'));
  }
} finally { rmSync(stage, { recursive: true, force: true }); }
