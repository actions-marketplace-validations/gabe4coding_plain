import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function readArtifact(root, directory, input) {
  // Canonicalize both sides: /tmp is a symlink to /private/tmp on macOS.
  const path = realpathSync(resolve(root, input.path));
  const within = relative(realpathSync(directory), path);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error('Only this trial’s browser artifacts are readable');
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  const startLine = input.startLine ?? 0;
  return { totalLines: lines.length, startLine, text: lines.slice(startLine, startLine + (input.lineCount ?? 2000)).join('\n') };
}
