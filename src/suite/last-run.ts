import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { errorMessage, StatusSchema } from '../core/results.js';
import type { RunReport } from './types.js';

const LastRun = z.object({
  schemaVersion: z.literal(1),
  finishedAt: z.iso.datetime(),
  engine: z.enum(['browser', 'desktop', 'mobile']),
  specs: z.array(z.object({
    file: z.string().refine(isAbsolute, 'spec file must be absolute'),
    status: StatusSchema,
    flaky: z.boolean(),
  })),
});

/** The absolute spec files that did not pass in the last run; `undefined` when there is no record or it is invalid. */
export function readLastFailed(cwd: string): Set<string> | undefined {
  const file = join(cwd, '.plain', 'last-run.json');
  try {
    const run = LastRun.parse(JSON.parse(readFileSync(file, 'utf8')));
    return new Set(run.specs.filter((spec) => spec.status !== 'pass').map((spec) => spec.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`plain: could not read ${file} (${errorMessage(error)}); ignoring previous run`);
    return undefined;
  }
}

/**
 * Replaces `<cwd>/.plain/last-run.json` atomically (temporary file, then rename) with each spec's absolute
 * path, final status and `flaky`. Only a real run writes it: `--list` and `validate` never replace it.
 */
export function writeLastRun(cwd: string, report: RunReport): void {
  const dir = join(cwd, '.plain');
  const temporary = join(dir, `last-run-${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    const run = { schemaVersion: 1, finishedAt: new Date().toISOString(), engine: report.engine,
      specs: report.specs.map(({ file, status, flaky }) => ({ file: resolve(cwd, file), status, flaky })) };
    writeFileSync(temporary, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, join(dir, 'last-run.json'));
  } catch (error) {
    // Persistence should not turn a completed suite into a usage/config error.
    console.error(`plain: could not write last run: ${errorMessage(error)}`);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* The directory may be unwritable too. */ }
  }
}
