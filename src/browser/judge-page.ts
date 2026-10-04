import type { Locator } from 'playwright';
import { judgeState, type Snapshot } from '../core/automation.js';
import { snapshot, snapshotRegion } from './page.js';
import { settledAsk } from './settled-ask.js';
import { resolveOne } from './locate.js';
import { timed, type StepContext } from './context.js';
import { needsLayout, prepareEvidence } from './evidence.js';
import { StepKind } from '../core/step-kind.js';
import { layoutSnapshot } from './layout.js';

/**
 * What a judgment is about: the snapshot plus the events (downloads, console errors, dialogs) as they were when
 * it was taken. An event that lands while the page settles makes it a different state.
 */
export interface Observed { snap: Snapshot; events: string[] }

interface Judged { state: Observed; probabilities: number[] | null }

/**
 * Answers an earlier expect's request gave for the claims of the expects right after it (lookahead), with the exact
 * observation they are about. A later expect uses them only when its own settled observation is the same: then Jev
 * would get the same input, so the request is skipped. Otherwise it asks as usual.
 */
interface Prefetched { observed: Observed; spatial: boolean; probabilities: Map<string, number> }
const prefetched = new WeakMap<StepContext, Prefetched>();
type Judgment = { probabilities: number[]; tokens: number; reused?: boolean };

const sameObserved = (a: Observed, b: Observed): boolean =>
  a.snap.url === b.snap.url && a.snap.title === b.snap.title && a.snap.aria === b.snap.aria && a.snap.layout === b.snap.layout &&
  a.events.length === b.events.length && a.events.every((event, i) => event === b.events[i]);

/**
 * Judges claims against the whole settled page, in one request; null probabilities when `skip` says so. `ahead`:
 * claims of later expects, asked in the same request for them to reuse.
 */
export async function judgeSettled(ctx: StepContext, claims: string[], skip?: (observed: Observed) => boolean,
  ahead: string[] = []): Promise<Judged> {
  const spatial = await needsLayout(ctx, claims);
  return judgeObservation(ctx, claims, spatial, undefined, skip, ahead);
}

/** The claims of the whole-page expects right after this one that share its route, for one request with it. */
async function claimsAhead(ctx: StepContext, claims: string[]): Promise<string[]> {
  const ahead: string[] = [];
  const spatial = await needsLayout(ctx, claims);
  for (const step of ctx.upcoming ?? []) {
    if (step.kind !== StepKind.expect || step.within !== undefined) break;
    if (await needsLayout(ctx, step.expectations) !== spatial) break;
    ahead.push(...step.expectations.filter((claim) => !claims.includes(claim) && !ahead.includes(claim)));
  }
  return ahead;
}

function reuse(ctx: StepContext, observed: Observed, claims: string[], spatial: boolean): Judgment | null {
  const known = prefetched.get(ctx);
  if (!known || known.spatial !== spatial || !sameObserved(known.observed, observed)) return null;
  if (!claims.every((claim) => known.probabilities.has(claim))) return null;
  return { probabilities: claims.map((claim) => known.probabilities.get(claim)!), tokens: 0, reused: true };
}

async function judgeObservation(ctx: StepContext, claims: string[], spatial: boolean, within?: Locator,
  skip?: (observed: Observed) => boolean, ahead: string[] = []): Promise<Judged> {
  const { state, result } = await settledAsk(ctx, {
    // A scoped region can live in a shadow root, outside the main document's mutation observer.
    reobserve: spatial || within !== undefined,
    observe: async () => ({ snap: await timed(ctx, 'snapshot', async () => {
      const page = ctx.page;
      const snap = await (within ? snapshotRegion(page, within) : snapshot(page));
      return spatial ? { ...snap, layout: await layoutSnapshot(page, within, { compact: true }) } : snap;
    }), events: [...ctx.events] }),
    same: sameObserved,
    ask: async (observed): Promise<Judgment> => {
      const known = within ? null : reuse(ctx, observed, claims, spatial);
      if (known) return known;
      const asked = [...claims, ...ahead];
      const result = await judgeState(observed.snap, asked, observed.events);
      if (ahead.length) prefetched.set(ctx, { observed, spatial, probabilities: new Map(asked.map((claim, i) => [claim, result.probabilities[i]])) });
      return { probabilities: result.probabilities.slice(0, claims.length), tokens: result.tokens };
    },
    discard: (unused) => { if (!unused.reused) ctx.track(unused.tokens); },
    skip,
  });
  if (result && !result.reused) ctx.track(result.tokens);
  return { state, probabilities: result?.probabilities ?? null };
}

/** Judges one claim against a region only; null probabilities when `skip` says so. */
export async function judgeRegion(ctx: StepContext, region: Locator, claim: string, skip: (observed: Observed) => boolean): Promise<Judged> {
  const spatial = await needsLayout(ctx, [claim]);
  return judgeObservation(ctx, [claim], spatial, region, skip);
}

type ClaimsJudgment = { snap: Snapshot; probabilities: number[] } | { detail: string };

/** One judgment of the claims, against the page or the region `within` names (`detail` when Jev finds no region). */
export async function judgeClaims(ctx: StepContext, claims: string[], within?: string): Promise<ClaimsJudgment> {
  // The claims and the region are queued together, so one request routes both (MCP `ask` is not a step).
  prepareEvidence(ctx, [{ kind: StepKind.expect, expectations: claims, within }]);
  if (within) {
    const region = await resolveOne(ctx, 'region', within);
    if (!region.element) return { detail: region.detail };
    const spatial = await needsLayout(ctx, claims);
    const { state, probabilities } = await judgeObservation(ctx, claims, spatial, region.element!);
    return { snap: state.snap, probabilities: probabilities! };
  }
  // Settled, because a client-side route change reaches `load` at once and the claim is about the content.
  const { state, probabilities } = await judgeSettled(ctx, claims, undefined, await claimsAhead(ctx, claims));
  return { snap: state.snap, probabilities: probabilities! };
}

/** The MCP `ask` tool: one judgment, like expect, but not a step: no status, not recorded. */
export async function askPage(ctx: StepContext, claims: string[], within?: string) {
  ctx.ms = {};
  return { ...(await judgeClaims(ctx, claims, within)), ms: ctx.ms };
}
