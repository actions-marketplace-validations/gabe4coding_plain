import type { StepResult } from './results.js';

/** One monotonic budget for an attempt, including opening, setup, and observer time. */
export function specDeadline(timeout?: number, started = performance.now()) {
  const end = timeout === undefined ? undefined : started + timeout;
  return {
    async step(run: () => Promise<StepResult>, label: () => string): Promise<StepResult> {
      if (end === undefined) return run();
      const expired = (): StepResult => ({ step: label(), status: 'error', detail: `spec timeout after ${timeout} ms` });
      if (performance.now() >= end) return expired();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<StepResult>((resolve) => {
        const check = () => {
          const remaining = end - performance.now();
          if (remaining <= 0) resolve(expired());
          else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
        };
        check();
      });
      try { return await Promise.race([run(), limit]); }
      finally { clearTimeout(timer); }
    },
  };
}
