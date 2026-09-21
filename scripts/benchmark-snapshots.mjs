// Projection microbenchmark: synthetic captures, no browser/device work or agent task execution.
// Build first. --live-jev adds real classification calls using the CLI's env precedence.
import { existsSync } from 'node:fs';
import { snapshotView } from '../dist/snapshot-view.js';
import { describeSnapshot, USER_ENV_FILE } from '../dist/jev.js';

const live = process.argv.includes('--live-jev');
if (live) for (const path of ['.env', USER_ENV_FILE]) if (existsSync(path)) process.loadEnvFile(path);
const fixtures = [
  { name: 'small-form', intent: 'Sign in', expected: ['Email', 'Continue'], aria:
    '- main:\n  - heading "Sign in"\n  - generic:\n    - textbox "Email"\n    - textbox "Password"\n    - button "Continue" [disabled]' },
  { name: 'late-dialog', intent: 'Dismiss the expired session dialog', expected: ['Session expired', 'Sign in again'], aria:
    '- main:\n' + Array.from({ length: 1000 }, (_, i) => `  - button "Item ${i}"`).join('\n') +
    '\n- dialog "Session expired":\n  - alert: "Sign in again"\n  - button "Continue"' },
  { name: 'late-task-region', intent: 'Change the delivery address', expected: ['Delivery address', 'Street'], aria:
    '- main:\n' + Array.from({ length: 1000 }, (_, i) => `  - text: "News item ${i}"`).join('\n') +
    '\n  - region "Delivery address":\n    - textbox "Street"\n    - button "Save address"' },
  { name: 'late-task-data', intent: 'Read the current delivery address', expected: ['Delivery address', '48 Example Road'], aria:
    '- main:\n' + Array.from({ length: 1000 }, (_, i) => `  - text: "News item ${i}"`).join('\n') +
    '\n  - region "Delivery address":\n    - text: "48 Example Road"' },
];
const rows = [];
const fixtureName = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
if (fixtureName && !fixtures.some(f => f.name === fixtureName)) throw new Error(`Unknown fixture: ${fixtureName}`);
for (const fixture of fixtures.filter(f => !fixtureName || f.name === fixtureName)) {
  const snap = { url: 'fixture://snapshot-benchmark', title: fixture.name, aria: fixture.aria, truncated: false };
  for (const mode of live ? ['raw', 'compact', 'smart'] : ['raw', 'compact']) {
    const start = performance.now();
    let regionRelevance;
    // Same evidence budget isolates selection quality from different mode defaults.
    const view = await snapshotView(snap, { mode, maxChars: 6000, ...(mode === 'smart' ? { intent: fixture.intent } : {}) }, async (state, intent) => {
      const result = await describeSnapshot(state, intent);
      regionRelevance = result.relevance;
      return result;
    });
    const aria = mode === 'raw' ? view.aria : view.observed.aria;
    rows.push({ fixture: fixture.name, mode, responseChars: JSON.stringify(view).length,
      evidenceChars: aria.length, retainedExpectedText: fixture.expected.filter(text => aria.includes(text)).length,
      expectedTextCount: fixture.expected.length, jevTokens: view.jevTokens ?? (mode === 'smart' ? null : 0),
      elapsedMs: Math.round(performance.now() - start), inferenceStatus: view.inferred?.status,
      screen: view.inferred?.screen, signals: view.inferred?.signals,
      regionRelevance, selection: view.inferred?.selection, filteredLines: view.coverage?.filteredLines,
      inferenceReason: view.inferred?.reason });
  }
}
console.log(JSON.stringify({ liveJev: live, evidenceBudget: 6000, rows }, null, 2));
