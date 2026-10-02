import type { Locator } from 'playwright';
import { judgeState, type Snapshot } from '../core/automation.js';
import { snapshot, snapshotRegion } from './page.js';
import { settlePage, waitHold } from './activity.js';
import { settledAsk } from './settled-ask.js';
import { resolveOne } from './locate.js';
import { timed, type StepContext } from './context.js';

/**
 * What a judgment is about: the snapshot plus the events (downloads, console errors, dialogs) as they were when
 * it was taken. An event that lands while the page settles makes it a different state.
 */
export interface Observed { snap: Snapshot; events: string[] }

interface Judged { state: Observed; probabilities: number[] | null }

const sameObserved = (a: Observed, b: Observed): boolean =>
  a.snap.url === b.snap.url && a.snap.title === b.snap.title && a.snap.aria === b.snap.aria &&
  a.events.length === b.events.length && a.events.every((event, i) => event === b.events[i]);

/** Judges claims against the whole settled page, in one request; null probabilities when `skip` says so. */
export async function judgeSettled(ctx: StepContext, claims: string[], skip?: (observed: Observed) => boolean): Promise<Judged> {
  const { state, result } = await settledAsk(ctx, {
    observe: async () => ({ snap: await timed(ctx, 'snapshot', () => snapshot(ctx.page)), events: [...ctx.events] }),
    same: sameObserved,
    ask: ({ snap, events }) => judgeState(snap, claims, events),
    discard: (unused) => ctx.track(unused.tokens),
    skip,
  });
  if (result) ctx.track(result.tokens);
  return { state, probabilities: result?.probabilities ?? null };
}

/** Judges one claim against a region only; null probabilities when `skip` says so. */
export async function judgeRegion(ctx: StepContext, region: Locator, claim: string, skip: (observed: Observed) => boolean): Promise<Judged> {
  await timed(ctx, 'settle', () => settlePage(ctx.page));
  const snap = await timed(ctx, 'snapshot', () => snapshotRegion(ctx.page, region));
  const state = { snap, events: [...ctx.events] };
  if (skip(state)) return { state, probabilities: null };
  const result = await timed(ctx, 'jev', () => judgeState(snap, [claim], state.events));
  ctx.track(result.tokens);
  return { state, probabilities: result.probabilities };
}

type ClaimsJudgment = { snap: Snapshot; probabilities: number[] } | { detail: string };

/** One judgment of the claims, against the page or the region `within` names (`detail` when Jev finds no region). */
export async function judgeClaims(ctx: StepContext, claims: string[], within?: string): Promise<ClaimsJudgment> {
  if (within) {
    const region = await resolveOne(ctx, 'region', within);
    if (!region.element) return { detail: region.detail };
    const snap = await timed(ctx, 'snapshot', () => snapshotRegion(ctx.page, region.element!));
    const result = await timed(ctx, 'jev', () => judgeState(snap, claims, ctx.events));
    ctx.track(result.tokens);
    return { snap, probabilities: result.probabilities };
  }
  // Settled, because a client-side route change reaches `load` at once and the claim is about the content.
  const { state, probabilities } = await judgeSettled(ctx, claims);
  return { snap: state.snap, probabilities: probabilities! };
}

/** The MCP `ask` tool: one judgment, like expect, but not a step: no status, not recorded. */
export async function askPage(ctx: StepContext, claims: string[], within?: string) {
  ctx.ms = {};
  // A css= region skips settledAsk, which is what waits out the last action's hold.
  if (within?.startsWith('css=')) await timed(ctx, 'settle', () => waitHold(ctx.page));
  return { ...(await judgeClaims(ctx, claims, within)), ms: ctx.ms };
}
