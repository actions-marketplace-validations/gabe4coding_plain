import { writeReport } from './file.js';
export function jsonReporter(file) {
    return { async runEnd({ report }) {
            await writeReport(file, JSON.stringify({ schemaVersion: 1, ...report }, null, 2) + '\n');
        } };
}
