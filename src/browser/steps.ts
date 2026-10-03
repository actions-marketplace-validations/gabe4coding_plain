import path from 'node:path';
import type { Locator } from 'playwright';
import { StepKind } from '../core/step-kind.js';
import type { Step } from '../core/spec.js';
import type { Snapshot } from '../core/automation.js';
import { label, dumpDebug, errorMessage, type Status, type StepResult } from '../core/results.js';
import { decide, decideAll } from '../jev/decide.js';
import { waitForMutation } from './page.js';
import { type CandidateKind } from './candidates.js';
import { mayNavigate, settlePage, waitHold } from './activity.js';
import { resolveLocators, resolveOne } from './locate.js';
import { judgeClaims, judgeRegion, judgeSettled, type Observed } from './judge-page.js';
import { sleep, timed, type StepContext } from './context.js';

type StepOf<K extends Step['kind']> = Extract<Step, { kind: K }>;

/** Waits at most this many Jev answers for a `wait` condition. */
const MAX_WAIT_POLLS = 8;
/** A page that keeps mutating without changing what Jev sees must not spin the wait loop. */
const MIN_POLL_GAP_MS = 250;
const MAX_IDLE_BETWEEN_POLLS_MS = 1500;
/** Typing usually fires a debounced request (autocomplete, validation) after ~300-400 ms. */
const FILL_GRACE_MS = 200;
const FILL_HOLD_MS = 500;

/** runStep that never throws: an error becomes the result, and an optional step that misses is skipped. */
export async function runStepSafely(ctx: StepContext, step: Step, prepare: (step: Step) => Step = (s) => s): Promise<StepResult> {
  let result: StepResult;
  try {
    result = await runStep(ctx, prepare(step));
  } catch (error) {
    result = { step: label(step), status: 'error', detail: actionError(error) };
  }
  const missed = result.status === 'inconclusive' || result.status === 'error';
  return step.optional && missed ? { ...result, status: 'skipped' } : result;
}

/** Call log lines that every attempt repeats and that never say why the action failed. */
const ROUTINE_LOG = /^(\d+ × )?(waiting for|waiting \d+ms|retrying|attempting|scrolling into view|done scrolling|element is visible, enabled and stable|locator resolved to|navigating to)/;

/**
 * A Playwright error without its call log, which repeats every retry (60 lines for one covered button): the first
 * line, plus the last log line that gives a reason, such as the element that intercepts pointer events.
 */
function actionError(error: unknown): string {
  const [head, log] = errorMessage(error).split('\nCall log:\n');
  if (log === undefined) return head;
  const reason = log.split('\n').map((line) => line.trim().replace(/^- /, ''))
    .filter((line) => line && !ROUTINE_LOG.test(line)).at(-1);
  return reason ? `${head.trim()} ${reason.slice(0, 300)}` : head.trim();
}

/** Runs one step; the result's `ms` holds its phase timings and `total`. */
export async function runStep(ctx: StepContext, step: Step): Promise<StepResult> {
  ctx.ms = {};
  ctx.step = step;
  const start = Date.now();
  if (!settlesFirst(step)) await timed(ctx, 'settle', () => waitHold(ctx.page));
  const result = await runKind(ctx, step);
  ctx.ms.total = Date.now() - start;
  const cached = ctx.ms.cached ? { cached: true, detail: result.detail ? `${result.detail} (cached pick)` : '(cached pick)' } : {};
  return { ...result, ...cached, ms: { ...ctx.ms } };
}

/**
 * Whether the step's first look goes through settledAsk, which waits out the last action's hold itself while
 * Jev works. Every other step waits it out before it starts.
 */
function settlesFirst(step: Step): boolean {
  if (step.kind === StepKind.goto || step.kind === StepKind.press || step.kind === StepKind.mouse) return false;
  if (step.kind === StepKind.scroll && scrollEdge(step.target)) return false;
  const targets = step.kind === StepKind.expect ? [step.within ?? '']
    : step.kind === StepKind.wait ? [step.condition]
      : step.kind === StepKind.drag ? [step.source, step.target]
        : [step.target];
  return targets.some((target) => !target.startsWith('css='));
}

async function runKind(ctx: StepContext, step: Step): Promise<StepResult> {
  const stepLabel = label(step);
  const pass = (detail?: string): StepResult =>
    detail === undefined ? { step: stepLabel, status: 'pass' } : { step: stepLabel, status: 'pass', detail };
  const onTarget = (kind: CandidateKind, target: string, act: (element: Locator) => Promise<string | void>) =>
    withResolved(ctx, kind, target, stepLabel, act);

  switch (step.kind) {
    case StepKind.goto:
      await timed(ctx, 'action', () => ctx.page.goto(resolveUrl(ctx.spec.url, step.url), { waitUntil: 'load' }));
      return pass();
    case StepKind.press:
      await mayNavigate(ctx, () => ctx.page.keyboard.press(step.key));
      return pass();
    case StepKind.mouse:
      await timed(ctx, 'action', () => ctx.page.mouse.move(step.x, step.y));
      return pass();
    case StepKind.click:
      return onTarget(StepKind.click, step.target, (element) => mayNavigate(ctx, () => element.click()));
    case StepKind.dblclick:
      return onTarget(StepKind.click, step.target, (element) => mayNavigate(ctx, () => element.dblclick()));
    case StepKind.rightclick:
      return onTarget(StepKind.click, step.target, (element) => mayNavigate(ctx, () => element.click({ button: 'right' })));
    case StepKind.fill:
      return onTarget(StepKind.fill, step.target, (element) =>
        mayNavigate(ctx, () => element.fill(step.value), FILL_GRACE_MS, FILL_HOLD_MS));
    case StepKind.hover:
      return onTarget(StepKind.hover, step.target, (element) => timed(ctx, 'action', () => element.hover()));
    case StepKind.select:
      return onTarget(StepKind.select, step.target, (element) => timed(ctx, 'action', () => selectOption(element, step.value)));
    case StepKind.check:
    case StepKind.uncheck:
      return onTarget(StepKind.check, step.target, (element) =>
        timed(ctx, 'action', () => setChecked(element, step.kind === StepKind.check)));
    case StepKind.upload: {
      const files = step.files.map((file) => path.resolve(ctx.spec.dir, file));
      return onTarget(StepKind.upload, step.target, (element) => timed(ctx, 'action', () => element.setInputFiles(files)));
    }
    case StepKind.scroll: {
      const edge = scrollEdge(step.target);
      if (edge) return pass(await scrollToEdge(ctx, edge));
      return onTarget(StepKind.click, step.target, async (element) => {
        await timed(ctx, 'action', () => element.scrollIntoViewIfNeeded());
        await timed(ctx, 'settle', () => settlePage(ctx.page));
      });
    }
    case StepKind.drag:
      return runDrag(ctx, step, stepLabel);
    case StepKind.wait:
      return runWait(ctx, step, stepLabel);
    case StepKind.expect:
      return runExpect(ctx, step, stepLabel);
  }
}

/** Resolves `target`, then acts on it; inconclusive when Jev finds no element. `act` may add to the detail. */
async function withResolved(ctx: StepContext, kind: CandidateKind, target: string, stepLabel: string,
  act: (element: Locator) => Promise<string | void>): Promise<StepResult> {
  const resolved = await resolveOne(ctx, kind, target);
  if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
  const extra = await act(resolved.element);
  return { step: stepLabel, status: 'pass', detail: extra ? `${resolved.detail} ${extra}` : resolved.detail };
}

/** `url` is the app's base, not just its origin: `goto: /` goes back to the app under test, not to the site's root. */
function resolveUrl(base: string, target: string): string {
  if (/^https?:\/\//.test(target)) return target;
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const relative = target.startsWith('/') ? target.slice(1) : target;
  return new URL(relative, baseWithSlash).toString();
}

async function selectOption(element: Locator, value: string): Promise<void> {
  try {
    await element.selectOption({ label: value });
  } catch {
    await element.selectOption(value);
  }
}

/**
 * `check`/`uncheck` mean "make it (un)selected", wherever the state lives: a form control's `checked` (through
 * its label) or aria-checked/aria-pressed on a toggle. Playwright's check() refuses toggle buttons and times out
 * on a label whose checkbox has no size, so the state is read here and the element is clicked only to change it.
 */
async function setChecked(element: Locator, on: boolean): Promise<string> {
  const wanted = on ? 'checked' : 'unchecked';
  const read = () => element.evaluate((el) => {
    const control = el instanceof HTMLLabelElement ? el.control : el;
    if (control instanceof HTMLInputElement) return control.checked;
    const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
    return aria === null ? null : aria === 'true';
  });
  const before = await read();
  if (before === null) {
    // No readable state: Playwright decides whether this is a checkbox at all.
    await (on ? element.check() : element.uncheck());
    return `now ${wanted}`;
  }
  if (before === on) return `already ${wanted}`;
  await element.click();
  const after = await read().catch(() => null); // a re-render may have replaced the element
  if (after !== null && after !== on) throw new Error(`clicked, but the element is still ${after ? 'checked' : 'unchecked'}`);
  return `now ${wanted}`;
}

/** `scroll: bottom`, `top`, and the ways an agent writes them ("the bottom of the page", "page end"). */
function scrollEdge(target: string): 'top' | 'bottom' | null {
  const match = /^(?:the )?(?:page )?(top|bottom|end)(?: of the page)?$/i.exec(target.trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'top' ? 'top' : 'bottom';
}

/**
 * Scrolls `document.scrollingElement` (body.scrollHeight is short of the document on many sites), `instant` so
 * the position read back is final even under `scroll-behavior: smooth`. Returns the detail.
 */
async function scrollToEdge(ctx: StepContext, edge: 'top' | 'bottom'): Promise<string> {
  const [from, to] = await timed(ctx, 'action', () => ctx.page.evaluate((edge) => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const start = scroller.scrollTop;
    scroller.scrollTo({ top: edge === 'top' ? 0 : scroller.scrollHeight, behavior: 'instant' });
    return [Math.round(start), Math.round(scroller.scrollTop)];
  }, edge));
  await timed(ctx, 'settle', () => settlePage(ctx.page));
  return from === to
    ? `did not move (${to}px): already at the ${edge}, or the page scrolls inside an element — scroll that element instead`
    : `scrolled ${from} → ${to}px`;
}

/**
 * Hover, mouse down, hover the target twice, mouse up: Playwright's dragTo() only synthesizes mouse events,
 * which native HTML5 dragstart/dragover/drop handlers never see.
 */
async function runDrag(ctx: StepContext, step: StepOf<'drag'>, stepLabel: string): Promise<StepResult> {
  const resolved = await resolveLocators(ctx, StepKind.click, [step.source, step.target]);
  for (const target of resolved) if (target.usedJev) ctx.track(target.tokens);
  const missing = resolved.find((target) => !target.element);
  if (missing) return { step: stepLabel, status: 'inconclusive', detail: missing.detail };
  const [source, destination] = resolved;
  await timed(ctx, 'action', async () => {
    await source.element!.hover();
    await ctx.page.mouse.down();
    await destination.element!.hover();
    await destination.element!.hover();
    await ctx.page.mouse.up();
  });
  return { step: stepLabel, status: 'pass', detail: `${source.detail} → ${destination.detail}` };
}

/**
 * Polls the condition until Jev says it holds, the timeout passes or MAX_WAIT_POLLS answers came back.
 * `within`: one region pick, then each poll sends only that region (the whole tree of a big page costs many
 * tokens per poll); the region is picked again if its element leaves the page.
 * An unchanged state after a clear "no" is not asked again; a grey-zone answer is, since a borderline
 * probability can flip on the next try.
 */
async function runWait(ctx: StepContext, step: StepOf<'wait'>, stepLabel: string): Promise<StepResult> {
  if (step.condition.startsWith('css=')) {
    await ctx.page.waitForSelector(step.condition.slice(4), { state: 'visible', timeout: ctx.timeout });
    return { step: stepLabel, status: 'pass' };
  }
  const deadline = Date.now() + ctx.timeout;
  let region: Locator | null = null;
  if (step.within) {
    const resolved = await resolveOne(ctx, 'region', step.within);
    if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
    region = resolved.element;
  }

  let polls = 0;
  let skipped = 0;
  let lastProbability = 0;
  let lastSnap: Snapshot | null = null;
  let lastKey: string | null = null;
  const keyOf = (observed: Observed) => JSON.stringify([observed.snap, observed.events]);
  const unchangedSinceNo = (observed: Observed) => keyOf(observed) === lastKey && decide(lastProbability, 'expect') === 'fail';
  const detail = () => `p=${lastProbability.toFixed(2)} after ${polls} poll(s)${skipped > 0 ? `, ${skipped} unchanged` : ''}`;

  while (polls < MAX_WAIT_POLLS && Date.now() < deadline) {
    const pollStart = Date.now();
    if (region && step.within && await region.count() === 0) { // re-rendered: its data-jev-id is gone
      const resolved = await resolveOne(ctx, 'region', step.within);
      if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
      region = resolved.element;
    }
    const { state, probabilities } = region
      ? await judgeRegion(ctx, region, step.condition, unchangedSinceNo)
      : await judgeSettled(ctx, [step.condition], unchangedSinceNo);
    if (probabilities === null) {
      skipped++;
    } else {
      lastKey = keyOf(state);
      lastProbability = probabilities[0];
      lastSnap = state.snap;
      ctx.ms.polls = ++polls;
      if (decide(lastProbability, 'expect') === 'pass') return { step: stepLabel, status: 'pass', detail: detail() };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // A navigation mid-evaluate throws: that counts as a change.
    await timed(ctx, 'idle', () => waitForMutation(ctx.page, Math.min(MAX_IDLE_BETWEEN_POLLS_MS, remaining)).catch(() => {}));
    const tooSoon = MIN_POLL_GAP_MS - (Date.now() - pollStart);
    if (probabilities === null && tooSoon > 0) await sleep(tooSoon);
  }
  const file = dumpDebug(StepKind.wait, { condition: step.condition, probability: lastProbability, state: lastSnap });
  return { step: stepLabel, status: 'inconclusive', detail: `${detail()} — state: ${file}` };
}

/** All claims in one Jev call. */
async function runExpect(ctx: StepContext, step: StepOf<'expect'>, stepLabel: string): Promise<StepResult> {
  const judged = await judgeClaims(ctx, step.expectations, step.within);
  if ('detail' in judged) return { step: stepLabel, status: 'inconclusive', detail: judged.detail };

  const { snap, probabilities } = judged;
  const status: Status = decideAll(probabilities);
  let detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} @ ${ctx.page.url()}`;
  if (snap.truncated) detail += ' (aria truncated at 60k chars)';
  if (status !== 'pass') {
    // What Jev saw, so the author can tune the claims against the real state.
    const file = dumpDebug(StepKind.expect, { expectations: step.expectations, probabilities, state: snap });
    detail += ` — state: ${file}`;
  }
  return { step: stepLabel, status, detail };
}
