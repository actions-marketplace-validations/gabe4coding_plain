import type { RunObserver } from '../types.js';
import { writeReport } from './file.js';

export function jsonReporter(file: string): RunObserver {
  return { async runEnd({ report }) {
    await writeReport(file, JSON.stringify({ schemaVersion: 1, ...report }, null, 2) + '\n');
  } };
}
