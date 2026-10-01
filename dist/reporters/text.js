import { formatMs } from '../results.js';
// Expected lines from the pre-refactor cli.ts: status icons, counts, step detail, and optional timing.
const icon = (status) => ({ pass: '✔', inconclusive: '?', skipped: '»' })[status] ?? '✘';
// loadError is `${error}` so native stderr can reprint it. Browser output stays error.message.
function shownLoadError(stored) {
    if (stored === undefined)
        return 'no result';
    const match = /^([A-Za-z_][\w$]*): ([\s\S]*)$/.exec(stored);
    return match && match[1].endsWith('Error') ? match[2] : stored;
}
const addMs = (target, source) => {
    for (const [k, v] of Object.entries(source))
        target[k] = (target[k] ?? 0) + v;
};
export function textReporter(timing) {
    const runMs = {};
    return {
        async specEnd({ report }) {
            const result = report.attempts.at(-1);
            // A spec that failed to load or threw before its first step prints as the old cli.ts did: file + error.
            if (!result || result.error !== undefined) {
                console.log(`✘ ${report.file}`);
                console.log(`  error: ${shownLoadError(result ? result.error : report.loadError)}`);
                return;
            }
            console.log(`${icon(result.status)} ${report.name}  (${result.jevCalls} Jev calls, ${result.totalTokens} tokens)`);
            const specMs = {};
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
        async runEnd() { if (timing && Object.keys(runMs).length)
            console.log(`ms run ${formatMs(runMs)}`); },
    };
}
