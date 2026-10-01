import type { RunObserver } from '../suite-types.js';

export function jsonlReporter(): RunObserver {
  return { async specEnd({ report }) {
    const attempt = report.attempts.at(-1);
    if (attempt?.error !== undefined) console.error(`${report.file}: ${attempt.error}`);
    else if (attempt) {
      const { name, status, steps, jevCalls, totalTokens } = attempt;
      console.log(JSON.stringify({ name, status, steps, jevCalls, totalTokens }));
    } else console.error(`${report.file}: ${report.loadError}`);
  } };
}
