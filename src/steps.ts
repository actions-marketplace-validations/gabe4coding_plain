import { StepKind } from './step-kind.js';
import path from 'node:path';
import type { Page, Locator } from 'playwright';
import type { Spec, Step } from './spec.js';
import {
  candidates,
  elementById,
  mark,
  settle,
  unchangedSince,
  snapshot,
  snapshotRegion,
  waitForMutation,
  type Candidate,
  type CandidateKind,
  type Snapshot,
  type DocTime,
} from './page.js';
import { decide, MAX_CANDIDATES } from './jev.js';
import { resolveTargets, judgeState, type ResolvedTarget } from './automation.js';
import { label, dumpDebug, timedInto, type Status, type StepResult } from './results.js';
export { label, formatMs, StatusSchema, StepResultSchema, type Status, type StepResult } from './results.js';

// Adds the elapsed ms of `fn` into ctx.ms[phase], a per-step accumulator reset in runStep().
export const timed = <T>(ctx: StepContext, phase: string, fn: () => Promise<T>): Promise<T> => timedInto(ctx.ms, phase, fn);

// inflight: xhr/fetch/document requests → when each started; held: holdActivity() holds; settleAfter: the
// page is not settled before this time (see mayNavigate's holdMs); pending: anything in flight, however old.
const newActivity = () => ({ inflight: new Map<object, number>(), held: 0, lastActivity: Date.now(), settleAfter: 0,
  get pending() { return this.inflight.size + this.held; } });

// Per-page in-flight xhr/fetch tracker, wired lazily on first use so a popup that replaces
// ctx.page (see runner.ts) gets tracked on its first action with no extra setup there.
const requestTracking = new WeakMap<Page, ReturnType<typeof newActivity>>();

function trackRequests(page: Page) {
  const existing = requestTracking.get(page);
  if (existing) return existing;
  const record = newActivity();
  requestTracking.set(page, record);
  // 'document' too: a click whose navigation turns into a download never fires framenavigated, but its
  // request is what bridges the gap until the runner's 'download' handler holds the wait (holdActivity).
  const isXhrOrFetch = (req: { resourceType(): string }) => ['xhr', 'fetch', 'document'].includes(req.resourceType());
  page.on('request', (req) => { if (isXhrOrFetch(req)) record.inflight.set(req, Date.now()); });
  const onDone = (req: { resourceType(): string }) => {
    // A request that started before tracking was wired was never counted: nothing to release.
    if (record.inflight.delete(req)) record.lastActivity = Date.now();
  };
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  return record;
}

/** Marks page activity as pending until the returned function is called; mayNavigate waits for it (1500 ms cap). */
export function holdActivity(page: Page): () => void {
  const record = trackRequests(page);
  record.held++;
  return () => {
    record.held = Math.max(0, record.held - 1);
    record.lastActivity = Date.now();
  };
}

// The DOM must be quiet this long before a step observes it. Requests are waited for separately
// (settlePage), so this only has to outlast rendering bursts, not a slow response.
const SETTLE_QUIET_MS = 150;
const SETTLE_MAX_MS = 3000;
// A request older than this is a long poll, a stream or a stuck beacon, not a response the page is about
// to render: it stops holding the settle, or every step on such a site would wait out SETTLE_MAX_MS.
const YOUNG_REQUEST_MS = 2000;

/**
 * Settle the active page: the DOM quiet for SETTLE_QUIET_MS and no young xhr/fetch in flight (a
 * client-rendered page may fetch for a while before it changes the DOM at all), SETTLE_MAX_MS cap.
 * Resolves to the document's last mutation, as settle() does; null when that cannot be read (no
 * observer, or the page navigated mid-evaluate) — callers then treat the page as changed.
 */
export async function settlePage(page: Page): Promise<DocTime | null> {
  const requests = trackRequests(page);
  await waitHold(page);
  const deadline = Date.now() + SETTLE_MAX_MS;
  const young = () => {
    const now = Date.now();
    let n = requests.held;
    for (const started of requests.inflight.values()) if (now - started < YOUNG_REQUEST_MS) n++;
    return n;
  };
  for (;;) {
    const last = await settle(page, SETTLE_QUIET_MS, Math.max(0, deadline - Date.now())).catch(() => null);
    if (young() === 0 || Date.now() >= deadline) return last;
    while (young() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  }
}

/** Waits out what is left of the last action's holdMs (see mayNavigate). */
export async function waitHold(page: Page): Promise<void> {
  const left = trackRequests(page).settleAfter - Date.now();
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

/**
 * Run an action that may trigger a navigation (click on a link-like element, Enter in a form) or a
 * network request (typing that fires a debounced autocomplete/validation call), and wait for whichever
 * shows up instead of a flat timeout. A navigation always wins and is awaited to `load`. Otherwise: give
 * the page `graceMs` after the action to start an xhr/fetch, then once none are pending wait another
 * `graceMs` of quiet before returning. `graceMs` is per-action (clicks settle fast; a debounced input
 * needs longer). 1500 ms is the hard cap either way.
 * `holdMs` (> graceMs): the page is not settled before this long after the action, e.g. a debounced
 * input's request may start only after ~300-400 ms. The rest of it is not waited here but by the next
 * step's settle (settlePage, or waitHold in runStep), so the next step's Jev call runs meanwhile.
 */
export async function mayNavigate(ctx: StepContext, action: () => Promise<void>, graceMs = 200, holdMs = 0): Promise<void> {
  const page = ctx.page;
  const requests = trackRequests(page); // before the action, so requests it starts are counted
  let navStarted = false;
  const nav = page
    .waitForEvent('framenavigated', { timeout: 1500, predicate: (f) => f === page.mainFrame() })
    .then(() => {
      navStarted = true;
      return page.waitForLoadState('load');
    })
    .catch(() => {}); // no navigation started — that's fine, and the pending waitForEvent times out and is caught here

  await timed(ctx, 'action', action);
  const actionEnd = Date.now();
  if (holdMs > graceMs) requests.settleAfter = actionEnd + holdMs;

  await timed(ctx, 'post', async () => {
    while (Date.now() - actionEnd < 1500) {
      if (navStarted) return nav;
      const quietSince = Math.max(actionEnd, requests.lastActivity);
      if (requests.pending === 0 && Date.now() - quietSince >= graceMs) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  });
}

function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  // ponytail: treat `url` as the app's base directory, not just its origin — a plain WHATWG
  // `new URL(path, base)` join drops the base's own path for any path starting with "/", which
  // sends "goto: /" to the origin's root instead of back to the app under test.
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const rel = path.startsWith('/') ? path.slice(1) : path;
  return new URL(rel, baseWithSlash).toString();
}

// What to try instead when a step kind finds nothing at all to choose from.
const NO_CANDIDATES_HINT: Partial<Record<CandidateKind, string>> = {
  [StepKind.check]: ' (no checkbox, radio, switch or aria-pressed toggle); for a plain button or chip use click',
  [StepKind.select]: ' (no native <select>); for a custom dropdown click the control, then click the option',
  [StepKind.upload]: ' (no file input); if the page opens a picker from a button, use css= on the hidden input',
};

/**
 * Observe the page and start the Jev call at once, while the page settles, instead of settle → observe
 * → ask. The early answer is kept only when it was asked about the settled state: the main document did
 * not mutate after the observation (no second look needed), or a second look gives the same input.
 * Otherwise the settled state is asked again; the early answer is awaited anyway so `discard` can
 * account for its tokens inside this step. `skip`: no question is needed for this state (the caller
 * already knows the answer). Returns the state the result belongs to; result is null when skipped.
 */
export async function settledAsk<S, R>(
  ctx: StepContext,
  o: {
    observe: () => Promise<S>;
    same: (a: S, b: S) => boolean;
    ask: (state: S) => Promise<R>;
    discard: (result: R) => void;
    skip?: (state: S) => boolean;
  }
): Promise<{ state: S; result: R | null }> {
  const page = ctx.page;
  const before = await mark(page).catch(() => null);
  const first = await o.observe();
  const early = o.skip?.(first) ? null : o.ask(first);
  early?.catch(() => {}); // surfaces below only if this answer is the one used
  const settled = await timed(ctx, 'settle', () => settlePage(page));
  let state = first;
  // Iframes have their own documents, which the main-document mark does not cover: always look again.
  if (!unchangedSince(before, settled) || page.frames().length > 1) {
    const again = await o.observe();
    if (!o.same(first, again)) state = again;
  }
  if (state === first && early) return { state, result: await timed(ctx, 'jev', () => early) };
  if (early) ctx.ms.reasked = (ctx.ms.reasked ?? 0) + 1;
  const stale = early?.then(o.discard, () => {});
  if (o.skip?.(state)) {
    await stale;
    return { state, result: null };
  }
  const [result] = await timed(ctx, 'jev', () => Promise.all([o.ask(state), stale]));
  return { state, result };
}

// Resolves several targets of the same kind in one pass: css= targets resolve directly, the rest
// share ONE settle + ONE candidate scan + ONE pickElements() request (one request = one Jev call —
// only the first Jev-resolved entry carries usedJev/tokens, matching pickElements()'s own contract).
// Results come back in the same order as `targets`.
// How long a step waits for a page with no candidates yet to show some.
const APPEAR_MS = 2000;

export async function resolveLocators(ctx: StepContext, kind: CandidateKind, targets: string[]): Promise<ResolvedTarget<Locator>[]> {
  const page = ctx.page;
  const results: ResolvedTarget<Locator>[] = new Array(targets.length);
  const jevIndices: number[] = [];
  const jevTargets: string[] = [];

  for (const [i, target] of targets.entries()) {
    if (target.startsWith('css=')) {
      const selector = target.slice(4);
      const element = page.locator(selector);
      // No match yet is left to Playwright's auto-wait; several matches would end in its raw strict-mode dump.
      const count = await element.count();
      results[i] = count > 1
        ? { element: null, detail: `css=${selector} matched ${count} elements; make the selector match exactly one`, tokens: 0, usedJev: false }
        : { element, detail: `→ css=${selector}`, tokens: 0, usedJev: false };
    } else {
      jevIndices.push(i);
      jevTargets.push(target);
    }
  }

  if (jevTargets.length > 0) {
    // Let debounced autocompletes, modals etc. finish rendering before we act (networkidle fires too early:
    // it sees the quiet gap *before* a debounced request starts); Jev already works on the early look.
    // A page still redirecting or rendering after `open` has no candidates yet (Booking answered "no
    // candidates" in 243 ms): look again for a moment, as the desktop adapter does, before reporting it.
    const deadline = Date.now() + Math.min(APPEAR_MS, ctx.timeout);
    let look;
    for (;;) {
      look = await settledAsk(ctx, {
        observe: async () => ({
          cands: await timed(ctx, 'candidates', () => candidates(page, kind, MAX_CANDIDATES)),
          url: page.url(),
          title: await page.title(),
        }),
        same: (a, b) => a.url === b.url && a.title === b.title && sameCandidates(a.cands, b.cands),
        ask: ({ cands, url, title }) => resolveTargets({
          candidates: cands,
          state: { url, title, goal: ctx.spec.goal },
          element: (candidate) => elementById(page, candidate.id, candidate.frameIndex),
        }, jevTargets),
        discard: ([first]) => { if (first?.usedJev) ctx.track(first.tokens); },
      }).catch((err) => { if (Date.now() < deadline && /context was destroyed|navigat/i.test(String(err))) return null; throw err; });
      if ((look && look.state.cands.length) || Date.now() >= deadline) break;
      await timed(ctx, 'idle', () => new Promise((r) => setTimeout(r, 150)));
    }
    if (!look) throw new Error('the page kept navigating; no candidates could be read');
    const { state: { cands }, result } = look;
    result!.forEach((r, j) => {
      results[jevIndices[j]] = { ...r, detail: cands.length ? r.detail :
        `no candidates: nothing on the page matches a ${kind} target${NO_CANDIDATES_HINT[kind] ?? ''}` };
    });
  }

  return results;
}

// Ids are assigned in scan order, so equal lists also mean equal ids on the page.
function sameCandidates(a: Candidate[], b: Candidate[]): boolean {
  return a.length === b.length && a.every((c, i) => c.desc === b[i].desc && c.frameIndex === b[i].frameIndex);
}

/** One target, its Jev call accounted for. */
export async function resolveOne(ctx: StepContext, kind: CandidateKind, target: string): Promise<ResolvedTarget<Locator>> {
  const [r] = await resolveLocators(ctx, kind, [target]);
  if (r.usedJev) ctx.track(r.tokens);
  return r;
}

export interface StepContext {
  // The active page, which can be replaced mid-run by a popup listener (see runner.ts).
  // Read this property live every time — do not cache it.
  readonly page: Page;
  spec: Spec;
  timeout: number;
  events: string[];
  track: (tokens: number) => void;
  // Per-step phase-timing accumulator, reset to {} at the top of runStep(). Always populated
  // (whether or not --timing is passed); only the CLI decides whether to print it.
  ms: Record<string, number>;
}

// Resolve `target` under `kind`, account for the Jev call, and either report "inconclusive" or run
// `act` on the resolved locator — the resolve → account → branch triple every element-acting step shares.
async function withResolved(
  ctx: StepContext,
  kind: CandidateKind,
  target: string,
  stepLabel: string,
  act: (loc: Locator) => Promise<string | void>
): Promise<StepResult> {
  const r = await resolveOne(ctx, kind, target);
  if (!r.element) return { step: stepLabel, status: 'inconclusive', detail: r.detail };
  const extra = await act(r.element);
  return { step: stepLabel, status: 'pass', detail: extra ? `${r.detail} ${extra}` : r.detail };
}

// What a judgment is asked about: the snapshot plus ctx.events (downloads, console errors, dialogs) as
// they were when it was taken — an event landing while the page settles makes it a different state.
interface Observed {
  snap: Snapshot;
  events: string[];
}

const sameObserved = (a: Observed, b: Observed): boolean =>
  a.snap.url === b.snap.url && a.snap.title === b.snap.title && a.snap.aria === b.snap.aria &&
  a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]);

// Settles the page and judges `claims` against it (see settledAsk), with the shared token accounting —
// every judgment of the whole page goes through this. judgeState holds the too-long-state halving retry;
// one request judges every claim (each still its own Noul question, so its own probability).
async function judgeSettled(
  ctx: StepContext,
  claims: string[],
  skip?: (o: Observed) => boolean
): Promise<{ state: Observed; probabilities: number[] | null }> {
  const { state, result } = await settledAsk(ctx, {
    observe: async () => ({ snap: await timed(ctx, 'snapshot', () => snapshot(ctx.page)), events: [...ctx.events] }),
    same: sameObserved,
    ask: ({ snap, events }) => judgeState(snap, claims, events),
    discard: (r) => ctx.track(r.tokens),
    skip,
  });
  if (result) ctx.track(result.tokens);
  return { state, probabilities: result?.probabilities ?? null };
}

// `check`/`uncheck` mean "make it (un)selected", whatever keeps the state: a form control's `checked`
// (following a label to its control), or aria-checked/aria-pressed on a toggle button. Playwright's own
// check() refuses toggle buttons and times out on a label whose checkbox has no size (trivago's filter
// chips), so the state is read here and the element is clicked only when it has to change.
async function setChecked(loc: Locator, on: boolean): Promise<string> {
  const read = () =>
    loc.evaluate((el) => {
      const control = el instanceof HTMLLabelElement ? el.control : el;
      if (control instanceof HTMLInputElement) return control.checked;
      const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
      return aria === null ? null : aria === 'true';
    });
  const before = await read();
  if (before === null) {
    // No readable state: let Playwright decide whether this is a checkbox at all.
    await (on ? loc.check() : loc.uncheck());
    return `now ${on ? 'checked' : 'unchecked'}`;
  }
  if (before === on) return `already ${on ? 'checked' : 'unchecked'}`;
  await loc.click();
  const after = await read().catch(() => null); // a re-render may have replaced the element: not a failure
  if (after !== null && after !== on) throw new Error(`clicked, but the element is still ${after ? 'checked' : 'unchecked'}`);
  return `now ${on ? 'checked' : 'unchecked'}`;
}

// `scroll: bottom`, `top`, and the ways an agent writes them ("the bottom of the page", "page end").
function scrollEdge(target: string): 'top' | 'bottom' | null {
  const m = /^(?:the )?(?:page )?(top|bottom|end)(?: of the page)?$/i.exec(target.trim());
  return m ? (m[1].toLowerCase() === 'top' ? 'top' : 'bottom') : null;
}

async function runDrag(ctx: StepContext, step: Extract<Step, { kind: typeof StepKind.drag }>, stepLabel: string): Promise<StepResult> {
  const resolved = await resolveLocators(ctx, StepKind.click, [step.source, step.target]);
  for (const r of resolved) if (r.usedJev) ctx.track(r.tokens);
  const [rs, rt] = resolved;
  const missing = resolved.find((r) => !r.element);
  if (missing) return { step: stepLabel, status: 'inconclusive', detail: missing.detail };
  // ponytail: locator.dragTo() only synthesizes mouse events, which native HTML5 dragstart/dragover/drop
  // handlers (the-internet's /drag_and_drop) never see: use the manual sequence Playwright's docs recommend.
  const [source, dest] = [rs.element!, rt.element!];
  await timed(ctx, 'action', async () => {
    await source.hover();
    await ctx.page.mouse.down();
    await dest.hover();
    await dest.hover();
    await ctx.page.mouse.up();
  });
  return { step: stepLabel, status: 'pass', detail: `${rs.detail} → ${rt.detail}` };
}

async function runWait(ctx: StepContext, step: Extract<Step, { kind: typeof StepKind.wait }>, stepLabel: string): Promise<StepResult> {
  if (step.condition.startsWith('css=')) {
    await ctx.page.waitForSelector(step.condition.slice(4), { state: 'visible', timeout: ctx.timeout });
    return { step: stepLabel, status: 'pass' };
  }
  const MAX_POLLS = 8; // ponytail: hard cap on Jev polls per wait, floor against a condition that never holds
  const MIN_SNAPSHOT_GAP_MS = 250; // floor against a hot loop: settle→snapshot→skip→wake spinning on a constantly-mutating, unchanged-key page
  const deadline = Date.now() + ctx.timeout;
  // `within`: one region pick, then every poll reads and sends only that region (a big page's whole
  // tree costs ~17k tokens per poll). The region is picked again if its element leaves the page.
  let region: Locator | null = null;
  if (step.within) {
    const r = await resolveOne(ctx, 'region', step.within);
    if (!r.element) return { step: stepLabel, status: 'inconclusive', detail: r.detail };
    region = r.element;
  }
  const within = step.within;
  let polls = 0, skipped = 0, lastProbability = 0;
  let lastSnap: Snapshot | null = null, lastKey: string | null = null;
  const keyOf = (o: Observed) => JSON.stringify([o.snap, o.events]);
  const detail = () => `p=${lastProbability.toFixed(2)} after ${polls} poll(s)${skipped > 0 ? `, ${skipped} unchanged` : ''}`;
  while (polls < MAX_POLLS && Date.now() < deadline) {
    const snapStart = Date.now();
    // Everything a judgment sends Jev besides the claims: the snapshot and the events (downloads,
    // console errors, dialogs). If neither changed since the last poll and Jev already said a clear no,
    // asking again buys nothing — skip the round trip. A grey-zone answer is re-asked as documented
    // ("wait repeats the question"): a borderline p flips between runs, and the retry is what rescues it.
    if (region && within && await region.count() === 0) { // re-rendered: its data-jev-id is gone
      const r = await resolveOne(ctx, 'region', within);
      if (!r.element) return { step: stepLabel, status: 'inconclusive', detail: r.detail };
      region = r.element;
    }
    const unchanged = (o: Observed) => keyOf(o) === lastKey && decide(lastProbability, 'expect') === 'fail';
    const { state, probabilities } = region ? await judgeRegion(ctx, region, step.condition, unchanged)
      : await judgeSettled(ctx, [step.condition], unchanged);
    if (probabilities === null) skipped++;
    else {
      lastKey = keyOf(state);
      lastProbability = probabilities[0];
      lastSnap = state.snap;
      ctx.ms.polls = ++polls;
      if (decide(lastProbability, 'expect') === 'pass') return { step: stepLabel, status: 'pass', detail: detail() };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Navigation mid-evaluate throws — treat that as "something changed" rather than fail the step.
    await timed(ctx, 'idle', () => waitForMutation(ctx.page, Math.min(1500, remaining)).catch(() => {}));
    const shortfall = MIN_SNAPSHOT_GAP_MS - (Date.now() - snapStart);
    if (probabilities === null && shortfall > 0) await new Promise((resolve) => setTimeout(resolve, shortfall));
  }
  const file = dumpDebug(StepKind.wait, { condition: step.condition, probability: lastProbability, state: lastSnap });
  return { step: stepLabel, status: 'inconclusive', detail: `${detail()} — state: ${file}` };
}

// One wait poll against a region: its snapshot plus the events; null probabilities when `skip` says the
// observation is unchanged since a clear no.
async function judgeRegion(ctx: StepContext, region: Locator, claim: string, skip: (o: Observed) => boolean):
  Promise<{ state: Observed; probabilities: number[] | null }> {
  await timed(ctx, 'settle', () => settlePage(ctx.page));
  const snap = await timed(ctx, 'snapshot', () => snapshotRegion(ctx.page, region));
  const state = { snap, events: [...ctx.events] };
  if (skip(state)) return { state, probabilities: null };
  const result = await timed(ctx, 'jev', () => judgeState(snap, [claim], state.events));
  ctx.track(result.tokens);
  return { state, probabilities: result.probabilities };
}

async function runExpect(ctx: StepContext, step: Extract<Step, { kind: typeof StepKind.expect }>, stepLabel: string): Promise<StepResult> {
  const judgeExpectations = (snap: Snapshot, probabilities: number[]): StepResult => {
    const decisions = probabilities.map((p) => decide(p, 'expect'));
    // fail beats inconclusive beats pass: one broken claim fails the step even if the rest hold.
    const status: Status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
    let detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} @ ${ctx.page.url()}`;
    if (snap.truncated) detail += ' (aria truncated at 60k chars)';
    if (status !== 'pass') {
      // Dump what Jev saw so the author can tune the expectations against the real state.
      const file = dumpDebug(StepKind.expect, { expectations: step.expectations, probabilities, state: snap });
      detail += ` — state: ${file}`;
    }
    return { step: stepLabel, status, detail };
  };
  const judged = await judgeClaims(ctx, step.expectations, step.within);
  return 'detail' in judged ? { step: stepLabel, status: 'inconclusive', detail: judged.detail } : judgeExpectations(judged.snap, judged.probabilities);
}

// One judgment of `claims` against the page, or against the region `within` names (detail when Jev finds none).
async function judgeClaims(ctx: StepContext, claims: string[], within?: string):
  Promise<{ snap: Snapshot; probabilities: number[] } | { detail: string }> {
  if (within) {
    const r = await resolveOne(ctx, 'region', within);
    if (!r.element) return { detail: r.detail };
    const snap = await timed(ctx, 'snapshot', () => snapshotRegion(ctx.page, r.element!));
    const result = await timed(ctx, 'jev', () => judgeState(snap, claims, ctx.events));
    ctx.track(result.tokens);
    return { snap, probabilities: result.probabilities };
  }
  // Settled: SPA route changes resolve 'load' instantly, and the claim is about the content.
  const { state, probabilities } = await judgeSettled(ctx, claims);
  return { snap: state.snap, probabilities: probabilities! };
}

/** The MCP `ask` tool: one judgment, like expect, but not a step (no status, not recorded). */
export async function askPage(ctx: StepContext, claims: string[], within?: string) {
  ctx.ms = {};
  // A css= region skips settledAsk, which is what waits out the last action's hold.
  if (within?.startsWith('css=')) await timed(ctx, 'settle', () => waitHold(ctx.page));
  return { ...(await judgeClaims(ctx, claims, within)), ms: ctx.ms };
}

// Whether the step's first look at the page goes through settledAsk, which waits out the last action's
// hold itself, overlapped with its Jev call. Every other step waits it out before it starts.
function settlesFirst(step: Step): boolean {
  if (step.kind === StepKind.goto || step.kind === StepKind.press || step.kind === StepKind.mouse) return false;
  if (step.kind === StepKind.scroll && scrollEdge(step.target)) return false;
  const targets = step.kind === StepKind.expect ? [step.within ?? ''] : step.kind === StepKind.wait ? [step.condition] :
    step.kind === StepKind.drag ? [step.source, step.target] : [step.target];
  return targets.some((target) => !target.startsWith('css='));
}

/** runStep that never throws (an error becomes the result); an optional step's inconclusive or error becomes skipped. */
export async function runStepSafely(ctx: StepContext, step: Step, prepare: (step: Step) => Step = (s) => s): Promise<StepResult> {
  let result: StepResult;
  try { result = await runStep(ctx, prepare(step)); }
  catch (err) { result = { step: label(step), status: 'error', detail: err instanceof Error ? err.message : String(err) }; }
  return step.optional && (result.status === 'inconclusive' || result.status === 'error') ? { ...result, status: 'skipped' } : result;
}

// Resets the per-step timing accumulator, runs the step, and stamps `total` = wall time of the
// whole step (including any resolve/settle/jev/action/post time nested calls add into ctx.ms).
export async function runStep(ctx: StepContext, step: Step): Promise<StepResult> {
  ctx.ms = {};
  const start = Date.now();
  if (!settlesFirst(step)) await timed(ctx, 'settle', () => waitHold(ctx.page));
  const result = await runStepInner(ctx, step);
  ctx.ms.total = Date.now() - start;
  return { ...result, ms: { ...ctx.ms } };
}

async function runStepInner(ctx: StepContext, step: Step): Promise<StepResult> {
  const stepLabel = label(step);
  switch (step.kind) {
    case StepKind.goto:
      await timed(ctx, 'action', () => ctx.page.goto(resolveUrl(ctx.spec.url, step.url), { waitUntil: 'load' }));
      return { step: stepLabel, status: 'pass' };
    case StepKind.press:
      await mayNavigate(ctx, () => ctx.page.keyboard.press(step.key));
      return { step: stepLabel, status: 'pass' };
    case StepKind.drag:
      return runDrag(ctx, step, stepLabel);
    case StepKind.mouse:
      await timed(ctx, 'action', () => ctx.page.mouse.move(step.x, step.y));
      return { step: stepLabel, status: 'pass' };
    case StepKind.click:
      return withResolved(ctx, StepKind.click, step.target, stepLabel, (loc) => mayNavigate(ctx, () => loc.click()));
    case StepKind.fill:
      // Hold 500ms: typing usually fires a debounced request (autocomplete, validation) after ~300-400ms.
      return withResolved(ctx, StepKind.fill, step.target, stepLabel, (loc) => mayNavigate(ctx, () => loc.fill(step.value), 200, 500));
    case StepKind.hover:
      return withResolved(ctx, StepKind.hover, step.target, stepLabel, (loc) => timed(ctx, 'action', () => loc.hover()));
    case StepKind.dblclick:
    case StepKind.rightclick: {
      const dbl = step.kind === StepKind.dblclick;
      return withResolved(ctx, StepKind.click, step.target, stepLabel, (loc) =>
        mayNavigate(ctx, () => (dbl ? loc.dblclick() : loc.click({ button: 'right' })))
      );
    }
    case StepKind.select:
      return withResolved(ctx, StepKind.select, step.target, stepLabel, (loc) =>
        timed(ctx, 'action', async () => {
          try {
            await loc.selectOption({ label: step.value });
          } catch {
            await loc.selectOption(step.value);
          }
        })
      );
    case StepKind.check:
    case StepKind.uncheck:
      return withResolved(ctx, StepKind.check, step.target, stepLabel, (loc) =>
        timed(ctx, 'action', () => setChecked(loc, step.kind === StepKind.check))
      );
    case StepKind.upload:
      return withResolved(ctx, StepKind.upload, step.target, stepLabel, (loc) => {
        const paths = step.files.map((f) => path.resolve(ctx.spec.dir, f));
        return timed(ctx, 'action', () => loc.setInputFiles(paths));
      });
    case StepKind.scroll: {
      const edge = scrollEdge(step.target);
      if (edge) {
        // document.scrollingElement, not body: body.scrollHeight is short of the document on many sites.
        // `instant` so the position read back is final even under `scroll-behavior: smooth`.
        const [from, to] = await timed(ctx, 'action', () =>
          ctx.page.evaluate((edge) => {
            const el = document.scrollingElement ?? document.documentElement;
            const from = el.scrollTop;
            el.scrollTo({ top: edge === 'top' ? 0 : el.scrollHeight, behavior: 'instant' });
            return [Math.round(from), Math.round(el.scrollTop)];
          }, edge)
        );
        await timed(ctx, 'settle', () => settlePage(ctx.page));
        const detail =
          from === to
            ? `did not move (${to}px): already at the ${edge}, or the page scrolls inside an element — scroll that element instead`
            : `scrolled ${from} → ${to}px`;
        return { step: stepLabel, status: 'pass', detail };
      }
      return withResolved(ctx, StepKind.click, step.target, stepLabel, async (loc) => {
        await timed(ctx, 'action', () => loc.scrollIntoViewIfNeeded());
        await timed(ctx, 'settle', () => settlePage(ctx.page));
      });
    }
    case StepKind.wait:
      return runWait(ctx, step, stepLabel);
    case StepKind.expect:
      return runExpect(ctx, step, stepLabel);
  }
}
