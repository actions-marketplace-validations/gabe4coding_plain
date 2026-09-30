import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { interpolate } from './spec.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from './snapshot-view.js';
import { startHooks, placeholderPaths } from './hooks.js';
import { serialQueue } from './serial-queue.js';
import { jsonResult as ok, askResult, AskClaims, ASK_DESCRIPTION } from './mcp-result.js';
import { ariaChanges, CHANGES, CHANGES_NOTE } from './aria-changes.js';
import { READ, READ_DESCRIPTION } from './read.js';
// The desktop and mobile MCP servers: step, find, snapshot, screenshot, save and close are shared;
// `tools` registers the platform's own (open, discovery) first, so tool order stays as documented.
export function createNativeServer(cfg) {
    const { session, ai, where } = cfg;
    const adapter = session.adapter;
    const server = new McpServer({ name: cfg.name, version: cfg.version });
    const queue = serialQueue();
    let opened = false;
    let spec = cfg.spec;
    let transcript = [];
    let hooks;
    let data = {};
    let results = [];
    // The screen the last step's `changed` ended on: the before of a step whose own first capture was approximate.
    let lastScreen = null;
    let overall = 'pass';
    const requireOpen = () => { if (!opened)
        throw new Error('call open first'); };
    const fill = (value) => interpolate(value, { env: {}, hooks: data }, where);
    async function close() {
        opened = false;
        try {
            if (hooks?.has.teardown)
                await hooks.teardown({ spec, data, result: { status: overall, steps: results } });
        }
        finally {
            hooks?.close();
            hooks = undefined;
            data = {};
            lastScreen = null;
            await adapter.close();
        }
    }
    cfg.tools({ server, queue, async open(next, attach) {
            await close();
            transcript = [];
            results = [];
            overall = 'pass';
            spec = next;
            session.goal = next.goal;
            let setupDone = false;
            try {
                if (spec.hooks) {
                    hooks = await startHooks(spec.hooks);
                    if (hooks.has.setup)
                        data = await hooks.setup(spec);
                }
                setupDone = true;
                const app = await attach(data);
                opened = true;
                return ok({ ...app, placeholders: placeholderPaths(data) });
            }
            catch (error) {
                overall = 'error';
                results.push({ step: setupDone ? 'open' : 'setup', status: 'error', detail: String(error) });
                if (!setupDone) {
                    hooks?.close();
                    hooks = undefined;
                }
                try {
                    await close();
                }
                catch (cleanup) {
                    throw new AggregateError([error, cleanup], 'Open and teardown failed');
                }
                throw error;
            }
        } });
    // `changed`: the same diff as the browser's (src/aria-changes.ts), between the screen before the step and after
    // it. A step that targets something captured the whole screen before acting (NativeSession.firstSnapshot):
    // that is the before, since an exact capture costs 0.5-3.5 s on iOS. press, swipe and mouse never look first,
    // so they get a capture of their own. An approximate target capture (iOS, AppiumAdapter) also lists covered
    // elements and cannot be the before: the previous step's after is, or, right after open, a capture of its own.
    // The after capture waits for the UI to go idle like any capture.
    const capture = () => adapter.capture('region').then((f) => f.snapshot, () => null);
    const looksFirst = (step) => !['press', 'swipe', 'mouse'].includes(step.kind);
    async function changes(before) {
        if (!before)
            return {};
        const after = lastScreen = await capture();
        return after ? { changed: ariaChanges(before, after) } : {};
    }
    server.registerTool('step', { description: cfg.describe.step + CHANGES_NOTE, inputSchema: { step: z.record(z.string(), z.unknown()) } }, ({ step }) => queue(async () => {
        requireOpen();
        const parsed = session.parse(step);
        const before = session.tokens;
        // Only a claim over the whole screen is sure to look first with an exact capture.
        const exactFirst = ['expect', 'wait'].includes(parsed.kind) && !parsed.within;
        const screen = CHANGES && (!looksFirst(parsed) || (adapter.approximateTargets && !lastScreen && !exactFirst)) ? await capture() : null;
        const result = await session.run(fill(parsed));
        results.push(result);
        if (result.status !== 'pass' && result.status !== 'skipped')
            overall = result.status;
        if (result.status === 'pass')
            transcript.push(step);
        return ok({ ...result, jevTokens: session.tokens - before, ...(CHANGES ? await changes(screen ?? session.firstSnapshot ?? lastScreen) : {}) });
    }));
    server.registerTool('find', {
        description: cfg.describe.find, inputSchema: { kind: z.enum(cfg.kinds), target: z.string().min(1) }, annotations: { readOnlyHint: true },
    }, ({ kind, target }) => queue(async () => {
        requireOpen();
        // An approximate capture could report a covered element as found. A region find is exact anyway (only claim
        // regions are picked approximately, NativeSession.region(within, true)); asking would leave the flag unused,
        // and it would make the next step's target capture exact for nothing.
        if (kind !== 'region')
            adapter.preferExact?.();
        const [r] = await session.find(kind, [fill(target)]);
        return ok({ found: r.element !== null, detail: r.detail, confidence: r.confidence, jevTokens: r.tokens });
    }));
    server.registerTool('snapshot', {
        description: cfg.describe.snapshot + SNAPSHOT_MODES_DESCRIPTION,
        inputSchema: { within: z.string().optional(), ...SnapshotOptions }, annotations: { readOnlyHint: true },
    }, ({ within, maxChars, mode, intent }) => queue(async () => {
        requireOpen();
        const started = performance.now();
        const before = session.tokens;
        const snap = await session.snapshot(within ? fill(within) : undefined);
        const view = await snapshotView(snap, { maxChars, mode, intent }, ai.describe);
        return ok({ ...view, ...(mode !== 'raw' && 'jevTokens' in view ? {
                jevTokens: view.jevTokens === null ? null : view.jevTokens + session.tokens - before,
                ms: { ...view.ms, total: performance.now() - started },
            } : {}) });
    }));
    server.registerTool('ask', {
        description: ASK_DESCRIPTION, inputSchema: { claims: AskClaims, within: z.string().min(1).optional() }, annotations: { readOnlyHint: true },
    }, ({ claims, within }) => queue(async () => {
        requireOpen();
        const before = session.tokens;
        const { snapshot, probabilities, ms } = await session.ask(fill(claims), within ? fill(within) : undefined);
        return ok({ ...askResult(claims, probabilities, snapshot), jevTokens: session.tokens - before, ms });
    }));
    if (READ)
        server.registerTool('read', {
            description: READ_DESCRIPTION, inputSchema: { question: z.string().min(1), within: z.string().min(1).optional() }, annotations: { readOnlyHint: true },
        }, ({ question, within }) => queue(async () => {
            requireOpen();
            const started = performance.now();
            const before = session.tokens;
            const { tokens: _, ...result } = await session.read(fill(question), within ? fill(within) : undefined);
            return ok({ ...result, jevTokens: session.tokens - before, ms: Math.round(performance.now() - started) });
        }));
    server.registerTool('screenshot', { description: cfg.describe.screenshot, inputSchema: {}, annotations: { readOnlyHint: true } }, () => queue(async () => {
        requireOpen();
        return { content: [{ type: 'image', mimeType: 'image/png', data: (await adapter.screenshot()).toString('base64') }] };
    }));
    server.registerTool('save', {
        description: cfg.describe.save, inputSchema: { path: z.string().min(1), name: z.string().min(1).optional() },
    }, ({ path, name }) => queue(async () => {
        requireOpen();
        if (!transcript.length)
            throw new Error('No successful steps to save');
        const file = resolve(path);
        const doc = { name: name ?? spec.name, ...cfg.saved(spec), ...(spec.goal ? { goal: spec.goal } : {}), ...(spec.hooks ? { hooks: relative(dirname(file), spec.hooks) } : {}), steps: transcript };
        writeFileSync(file, stringify(doc), { mode: 0o600 });
        return ok({ path: file, steps: transcript.length });
    }));
    server.registerTool('close', { description: cfg.describe.close, inputSchema: {} }, () => queue(async () => { await close(); return ok({ closed: true }); }));
    return { server, close: () => queue(close) };
}
export async function serveNative({ server, close }) {
    let stopping = false;
    async function shutdown() {
        if (stopping)
            return;
        stopping = true;
        try {
            await close();
        }
        catch (error) {
            console.error(error);
            process.exitCode = 1;
        }
        await server.close();
    }
    server.server.onclose = () => { void shutdown(); };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    await server.connect(new StdioServerTransport());
}
