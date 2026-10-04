/** setTimeout's largest delay. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * One budget for a whole attempt, opening, setup and observers included; only steps are bounded by what is left.
 * The expiry wraps the step's own handling, so an `optional` step cannot turn it into `skipped`. Teardown and
 * close run outside it, so cleanup finishes after the budget is spent.
 */
export function specDeadline(timeout, started = performance.now()) {
    const end = timeout === undefined ? undefined : started + timeout;
    return {
        async step(run, label) {
            if (end === undefined)
                return run();
            const expired = () => ({ step: label(), status: 'error', detail: `spec timeout after ${timeout} ms` });
            if (performance.now() >= end)
                return expired();
            let timer;
            const limit = new Promise((resolve) => {
                const check = () => {
                    const remaining = end - performance.now();
                    if (remaining <= 0)
                        resolve(expired());
                    else
                        timer = setTimeout(check, Math.min(remaining, MAX_TIMER_MS));
                };
                check();
            });
            try {
                return await Promise.race([run(), limit]);
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
export function checkSpecTimeoutFlag(value) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error('--spec-timeout must be a positive safe integer');
}
