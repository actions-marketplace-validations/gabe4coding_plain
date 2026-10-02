import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { RunReport } from './types.js';

const LastRun = z.object({
  schemaVersion: z.literal(1),
  finishedAt: z.iso.datetime(),
  engine: z.enum(['browser', 'desktop', 'mobile']),
  specs: z.array(z.object({
    file: z.string().refine(isAbsolute, 'spec file must be absolute'),
    status: z.enum(['pass', 'fail', 'inconclusive', 'error', 'skipped']),
    flaky: z.boolean(),
  })),
});

export function readLastFailed(cwd: string): Set<string> | undefined {
  const file = join(cwd, '.plainwright', 'last-run.json');
  try {
    const run = LastRun.parse(JSON.parse(readFileSync(file, 'utf8')));
    return new Set(run.specs.filter((spec) => spec.status !== 'pass').map((spec) => spec.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`plainwright: could not read ${file} (${error instanceof Error ? error.message : error}); ignoring previous run`);
    return undefined;
  }
}

export function writeLastRun(cwd: string, report: RunReport): void {
  const dir = join(cwd, '.plainwright');
  const temporary = join(dir, `last-run-${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    const run = { schemaVersion: 1, finishedAt: new Date().toISOString(), engine: report.engine,
      specs: report.specs.map(({ file, status, flaky }) => ({ file: resolve(cwd, file), status, flaky })) };
    writeFileSync(temporary, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, join(dir, 'last-run.json'));
  } catch (error) {
    // Persistence should not turn a completed suite into a usage/config error.
    console.error(`plainwright: could not write last run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* The directory may be unwritable too. */ }
  }
}
