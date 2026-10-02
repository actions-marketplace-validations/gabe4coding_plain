/** One monotonic budget for an attempt, including opening, setup, and observer time. */
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
                        timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
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
