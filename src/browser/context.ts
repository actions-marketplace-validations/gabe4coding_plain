import type { Page } from 'playwright';
import type { Spec, Step } from '../core/spec.js';
import { timedInto } from '../core/results.js';
import type { LockAttempt } from '../core/lock.js';
import type { RunValues } from '../core/parameters.js';

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
  /** This attempt's lock (src/core/lock.ts); spec runs only, never an MCP session. */
  lock?: LockAttempt;
  /** The step running now: its source and kind key the lock. */
  step?: Step;
  /** The values this run filled in, written back as placeholders in what the lock records (src/core/parameters.ts). */
  parameters?: RunValues;
  /** What the current step did with the lock, reset by runStep: targets replayed, targets Jev healed. */
  locked?: { replayed: number; healed: number };
  /** The step runs again after it failed with a replayed locator: every target goes to Jev. */
  healing?: boolean;
}

/** Adds the time `fn` takes to ctx.ms[phase]. */
export const timed = <T>(ctx: StepContext, phase: string, fn: () => Promise<T>): Promise<T> => timedInto(ctx.ms, phase, fn);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
