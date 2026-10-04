// npm pack/publish lifecycle for the plain package (package.json "prepack"/"postpack").
//   prepack:  compile a clean dist/, check that the shipped runtime resolves, and add npm-shrinkwrap.json
//   postpack: remove npm-shrinkwrap.json again
// The shrinkwrap is the root lockfile: npm honors it when it installs the published package (a package-lock.json
// is ignored there), so `npx -p @gabe4coding/plain@<version> plain` gets the dependency graph that CI tested.
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shrinkwrap = join(root, 'npm-shrinkwrap.json');
const phase = process.argv[2];

if (phase === 'prepack') {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', root], { stdio: 'inherit' });
  // Every relative import in the shipped runtime must resolve inside the package, to a file: Node ESM does not
  // resolve a bare folder import to its index.js, and a test-only module is not shipped.
  const isFile = (path) => existsSync(path) && statSync(path).isFile();
  const isShipped = (path) => isFile(path) && !path.endsWith('.test.js');
  const shipped = readdirSync(join(root, 'dist'), { recursive: true }).filter((name) => isShipped(join(root, 'dist', name)));
  const missing = shipped.flatMap((name) => {
    const file = join(root, 'dist', name);
    return [...readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)]
      .map((match) => match[1]).filter((spec) => !isShipped(resolve(dirname(file), spec))).map((spec) => `dist/${name} -> ${spec}`);
  });
  if (missing.length) throw new Error(`the package runtime has unresolved imports:\n${missing.join('\n')}`);
  copyFileSync(join(root, 'package-lock.json'), shrinkwrap);
} else if (phase === 'postpack') {
  rmSync(shrinkwrap, { force: true });
} else {
  throw new Error('usage: node scripts/pack.mjs prepack|postpack');
}
