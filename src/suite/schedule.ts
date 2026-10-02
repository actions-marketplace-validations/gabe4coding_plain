import type { Attempt, Loaded, SpecReport, StopReason, SuiteOptions } from './types.js';

export function checkSchedule(opts: SuiteOptions): void {
  const limits = [['workers', opts.workers, 1], ['retries', opts.retries, 0], ['bail', opts.bail, 0], ['max-tokens', opts.maxTokens, 1]] as const;
  for (const [flag, value, min] of limits) {
    if (value === undefined && flag === 'max-tokens') continue;
    if (!Number.isSafeInteger(value) || value! < min) throw new Error(`--${flag} must be ${min ? 'a positive' : 'a non-negative'} integer`);
  }
}

/**
 * Runs specs on up to `opts.workers` slots, retrying each until it passes, and yields the reports in input order.
 * A worker keeps a spec for all its retries. `--bail` stops new specs after that many final non-passes; the token
 * budget also stops retries of started specs. Attempts in flight always finish; a spec whose retries were cut keeps
 * its last status, and a spec never started is skipped with the stop reason.
 */
export async function* schedule<S>(specs: Loaded<S>[], opts: SuiteOptions,
  runAttempt: (spec: Loaded<S>, attempt: number) => Promise<Attempt>): AsyncIterable<SpecReport> {
  checkSchedule(opts);
  let active = 0;
  let failures = 0;
  let tokens = 0;
  let stopped: StopReason | undefined;
  /** A runAttempt rejected: the iterator throws, so nothing more starts. */
  let aborted = false;
  const waiting: (() => void)[] = [];
  const overBudget = () => opts.maxTokens !== undefined && tokens >= opts.maxTokens;

  const runWithRetries = async (spec: Loaded<S>): Promise<SpecReport> => {
    if (active >= opts.workers) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      const report: SpecReport = { file: spec.file, name: spec.name, tags: spec.tags, status: 'skipped', flaky: false, attempts: [] };
      // The stop reason stays the first one, even when running specs finish after the threshold.
      if (!stopped && opts.bail && failures >= opts.bail) stopped = 'bail';
      if (!stopped && overBudget()) stopped = 'max-tokens';
      if (stopped) return { ...report, skipReason: stopped };
      if (aborted) return report;

      for (let attemptNumber = 0; attemptNumber <= opts.retries; attemptNumber++) {
        if (overBudget()) {
          stopped ??= 'max-tokens';
          break;
        }
        if (aborted) break;
        let attempt: Attempt;
        try {
          attempt = await runAttempt(spec, attemptNumber);
        } catch (error) {
          aborted = true;
          throw error;
        }
        report.attempts.push(attempt);
        tokens += attempt.totalTokens;
        report.status = attempt.status;
        if (attempt.status === 'pass') {
          report.flaky = attemptNumber > 0;
          break;
        }
      }
      // Counts toward --bail. A spec never started returned above, so a budget skip never counts.
      if (report.status !== 'pass') failures++;
      return report;
    } finally {
      active--;
      waiting.shift()?.();
    }
  };

  // Every outcome is handled at once: a later spec may finish, or reject, while an earlier one still runs.
  const outcomes = specs.map((spec) => runWithRetries(spec).then((report) => ({ report }), (error: unknown) => ({ error })));
  for (const outcome of outcomes) {
    const result = await outcome;
    if ('error' in result) throw result.error;
    yield result.report;
  }
}
