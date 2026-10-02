import { provider, MODEL_BY_PROVIDER, warmUp } from './jev.js';
import { artifactsObserver } from './artifacts.js';
import { createReporters } from './reporters/index.js';
import { select, listSelected } from './select.js';
import { schedule, checkSchedule } from './schedule.js';
import { writeLastRun } from './last-run.js';
import type { Artifact, Attempt, Loaded, RunObserver, RunReport, SpecReport, SuiteEngine, SuiteOptions } from './suite-types.js';

export async function runSuite<S>(engine: SuiteEngine<S>, opts: SuiteOptions,
  services: { provider: typeof provider; warmUp: typeof warmUp; observers?: RunObserver[] } = { provider, warmUp }): Promise<RunReport> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  let chosenProvider = '';
  let model = '';
  const entries: ({ loaded: Loaded<S> } | { report: SpecReport })[] = opts.files.map((file) => {
    try {
      const spec = engine.load(file);
      return { loaded: { file, spec, ...engine.meta(spec) } };
    } catch (error) {
      // `${error}` is what nativeCli printed on stderr (`file: ${error}`); no stdout line.
      return { report: { file, name: file, tags: [], status: 'error', flaky: false, attempts: [], loadError: `${error}` } };
    }
  });
  const selected = select(entries.flatMap((entry) => 'loaded' in entry ? [entry.loaded] : []), opts);
  if (listSelected(selected, opts)) {
    // --list never runs anything, but a spec that does not load is still reported (and fails the command).
    const broken = entries.flatMap((entry) => 'report' in entry ? [entry.report] : []);
    for (const spec of broken) console.error(`✘ ${spec.file}: ${spec.loadError}`);
    return { engine: engine.engine, provider: '', model: '', startedAt, durationMs: Date.now() - start, specs: broken,
      status: broken.length ? 'fail' : 'pass', totals: { jevCalls: 0, tokens: 0, passed: 0, failed: broken.length, flaky: 0, skipped: 0 } };
  }
  if (opts.workers > engine.maxWorkers) throw new Error(`--workers > ${engine.maxWorkers} is not supported for ${engine.engine}`);
  checkSchedule(opts);
  const observers: { name: string; value: RunObserver }[] = [];
  const artifacts = artifactsObserver(opts);
  if (artifacts) observers.push({ name: 'artifacts', value: artifacts });
  observers.push(...(services.observers ?? []).map((value) => ({ name: 'observer', value })));
  observers.push(...createReporters(opts).map((value, i) => ({ name: opts.reporters[i].name, value })));
  const warned = new WeakSet<RunObserver>();
  const call = async <T>(observer: { name: string; value: RunObserver }, method: () => Promise<T>): Promise<T | undefined> => {
    try { return await method(); }
    catch (error) {
      if (!warned.has(observer.value)) {
        warned.add(observer.value);
        console.error(`plainwright: ${observer.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    }
  };
  const emit = async (key: 'runStart' | 'specEnd' | 'runEnd', event: object): Promise<void> => {
    for (const observer of observers) {
      const fn = observer.value[key] as ((event: object) => Promise<unknown>) | undefined;
      if (fn) await call(observer, () => fn(event));
    }
  };
  const reports: SpecReport[] = [];
  try {
    await emit('runStart', { engine: engine.engine, specs: selected.map(({ file, name, tags }) => ({ file, name, tags })) });
    if (selected.length) {
      const p = services.provider();
      chosenProvider = p;
      model = MODEL_BY_PROVIDER[p];
      if (engine.engine === 'browser') console.error(`plainwright: Jev via ${p} (${model})`);
      services.warmUp();
    }
    const scheduled = schedule(selected, opts, async (loaded, attemptNumber): Promise<Attempt> => {
      const began = Date.now();
      const info = { file: loaded.file, name: loaded.name, tags: loaded.tags, attempt: attemptNumber };
      const captured: Artifact[] = [];
      const observer: RunObserver = {
        async sessionOpen(event) {
          for (const item of observers) if (item.value.sessionOpen) await call(item, () => item.value.sessionOpen!(event));
        },
        async stepEnd(event) {
          for (const item of observers) if (item.value.stepEnd) await call(item, () => item.value.stepEnd!(event));
        },
        async sessionClose(event) {
          for (const item of observers) if (item.value.sessionClose) {
            const result = await call(item, () => item.value.sessionClose!(event));
            if (result) captured.push(...result);
          }
          return captured;
        },
      };
      try {
        const result = await engine.run(loaded.spec, observer, info);
        return { ...result, attempt: attemptNumber, durationMs: Date.now() - began, artifacts: captured };
      } catch (error) {
        return { name: loaded.name, status: 'error', steps: [], jevCalls: 0, totalTokens: 0, error: `${error}`,
          attempt: attemptNumber, durationMs: Date.now() - began, artifacts: captured };
      }
    })[Symbol.asyncIterator]();
    for (const entry of entries) {
      let report: SpecReport;
      if ('report' in entry) report = entry.report;
      else {
        if (!selected.includes(entry.loaded)) continue;
        const next = await scheduled.next();
        if (next.done) break;
        report = next.value;
      }
      reports.push(report);
      await emit('specEnd', { report });
    }
  } finally {
    await engine.close?.();
  }
  const totals = { jevCalls: 0, tokens: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const spec of reports) {
    for (const attempt of spec.attempts) { totals.jevCalls += attempt.jevCalls; totals.tokens += attempt.totalTokens; }
    if (spec.status === 'pass') totals.passed++;
    else if (spec.status === 'skipped') totals.skipped++;
    else totals.failed++;
    if (spec.flaky) totals.flaky++;
  }
  // Lane C marks every spec it did not start; the first reason (in input order) names the stop.
  const stopped = reports.find((spec) => spec.skipReason)?.skipReason;
  const report: RunReport = { engine: engine.engine, provider: chosenProvider, model, startedAt,
    durationMs: Date.now() - start, specs: reports, totals, ...(stopped ? { stopped } : {}),
    status: reports.every((spec) => spec.status === 'pass') ? 'pass' : 'fail' };
  await emit('runEnd', { report });
  writeLastRun(process.cwd(), report);
  return report;
}
