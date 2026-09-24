import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { interpolate } from './spec.js';
import { runStepSafely, holdActivity } from './steps.js';
import { installSettleObserver } from './page.js';
import { startHooks } from './hooks.js';
const MAX_EVENTS = 30; // ponytail: cap what's sent to Jev as `events` — a long spec shouldn't grow this unbounded
// Ad-heavy sites log CSP violations that list every allowed domain (~4,500 chars each): sent to Jev with
// every judgment, they cost more tokens than the page. The head says what the error is.
const MAX_NOTE_CHARS = 300;
export function shortNote(msg) {
    return msg.length <= MAX_NOTE_CHARS ? msg : `${msg.slice(0, MAX_NOTE_CHARS)}… (${msg.length} chars)`;
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
    const contextOptions = {};
    if (spec.auth)
        contextOptions.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
    if (spec.geolocation) {
        contextOptions.geolocation = { latitude: spec.geolocation.lat, longitude: spec.geolocation.lon };
        contextOptions.permissions = ['geolocation'];
    }
    if (opts.cdp) {
        if (spec.auth || spec.geolocation) {
            throw new Error('--cdp attaches to an existing browser context: `auth` and `geolocation` in the spec are not supported there');
        }
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
            popup.setDefaultTimeout(opts.timeout);
            await popup.waitForLoadState('load').catch(() => { });
            note(`→ switched to new tab ${popup.url()}`);
            attach(popup);
            page = popup;
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
        p.on('console', (msg) => { if (msg.type() === 'error')
            note(`console.error: ${msg.text()}`); });
    }
    attach(page);
    const ctx = { get page() { return page; }, spec, timeout: opts.timeout, events, track, ms: {} };
    return {
        ctx,
        downloadsDir,
        drainNotes: () => pendingNotes.splice(0),
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
export async function runSpec(spec, opts) {
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
    const session = await openSession(spec, opts, track);
    // What setup returns, exposed to steps/teardown as `${hooks.*}`/`data` — `{}` when there's no hooks.
    let data = {};
    if (hooksRunner?.has.setup) {
        try {
            data = await hooksRunner.setup(spec);
            steps.push({ step: 'setup', status: 'pass' });
        }
        catch (err) {
            // Nothing ran yet, so there's nothing for teardown to release — just close the browser and the hooks child.
            await session.close();
            hooksRunner.close();
            const detail = err instanceof Error ? err.message : String(err);
            return { name: spec.name, status: 'error', steps: [{ step: 'setup', status: 'error', detail }], jevCalls, totalTokens };
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
            steps.push({ step: 'interpolate', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            runSteps = [];
        }
        for (const step of runSteps) {
            // ponytail: `optional: true` steps tolerate inconclusive/error (e.g. an intermittent cookie banner):
            // reported as skipped, and the run keeps going instead of failing the whole spec.
            let result = await runStepSafely(session.ctx, step);
            const notes = session.drainNotes();
            if (notes.length)
                result = { ...result, detail: [result.detail, ...notes].filter(Boolean).join(' | ') };
            steps.push(result);
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
                    steps.push({ step: 'teardown', status: 'pass' });
                }
            }
            catch (err) {
                overall = 'error';
                steps.push({ step: 'teardown', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            }
            finally {
                hooksRunner.close(); // the child never lingers past its one spec run
            }
        }
        await session.close();
    }
    return { name: spec.name, status: overall, steps, jevCalls, totalTokens };
}
