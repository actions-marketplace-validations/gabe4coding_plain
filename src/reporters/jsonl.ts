import type { RunObserver } from '../suite-types.js';

export function jsonlReporter(): RunObserver {
  return { async specEnd({ report }) {
    const attempt = report.attempts.at(-1);
    if (attempt) {
      const { name, status, steps, jevCalls, totalTokens } = attempt;
      console.log(JSON.stringify({ name, status, steps, jevCalls, totalTokens }));
    } else console.log(JSON.stringify({ name: report.name, status: report.status, steps: [], jevCalls: 0, totalTokens: 0, error: report.loadError }));
  } };
}
