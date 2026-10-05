import type { Locator } from 'playwright';
import { judgeState, type Snapshot } from '../core/automation.js';
import { snapshot, snapshotRegion } from './page.js';
import { settledAsk } from './settled-ask.js';
import { resolveOne } from './locate.js';
import { timed, type StepContext } from './context.js';
import { needsLayout, prepareEvidence } from './evidence.js';
import { StepKind } from '../core/step-kind.js';
import { layoutSnapshot } from './layout.js';
import { sha256 } from '../core/lock.js';
import { parameterize, type RunValues } from '../core/parameters.js';
import { layoutRelations } from '../core/layout.js';

/**
 * What a judgment is about: the snapshot plus the events (downloads, console errors, dialogs) as they were when
 * it was taken. An event that lands while the page settles makes it a different state.
 */
export interface Observed { snap: Snapshot; events: string[] }

/** `spatial`: the observation carried rendered geometry, as the lock must record. */
interface Judged { state: Observed; probabilities: number[] | null; spatial: boolean }

const sameObserved = (a: Observed, b: Observed): boolean =>
  a.snap.url === b.snap.url && a.snap.title === b.snap.title && a.snap.aria === b.snap.aria && a.snap.layout === b.snap.layout &&
  a.events.length === b.events.length && a.events.every((event, i) => event === b.events[i]);

/** Judges claims against the whole settled page, in one request; null probabilities when `skip` says so. */
export async function judgeSettled(ctx: StepContext, claims: string[], skip?: (observed: Observed) => boolean): Promise<Judged> {
  const spatial = await needsLayout(ctx, claims);
  return judgeObservation(ctx, claims, spatial, undefined, skip);
}

/** What a judgment sees: the page or the region, its geometry when spatial, and the events so far. */
export async function observe(ctx: StepContext, spatial: boolean, within?: Locator): Promise<Observed> {
  return { snap: await timed(ctx, 'snapshot', async () => {
    const page = ctx.page;
    const snap = await (within ? snapshotRegion(page, within) : snapshot(page));
    return spatial ? { ...snap, layout: await layoutSnapshot(page, within) } : snap;
  }), events: [...ctx.events] };
}

/**
 * The recorded form of a judged state (src/core/lock.ts): a hash, so no page text lands in the lock. Without the
 * origin and the query, and without where a download was saved (a fresh temp folder per run): a lock recorded on
 * one host or port replays on another. A spatial claim keeps the layout's relations, not its bounds: a bound moves
 * by a point between two renders of the same screen. The run's values are placeholders in it: a page that shows this run's title
 * where the recorded run showed its own is the same state.
 */
export function stateHash({ snap, events }: Observed, parameters: RunValues = []): string {
  const generic = (text: string) => parameterize(text, parameters);
  return sha256(JSON.stringify([generic(pathOf(snap.url)), generic(snap.title), generic(snap.aria),
    snap.layout === undefined ? null : generic(layoutRelations(snap.layout)), events.map((event) => generic(event.replace(SAVED_TO, '$1')))]));
}

const SAVED_TO = /^(download: .*?) saved to .*$/s;

/** Decoded, so a run value in the path (`/events/Plain%205678`) becomes its placeholder too. */
function pathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

async function judgeObservation(ctx: StepContext, claims: string[], spatial: boolean, within?: Locator,
  skip?: (observed: Observed) => boolean): Promise<Judged> {
  const { state, result } = await settledAsk(ctx, {
    // A scoped region can live in a shadow root, outside the main document's mutation observer.
    reobserve: spatial || within !== undefined,
    observe: () => observe(ctx, spatial, within),
    same: sameObserved,
    ask: ({ snap, events }) => judgeState(snap, claims, events),
    discard: (unused) => ctx.track(unused.tokens),
    skip,
  });
  if (result) ctx.track(result.tokens);
  return { state, probabilities: result?.probabilities ?? null, spatial };
}

/** Judges one claim against a region only; null probabilities when `skip` says so. */
export async function judgeRegion(ctx: StepContext, region: Locator, claim: string, skip: (observed: Observed) => boolean): Promise<Judged> {
  const spatial = await needsLayout(ctx, [claim]);
  return judgeObservation(ctx, [claim], spatial, region, skip);
}

type ClaimsJudgment = { snap: Snapshot; probabilities: number[]; state: Observed; spatial: boolean } | { detail: string };

/** One judgment of the claims, against the page or the region `within` names (`detail` when Jev finds no region). */
export async function judgeClaims(ctx: StepContext, claims: string[], within?: string): Promise<ClaimsJudgment> {
  // The claims and the region are queued together, so one request routes both (MCP `ask` is not a step).
  prepareEvidence(ctx, [{ kind: StepKind.expect, expectations: claims, within }]);
  if (within) {
    const region = await resolveOne(ctx, 'region', within);
    if (!region.element) return { detail: region.detail };
    const spatial = await needsLayout(ctx, claims);
    const { state, probabilities } = await judgeObservation(ctx, claims, spatial, region.element!);
    return { snap: state.snap, probabilities: probabilities!, state, spatial };
  }
  // Settled, because a client-side route change reaches `load` at once and the claim is about the content.
  const { state, probabilities, spatial } = await judgeSettled(ctx, claims);
  return { snap: state.snap, probabilities: probabilities!, state, spatial };
}

/** The MCP `ask` tool: one judgment, like expect, but not a step: no status, not recorded. */
export async function askPage(ctx: StepContext, claims: string[], within?: string) {
  ctx.ms = {};
  const judged = await judgeClaims(ctx, claims, within);
  return 'detail' in judged ? { ...judged, ms: ctx.ms } : { snap: judged.snap, probabilities: judged.probabilities, ms: ctx.ms };
}
