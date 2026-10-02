import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { interpolate } from '../core/spec.js';
import { runStepSafely, holdActivity } from './steps.js';
import { installSettleObserver } from './page.js';
import { startHooks } from '../core/hooks.js';
import { browserContextOptions } from './context-options.js';
import { observerCalls } from '../suite/observe.js';
import { label } from '../core/results.js';
import { specDeadline } from '../suite/spec-timeout.js';
import { withCacheDump } from '../core/pick-cache.js';
const MAX_EVENTS = 30; // ponytail: cap what's sent to Jev as `events` — a long spec shouldn't grow this unbounded
// Ad-heavy sites log CSP violations that list every allowed domain (~4,500 chars each): sent to Jev with
// every judgment, they cost more tokens than the page. The head says what the error is.
const MAX_NOTE_CHARS = 300;
export function shortNote(msg) {
    return msg.length <= MAX_NOTE_CHARS ? msg : `${msg.slice(0, MAX_NOTE_CHARS)}… (${msg.length} chars)`;
}
// Console errors that say nothing about the page under test: resources the browser refused or failed to
// load (ads, trackers, CSP) and errors logged by another site's script. Yahoo Finance logged 96 of them on
// one click (26k chars of notes). They are counted in one note and never sent to Jev.
const BLOCKED_RESOURCE = /Content Security Policy|^Failed to load resource|net::ERR_|Blocked script execution in 'about:blank'|third-party cookie/i;
// A registrable-domain guess, enough to tell "same site" from "someone else's script": example.co.uk → example.co.uk.
function site(url) {
    let host;
    try {
        host = new URL(url).hostname;
    }
    catch {
        return null;
    }
    const labels = host.split('.');
    const keep = labels.length > 2 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2;
    return labels.slice(-keep).join('.');
}
/** True when a console error comes from a blocked/failed resource or another site's script. */
export function isConsoleNoise(text, sourceUrl, pageUrl) {
    if (BLOCKED_RESOURCE.test(text))
        return true;
    const from = site(sourceUrl), own = site(pageUrl);
    return from !== null && own !== null && from !== own;
}
export function noiseNote(count) {
    return `console: ${count} error${count === 1 ? '' : 's'} from other sites or blocked resources (ads, trackers, CSP), not listed`;
}
/** Appends `msg`, or counts it on the last entry when it repeats it: `msg (×3)`. */
export function pushCollapsed(list, msg) {
    const last = list.at(-1);
    const m = last === undefined ? null : / \(×(\d+)\)$/.exec(last);
    const base = m ? last.slice(0, m.index) : last;
    if (base === msg)
        list[list.length - 1] = `${msg} (×${m ? Number(m[1]) + 1 : 2})`;
    else
        list.push(msg);
}
// One Chromium per launch profile for the whole process; each spec gets its own context (isolation
// unchanged) and only the context is closed per spec. Relaunched if headed/channel change or it died.
// The in-flight launch *promise* is memoized (not the resolved Browser): concurrent first callers
// (--workers > 1) then all await the same launch instead of each starting its own Chromium.
let shared = null;
const launchOptions = (opts) => ({ headless: !opts.headed, channel: opts.channel,
    handleSIGINT: opts.handleSignals, handleSIGTERM: opts.handleSignals, handleSIGHUP: opts.handleSignals });
export async function sharedBrowser(opts) {
    const key = `${!opts.headed}|${opts.channel ?? ''}|${opts.handleSignals ?? true}`;
    if (shared && shared.key === key) {
        const b = await shared.browser;
        if (b.isConnected())
            return b;
    }
    // ponytail: only await closeSharedBrowser() when there's actually something to replace — on the
    // very first call `shared` is still null here, so this stays synchronous up to the assignment
    // below and concurrent callers see it before racing off to launch their own browser.
    if (shared)
        await closeSharedBrowser();
    const entry = { key, browser: chromium.launch(launchOptions(opts)) };
    shared = entry;
    entry.browser.catch(() => { if (shared === entry)
        shared = null; }); // don't cache a failed launch — let the next call retry
    return entry.browser;
}
export async function closeSharedBrowser() {
    const s = shared;
    shared = null;
    if (s)
        await (await s.browser).close().catch(() => { });
}
/** Runs `fn` over `items` with at most `limit` in flight, started in input order; each item's promise settles
 *  independently — so a caller can await them one by one while later ones keep running in the background. */
export function mapLimitSettled(items, limit, fn) {
    let active = 0;
    const waiting = [];
    return items.map(async (item) => {
        if (active >= limit)
            await new Promise((resolve) => waiting.push(resolve));
        active++;
        try {
            return await fn(item);
        }
        finally {
            active--;
            waiting.shift()?.();
        }
    });
}
// Three ways to get a page: attach to the user's running browser, launch a persistent profile, or
// reuse the shared throwaway browser (the default). Returns the page plus how to release it: attaching must
// disconnect (never close the user's Chrome) and only close the tab it opened.
async function openPage(spec, opts) {
    const contextOptions = browserContextOptions(spec, opts);
    if (opts.cdp) {
        const browser = await chromium.connectOverCDP(opts.cdp);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const tab = await context.newPage(); // our own tab, so the user's current one is left alone
        // browser.close() on a connected browser only disconnects
        return { page: tab, close: async () => { await tab.close().catch(() => { }); await browser.close(); } };
    }
    if (opts.profile) {
        const context = await chromium.launchPersistentContext(opts.profile, { ...launchOptions(opts), ...contextOptions });
        return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
    }
    const browser = await sharedBrowser(opts);
    const context = await browser.newContext(contextOptions);
    return { page: await context.newPage(), close: () => context.close() };
}
export async function openSession(spec, opts, track) {
    const opened = await openPage(spec, opts);
    // Own directory per session so concurrent/consecutive specs never see each other's downloads.
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-downloads-'));
    // `page` is the *active* page — a popup can replace it mid-run (see the 'popup' handler below),
    // so every step below must read this variable rather than capturing the initial page.
    let page = opened.page;
    page.setDefaultTimeout(opts.timeout);
    // Over CDP the context is the user's live browser: keep the observer to our own tab, leave theirs alone.
    await installSettleObserver(opts.cdp ? page : page.context());
    const acceptDialogs = spec.dialogs !== 'dismiss';
    let pendingNotes = [];
    let noise = 0; // console noise since the last drain, reported as one note
    // Visible to Jev on every `expect`/`wait` (see the `events` field passed to judge() below), so
    // "a JavaScript error happened" or "a file was downloaded" become answerable from state Jev sees.
    const events = [];
    function note(msg) {
        msg = shortNote(msg);
        pushCollapsed(pendingNotes, msg);
        pushCollapsed(events, msg);
        if (events.length > MAX_EVENTS)
            events.shift();
    }
    // Registered on the initial page and, from the 'popup' handler below, on every popup that becomes
    // active — fixes the earlier limitation where only the first page had listeners.
    function attach(p) {
        p.on('dialog', async (dialog) => {
            note(`dialog(${dialog.type()}): "${dialog.message()}" → ${acceptDialogs ? 'accepted' : 'dismissed'}`);
            await (acceptDialogs ? dialog.accept() : dialog.dismiss());
        });
        p.on('popup', async (popup) => {
            const release = holdActivity(p); // the next step's settle waits until the new tab is the active page
            try {
                popup.setDefaultTimeout(opts.timeout);
                await popup.waitForLoadState('load').catch(() => { });
                note(`→ switched to new tab ${popup.url()}`);
                attach(popup);
                page = popup;
            }
            finally {
                release();
            }
        });
        p.on('download', async (download) => {
            const release = holdActivity(p); // the click that started it keeps waiting until the note is written
            try {
                // Per-session directory (created in openSession): isolates downloads across specs and runs.
                const dest = path.join(downloadsDir, download.suggestedFilename());
                await download.saveAs(dest);
                note(`download: "${download.suggestedFilename()}" saved to ${dest}`);
            }
            finally {
                release();
            }
        });
        p.on('pageerror', (err) => note(`pageerror: ${err.message}`));
        p.on('console', (msg) => {
            if (msg.type() !== 'error')
                return;
            if (isConsoleNoise(msg.text(), msg.location().url, p.url()))
                noise++;
            else
                note(`console.error: ${msg.text()}`);
        });
    }
    attach(page);
    const ctx = { get page() { return page; }, spec, timeout: opts.timeout, events, track, ms: {} };
    return {
        ctx,
        downloadsDir,
        drainNotes: () => {
            const out = pendingNotes.splice(0);
            if (noise)
                out.push(noiseNote(noise));
            noise = 0;
            return out;
        },
        close: async () => {
            // leave nothing behind, even if the context failed to close
            try {
                await opened.close();
            }
            finally {
                fs.rmSync(downloadsDir, { recursive: true, force: true });
            }
        },
    };
}
export async function runSpec(spec, opts, observer, info) {
    const deadline = specDeadline(spec.timeout ?? opts.specTimeout);
    const steps = [];
    let jevCalls = 0;
    let totalTokens = 0;
    let overall = 'pass';
    // Every Jev call site accounts for itself through this, so no step branch inlines the counters.
    const track = (tokens) => { jevCalls++; totalTokens += tokens; };
    // Forked (own process) and validated before the browser opens, so a broken hooks module fails
    // fast — no session to clean up yet.
    let hooksRunner = null;
    if (spec.hooks)
        hooksRunner = await startHooks(spec.hooks);
    let session;
    try {
        session = await openSession(spec, opts, track);
    }
    catch (error) {
        hooksRunner?.close();
        throw error;
    }
    const target = { engine: 'browser', cdp: !!opts.cdp, page: () => session.ctx.page,
        screenshot: async (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); await session.ctx.page.screenshot({ path: file, timeout: 10_000 }); } }; // capped: a step cut by the spec timeout may still hold the page
    const { picks, ...specInfo } = info ?? { file: spec.name, name: spec.name, tags: spec.tags ?? [], attempt: 0 };
    session.ctx.picks = picks;
    const observe = observerCalls(observer, specInfo);
    const record = async (result) => {
        const index = steps.push(result) - 1;
        await observe('stepEnd', { index, result, target });
    };
    await observe('sessionOpen', { target });
    // What setup returns, exposed to steps/teardown as `${hooks.*}`/`data` — `{}` when there's no hooks.
    let data = {};
    if (hooksRunner?.has.setup) {
        try {
            data = await hooksRunner.setup(spec);
            await record({ step: 'setup', status: 'pass' });
        }
        catch (err) {
            // Nothing ran yet, so there's nothing for teardown to release — just close the browser and the hooks child.
            const detail = err instanceof Error ? err.message : String(err);
            await record({ step: 'setup', status: 'error', detail });
            await observe('sessionClose', { status: 'error', target });
            await session.close();
            hooksRunner.close();
            return { name: spec.name, status: 'error', steps, jevCalls, totalTokens };
        }
    }
    try {
        let runSteps = spec.steps;
        try {
            const interpolated = interpolate({ url: spec.url, steps: spec.steps }, { env: spec.env ?? {}, hooks: data }, spec.name);
            session.ctx.spec = { ...spec, url: interpolated.url };
            runSteps = interpolated.steps;
        }
        catch (err) {
            overall = 'error';
            await record({ step: 'interpolate', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            runSteps = [];
        }
        for (const step of runSteps) {
            // ponytail: `optional: true` steps tolerate inconclusive/error (e.g. an intermittent cookie banner):
            // reported as skipped, and the run keeps going instead of failing the whole spec.
            let result = await deadline.step(() => runStepSafely(session.ctx, step), () => label(step));
            result = withCacheDump(result, picks?.endStep(result.status));
            const notes = session.drainNotes();
            if (notes.length)
                result = { ...result, detail: [result.detail, ...notes].filter(Boolean).join(' | ') };
            await record(result);
            if (result.status !== 'pass' && result.status !== 'skipped') {
                overall = result.status;
                break;
            }
        }
    }
    finally {
        // Runs if the module has a teardown — a cleanup failure must never be silent.
        if (hooksRunner) {
            try {
                if (hooksRunner.has.teardown) {
                    await hooksRunner.teardown({ spec, data, result: { status: overall, steps } });
                    await record({ step: 'teardown', status: 'pass' });
                }
            }
            catch (err) {
                overall = 'error';
                await record({ step: 'teardown', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            }
            finally {
                hooksRunner.close(); // the child never lingers past its one spec run
            }
        }
        if (overall === 'pass' && spec.browser?.saveState !== undefined) {
            try {
                const file = path.resolve(spec.dir, spec.browser.saveState);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                await session.ctx.page.context().storageState({ path: file });
            }
            catch (err) {
                overall = 'error';
                await record({ step: 'saveState', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            }
        }
        await observe('sessionClose', { status: overall, target });
        await session.close();
    }
    return { name: spec.name, status: overall, steps, jevCalls, totalTokens };
}
