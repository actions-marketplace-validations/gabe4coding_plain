export function checkSchedule(opts) {
    if (opts.retries)
        throw new Error('--retries: not implemented yet');
    if (opts.bail)
        throw new Error('--bail: not implemented yet');
    if (opts.maxTokens !== undefined)
        throw new Error('--max-tokens: not implemented yet');
    if (opts.lastFailed)
        throw new Error('--last-failed: not implemented yet');
}
export async function* schedule(specs, opts, runOne) {
    checkSchedule(opts);
    let active = 0;
    const waiting = [];
    const outcomes = specs.map(async (spec) => {
        if (active >= opts.workers)
            await new Promise((resolve) => waiting.push(resolve));
        active++;
        try {
            const attempt = await runOne(spec, 0);
            return { file: spec.file, name: spec.name, tags: spec.tags, status: attempt.status,
                flaky: false, attempts: [attempt] };
        }
        finally {
            active--;
            waiting.shift()?.();
        }
    });
    for (const outcome of outcomes)
        yield await outcome;
}
