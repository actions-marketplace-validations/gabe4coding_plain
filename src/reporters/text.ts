import { formatMs } from '../results.js';
import type { RunObserver, SpecReport } from '../suite-types.js';

// Expected lines from the pre-refactor cli.ts: status icons, counts, step detail, and optional timing.
const icon = (status: string): string => ({ pass: '✔', inconclusive: '?', skipped: '»' })[status] ?? '✘';
const addMs = (target: Record<string, number>, source: Record<string, number>): void => {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
};

export function textReporter(timing: boolean): RunObserver {
  const runMs: Record<string, number> = {};
  return {
    async specEnd({ report }: { report: SpecReport }) {
      const result = report.attempts.at(-1);
      if (!result) {
        console.log(`✘ ${report.file}`);
        console.log(`  error: ${report.loadError ?? 'no result'}`);
        return;
      }
      console.log(`${icon(result.status)} ${report.name}  (${result.jevCalls} Jev calls, ${result.totalTokens} tokens)`);
      const specMs: Record<string, number> = {};
      for (const step of result.steps) {
        console.log(`  ${icon(step.status)} ${step.step}${step.detail ? ' ' + step.detail : ''}`);
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
    async runEnd() { if (timing && Object.keys(runMs).length) console.log(`ms run ${formatMs(runMs)}`); },
  };
}
