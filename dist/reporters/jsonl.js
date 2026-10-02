export function jsonlReporter() {
    return { async specEnd({ report }) {
            const attempt = report.attempts.at(-1);
            if (attempt?.error !== undefined)
                console.error(`${report.file}: ${attempt.error}`);
            else if (attempt) {
                const { name, status, steps, jevCalls, totalTokens } = attempt;
                console.log(JSON.stringify({ name, status, steps, jevCalls, totalTokens }));
            }
            else if (report.loadError !== undefined)
                console.error(`${report.file}: ${report.loadError}`);
            else
                console.error(`${report.file}: skipped${report.skipReason ? ` (${report.skipReason})` : ''}`);
        } };
}
