import { formatMs } from '../results.js';
import type { RunObserver, SpecReport } from '../suite-types.js';
import type { StepResult } from '../results.js';

// Expected lines from the pre-refactor cli.ts: status icons, counts, step detail, and optional timing.
const icon = (status: string): string => ({ pass: '✔', inconclusive: '?', skipped: '»' })[status] ?? '✘';
export const stepLine = (step: StepResult): string =>
  `  ${icon(step.status)} ${step.step}${step.detail ? ' ' + step.detail : ''}`;
// loadError is `${error}` so native stderr can reprint it. Browser output stays error.message.
function shownLoadError(stored?: string): string {
  if (stored === undefined) return 'no result';
  const match = /^([A-Za-z_][\w$]*): ([\s\S]*)$/.exec(stored);
  return match && match[1].endsWith('Error') ? match[2] : stored;
}
const addMs = (target: Record<string, number>, source: Record<string, number>): void => {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
};

export function textReporter(timing: boolean): RunObserver {
  const runMs: Record<string, number> = {};
  return {
    async specEnd({ report }: { report: SpecReport }) {
      if (report.status === 'skipped' && !report.attempts.length) {
        console.log(`» ${report.file}  (skipped${report.skipReason ? `: ${report.skipReason}` : ''})`);
        return;
      }
      const result = report.attempts.at(-1);
      // A spec that failed to load or threw before its first step prints as the old cli.ts did: file + error.
      if (!result || result.error !== undefined) {
        console.log(`✘ ${report.file}`);
        console.log(`  error: ${shownLoadError(result ? result.error : report.loadError)}`);
        return;
      }
      const flaky = report.flaky ? `flaky, passed on attempt ${result.attempt + 1}; ` : '';
      console.log(`${icon(result.status)} ${report.name}  (${flaky}${result.jevCalls} Jev calls, ${result.totalTokens} tokens)`);
      if (report.flaky) {
        for (const attempt of report.attempts.slice(0, -1)) {
          if (attempt.error !== undefined) console.log(`  attempt ${attempt.attempt + 1}: error: ${shownLoadError(attempt.error)}`);
          for (const step of attempt.steps) {
            if (step.status === 'fail' || step.status === 'inconclusive' || step.status === 'error') {
              console.log(`  attempt ${attempt.attempt + 1}: ${stepLine(step).trimStart()}`);
            }
          }
        }
      }
      const specMs: Record<string, number> = {};
      for (const step of result.steps) {
        console.log(stepLine(step));
        if (timing && step.ms) {
          console.log(`    ms ${formatMs(step.ms)}`);
          addMs(specMs, step.ms);
        }
      }
      if (timing && Object.keys(specMs).length) {
        console.log(`  ms spec ${formatMs(specMs)}`);
        addMs(runMs, specMs);
      }
    },
    async runEnd({ report }) {
      if (timing && Object.keys(runMs).length) console.log(`ms run ${formatMs(runMs)}`);
      // Preserve Phase 0 golden output for ordinary runs; summarize the new retry/stop outcomes.
      const extended = report.specs.some((spec) => spec.flaky || spec.attempts.length > 1 || spec.skipReason);
      // Every spec counts (skipped and load errors too): a bail run is where "1 failed, 5 skipped" matters most.
      if (extended && report.specs.length > 1) {
        const { passed, failed, flaky, skipped, jevCalls, tokens, cachedPicks } = report.totals;
        const cached = cachedPicks ? `, ${cachedPicks} cached pick${cachedPicks === 1 ? '' : 's'}` : '';
        console.log(`${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped  (${jevCalls} Jev calls, ${tokens} tokens${cached}, ${(report.durationMs / 1000).toFixed(2)}s)`);
      }
    },
  };
}
