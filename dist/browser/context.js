import { timedInto } from '../core/results.js';
/** Adds the time `fn` takes to ctx.ms[phase]. */
export const timed = (ctx, phase, fn) => timedInto(ctx.ms, phase, fn);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
