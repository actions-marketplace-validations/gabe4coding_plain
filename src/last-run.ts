import type { RunReport } from './suite-types.js';

export function readLastFailed(_cwd: string): Set<string> | undefined { return undefined; }
export function writeLastRun(_cwd: string, _report: RunReport): void {}
