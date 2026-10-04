import type { Page } from 'playwright';
import type { Spec, Step } from '../core/spec.js';
import { timedInto } from '../core/results.js';
import type { PickAttempt } from '../core/pick-cache.js';

/** What a browser step runs against. */
export interface StepContext {
  /** The active page. A popup can replace it mid-run (src/browser/session.ts): read it every time, never keep it. */
  readonly page: Page;
  spec: Spec;
  timeout: number;
  /** Downloads, dialogs and console errors: every judgment sees them. */
  events: string[];
  /** Counts one Jev call and its tokens. */
  track: (tokens: number) => void;
  /** Phase timings of the current step, reset by runStep. */
  ms: Record<string, number>;
  /** This attempt's pick cache; spec runs only, never an MCP session. */
  picks?: PickAttempt;
  /** The step running now: its source and kind key the pick cache. */
  step?: Step;
  /** The interpolated steps after it in a spec run or an MCP batch: an expect asks the next expects' claims too. */
  upcoming?: Step[];
}

/** Adds the time `fn` takes to ctx.ms[phase]. */
export const timed = <T>(ctx: StepContext, phase: string, fn: () => Promise<T>): Promise<T> => timedInto(ctx.ms, phase, fn);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
