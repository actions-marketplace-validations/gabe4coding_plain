import type { Attempt, Loaded, SpecReport, SuiteOptions } from './types.js';

export function checkSchedule(opts: SuiteOptions): void {
  for (const [flag, value, min] of [
    ['workers', opts.workers, 1], ['retries', opts.retries, 0], ['bail', opts.bail, 0],
    ['max-tokens', opts.maxTokens, 1],
  ] as const) {
    if (value === undefined && flag === 'max-tokens') continue;
    if (!Number.isSafeInteger(value) || value! < min)
      throw new Error(`--${flag} must be ${min ? 'a positive' : 'a non-negative'} integer`);
  }
}

export async function* schedule<S>(specs: Loaded<S>[], opts: SuiteOptions,
  runOne: (spec: Loaded<S>, attempt: number) => Promise<Attempt>): AsyncIterable<SpecReport> {
  checkSchedule(opts);
  let active = 0;
  let failures = 0;
  let tokens = 0;
  let stopped: SpecReport['skipReason'];
  let aborted = false; // a runOne rejected: the iterator throws, so start nothing more
  const waiting: (() => void)[] = [];
  const outcomes = specs.map(async (spec) => {
    if (active >= opts.workers) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      const report: SpecReport = { file: spec.file, name: spec.name, tags: spec.tags,
        status: 'skipped', flaky: false, attempts: [] };
      // Stop reasons stay stable even when running specs finish after the threshold.
      if (!stopped && opts.bail && failures >= opts.bail) stopped = 'bail';
      if (!stopped && opts.maxTokens !== undefined && tokens >= opts.maxTokens) stopped = 'max-tokens';
      if (stopped) return { ...report, skipReason: stopped };
      if (aborted) return report;

      // A worker keeps this spec for all retries. Bail only prevents new specs;
      // the token budget also prevents retries of specs already started. A spec whose
      // retries were cut keeps its last attempt's status: it ran, so it is not skipped.
      for (let number = 0; number <= opts.retries; number++) {
        if (opts.maxTokens !== undefined && tokens >= opts.maxTokens) {
          stopped ??= 'max-tokens';
          break;
        }
        if (aborted) break;
        let attempt: Attempt;
        try { attempt = await runOne(spec, number); } catch (error) { aborted = true; throw error; }
        report.attempts.push(attempt);
        tokens += attempt.totalTokens;
        report.status = attempt.status;
        if (attempt.status === 'pass') {
          report.flaky = number > 0;
          break;
        }
      }
      // Counts toward --bail. Specs never started return above, so a budget skip never counts.
      if (report.status !== 'pass') failures++;
      return report;
    } finally { active--; waiting.shift()?.(); }
  }).map((outcome) => outcome.then(
    (report) => ({ report }), (error: unknown) => ({ error }),
  ));
  // Attach rejection handlers immediately: a later spec may finish (or reject)
  // while an earlier spec is still running. The suite normally converts throws
  // into error attempts before they reach the scheduler.
  for (const outcome of outcomes) {
    const result = await outcome;
    if ('error' in result) throw result.error;
    yield result.report;
  }
}
