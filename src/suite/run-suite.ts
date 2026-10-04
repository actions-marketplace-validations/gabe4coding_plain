import { provider, MODEL_BY_PROVIDER } from '../jev/provider.js';
import { warmUp } from '../jev/ask.js';
import { PickStore } from '../core/pick-cache.js';
import { errorMessage } from '../core/results.js';
import { artifactsObserver } from './artifacts.js';
import { createReporters } from './reporters/index.js';
import { select, listSelected } from './select.js';
import { schedule, checkSchedule } from './schedule.js';
import { writeLastRun } from './last-run.js';
import type { Artifact, Attempt, Loaded, RunObserver, RunReport, SpecReport, SuiteEngine, SuiteOptions } from './types.js';

type LoadOutcome<S> = { loaded: Loaded<S> } | { report: SpecReport };
type NamedObserver = { name: string; observer: RunObserver };
type Totals = RunReport['totals'];

export interface SuiteServices { provider: typeof provider; warmUp: typeof warmUp; observers?: RunObserver[] }

/**
 * Loads every spec, selects, then runs the selection through the scheduler and the observers (artifacts,
 * reporters), and records the last run. Results come out in input order; a spec that does not load is always
 * reported. `--list` only lists, before any observer is built or a key is needed, and records nothing.
 * All three engines run through it.
 */
export async function runSuite<S>(engine: SuiteEngine<S>, opts: SuiteOptions, services: SuiteServices = { provider, warmUp }): Promise<RunReport> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const entries = loadAll(engine, opts.files);
  const selected = select(entries.flatMap((entry) => 'loaded' in entry ? [entry.loaded] : []), opts);
  if (listSelected(selected, opts)) return listReport(engine, entries, startedAt, start);

  if (opts.workers > engine.maxWorkers) throw new Error(`--workers > ${engine.maxWorkers} is not supported for ${engine.engine}`);
  checkSchedule(opts);
  const observers = observersFor(engine, opts, services);
  const notify = observerCaller();
  const emit = async (key: 'runStart' | 'specEnd' | 'runEnd', event: object): Promise<void> => {
    for (const observer of observers) {
      const method = observer.observer[key] as ((event: object) => Promise<unknown>) | undefined;
      if (method) await notify(observer, () => method(event));
    }
  };

  let providerName = '';
  let model = '';
  const reports: SpecReport[] = [];
  // One pick cache per run; its sidecars are written once, after the last spec.
  let picks: PickStore | undefined;
  let cachedPicks = 0;
  try {
    await emit('runStart', { engine: engine.engine, specs: selected.map(({ file, name, tags }) => ({ file, name, tags })) });
    if (selected.length) {
      const chosen = services.provider();
      providerName = chosen;
      model = MODEL_BY_PROVIDER[chosen];
      if (engine.engine === 'browser') console.error(`plain: Jev via ${chosen} (${model})`);
      services.warmUp();
      // One model id for both providers: switching provider keeps the sidecars, a model upgrade drops them.
      picks = new PickStore(opts.picks ?? 'on', MODEL_BY_PROVIDER.typesafe);
    }

    const runAttempt = async (loaded: Loaded<S>, attemptNumber: number): Promise<Attempt> => {
      const began = Date.now();
      const handle = picks?.attempt(attemptNumber);
      const info = { file: loaded.file, name: loaded.name, tags: loaded.tags, attempt: attemptNumber, ...(handle ? { picks: handle } : {}) };
      const captured: Artifact[] = [];
      let status = 'error';
      try {
        const result = await engine.run(loaded.spec, sessionObserver(observers, notify, captured), info);
        status = result.status;
        return { ...result, attempt: attemptNumber, durationMs: Date.now() - began, artifacts: captured };
      } catch (error) {
        return { name: loaded.name, status: 'error', steps: [], jevCalls: 0, totalTokens: 0, error: `${error}`,
          attempt: attemptNumber, durationMs: Date.now() - began, artifacts: captured };
      } finally {
        // A passing attempt stores its new picks; a failing one drops the cached picks it used, so Jev judges the retry.
        if (handle) {
          cachedPicks += handle.cachedPicks;
          handle.finish(status === 'pass');
        }
      }
    };

    const scheduled = schedule(selected, opts, runAttempt)[Symbol.asyncIterator]();
    for (const entry of entries) {
      let report: SpecReport;
      if ('report' in entry) {
        report = entry.report;
      } else {
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
  picks?.write();

  // The first spec the scheduler did not start (in input order) names the stop.
  const stopped = reports.find((spec) => spec.skipReason)?.skipReason;
  const report: RunReport = {
    engine: engine.engine,
    provider: providerName,
    model,
    startedAt,
    durationMs: Date.now() - start,
    specs: reports,
    totals: totalsOf(reports, cachedPicks),
    ...(stopped ? { stopped } : {}),
    status: reports.every((spec) => spec.status === 'pass') ? 'pass' : 'fail',
  };
  await emit('runEnd', { report });
  writeLastRun(process.cwd(), report);
  return report;
}

function loadAll<S>(engine: SuiteEngine<S>, files: string[]): LoadOutcome<S>[] {
  return files.map((file) => {
    try {
      const spec = engine.load(file);
      return { loaded: { file, spec, ...engine.meta(spec) } };
    } catch (error) {
      // `${error}` is what the native CLIs printed on stderr (`file: ${error}`).
      return { report: { file, name: file, tags: [], status: 'error', flaky: false, attempts: [], loadError: `${error}` } };
    }
  });
}

/** `--list` runs nothing, but a spec that does not load is still reported, and fails the command. */
function listReport<S>(engine: SuiteEngine<S>, entries: LoadOutcome<S>[], startedAt: string, start: number): RunReport {
  const broken = entries.flatMap((entry) => 'report' in entry ? [entry.report] : []);
  for (const spec of broken) console.error(`✘ ${spec.file}: ${spec.loadError?.replace(/^\w*Error: /, '')}`);
  return {
    engine: engine.engine,
    provider: '',
    model: '',
    startedAt,
    durationMs: Date.now() - start,
    specs: broken,
    status: broken.length ? 'fail' : 'pass',
    totals: { jevCalls: 0, tokens: 0, passed: 0, failed: broken.length, flaky: 0, skipped: 0, cachedPicks: 0 },
  };
}

function observersFor<S>(engine: SuiteEngine<S>, opts: SuiteOptions, services: SuiteServices): NamedObserver[] {
  const observers: NamedObserver[] = [];
  const artifacts = artifactsObserver(opts, engine.engine);
  if (artifacts) observers.push({ name: 'artifacts', observer: artifacts });
  observers.push(...(services.observers ?? []).map((observer) => ({ name: 'observer', observer })));
  observers.push(...createReporters(opts).map((observer, i) => ({ name: opts.reporters[i].name, observer })));
  return observers;
}

type NotifyObserver = <T>(observer: NamedObserver, method: () => Promise<T>) => Promise<T | undefined>;

/** Calls an observer method; a failing observer is reported once and never fails the run. */
function observerCaller(): NotifyObserver {
  const warned = new WeakSet<RunObserver>();
  return async (observer, method) => {
    try {
      return await method();
    } catch (error) {
      if (!warned.has(observer.observer)) {
        warned.add(observer.observer);
        console.error(`plain: ${observer.name}: ${errorMessage(error)}`);
      }
      return undefined;
    }
  };
}

/** One attempt's session events, forwarded to every observer; `sessionClose` collects their artifacts. */
function sessionObserver(observers: NamedObserver[], notify: NotifyObserver, captured: Artifact[]): RunObserver {
  return {
    async sessionOpen(event) {
      for (const item of observers) if (item.observer.sessionOpen) await notify(item, () => item.observer.sessionOpen!(event));
    },
    async stepEnd(event) {
      for (const item of observers) if (item.observer.stepEnd) await notify(item, () => item.observer.stepEnd!(event));
    },
    async sessionClose(event) {
      for (const item of observers) {
        if (!item.observer.sessionClose) continue;
        const artifacts = await notify(item, () => item.observer.sessionClose!(event));
        if (artifacts) captured.push(...artifacts);
      }
      return captured;
    },
  };
}

function totalsOf(reports: SpecReport[], cachedPicks: number): Totals {
  const totals: Totals = { jevCalls: 0, tokens: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, cachedPicks };
  for (const spec of reports) {
    for (const attempt of spec.attempts) {
      totals.jevCalls += attempt.jevCalls;
      totals.tokens += attempt.totalTokens;
    }
    if (spec.status === 'pass') totals.passed++;
    else if (spec.status === 'skipped') totals.skipped++;
    else totals.failed++;
    if (spec.flaky) totals.flaky++;
  }
  return totals;
}
