import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { interpolate } from '../core/interpolate.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from '../core/snapshot-view.js';
import { startHooks, placeholderPaths } from '../core/hooks.js';
import { isFailure } from '../core/results.js';
import { serialQueue } from '../core/serial-queue.js';
import { jsonResult as ok, askResult, AskClaims, ASK_DESCRIPTION } from '../core/mcp-result.js';
import { ariaChanges, CHANGES_ENABLED, CHANGES_NOTE } from '../core/aria-changes.js';
import { READ_ENABLED, READ_DESCRIPTION } from '../core/read.js';
/** The desktop and mobile MCP servers: step, find, snapshot, ask, read, screenshot, save and close. */
export function createNativeServer(config) {
    const { session, ai, placeholderSource } = config;
    const adapter = session.adapter;
    const server = new McpServer({ name: config.name, version: config.version });
    const queue = serialQueue();
    let opened = false;
    let spec = config.spec;
    let transcript = [];
    let hooks;
    let data = {};
    let results = [];
    let overall = 'pass';
    /** The screen the last step's `changed` ended on. */
    let lastScreen = null;
    const requireOpen = () => {
        if (!opened)
            throw new Error('call open first');
    };
    const withPlaceholders = (value, values = data) => interpolate(value, { env: {}, hooks: values }, placeholderSource);
    const withOptionalPlaceholders = (value) => (value ? withPlaceholders(value) : undefined);
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
    config.registerPlatformTools({
        server,
        queue,
        withPlaceholders,
        async open(next, attach) {
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
        },
    });
    // `changed` diffs the screen before the step with the screen after it. A step that targets something already
    // captured the whole screen before acting (NativeSession.firstSnapshot): that is the before, since an exact
    // capture costs seconds on iOS. press, swipe and mouse never look first, so they capture one of their own. An
    // approximate target capture (iOS) lists covered elements and cannot be the before: the previous step's after
    // is, or right after open, a capture of its own.
    const capture = () => adapter.capture('region').then((frame) => frame.snapshot, () => null);
    const capturesBeforeActing = (step) => !['press', 'swipe', 'mouse'].includes(step.kind);
    async function screenBefore(step) {
        if (!CHANGES_ENABLED)
            return null;
        // Only a claim over the whole screen is sure to look first with an exact capture.
        const exactFirst = ['expect', 'wait'].includes(step.kind) && !step.within;
        const needsOwnCapture = !capturesBeforeActing(step) || (adapter.approximateTargets && !lastScreen && !exactFirst);
        return needsOwnCapture ? capture() : null;
    }
    async function changesSince(before) {
        if (!before)
            return {};
        const after = lastScreen = await capture();
        return after ? { changed: ariaChanges(before, after) } : {};
    }
    server.registerTool('step', {
        description: config.describe.step + CHANGES_NOTE,
        inputSchema: { step: z.record(z.string(), z.unknown()) },
    }, ({ step }) => queue(async () => {
        requireOpen();
        const parsed = session.parse(step);
        const tokensBefore = session.tokens;
        const ownBaseline = await screenBefore(parsed);
        const result = await session.run(withPlaceholders(parsed));
        results.push(result);
        if (isFailure(result.status))
            overall = result.status;
        if (result.status === 'pass')
            transcript.push(step);
        const changed = CHANGES_ENABLED ? await changesSince(ownBaseline ?? session.firstSnapshot ?? lastScreen) : {};
        return ok({ ...result, jevTokens: session.tokens - tokensBefore, ...changed });
    }));
    server.registerTool('find', {
        description: config.describe.find,
        inputSchema: { kind: z.enum(config.kinds), target: z.string().min(1) },
        annotations: { readOnlyHint: true },
    }, ({ kind, target }) => queue(async () => {
        requireOpen();
        // An approximate capture could report a covered element as found. A region find is exact anyway: only claim
        // regions are picked approximately, and asking would make the next step's target capture exact for nothing.
        if (kind !== 'region')
            adapter.preferExact?.();
        const [resolved] = await session.find(kind, [withPlaceholders(target)]);
        return ok({ found: resolved.element !== null, detail: resolved.detail, confidence: resolved.confidence, jevTokens: resolved.tokens });
    }));
    server.registerTool('snapshot', {
        description: config.describe.snapshot + SNAPSHOT_MODES_DESCRIPTION,
        inputSchema: { within: z.string().optional(), ...SnapshotOptions },
        annotations: { readOnlyHint: true },
    }, ({ within, maxChars, mode, intent }) => queue(async () => {
        requireOpen();
        const started = performance.now();
        const tokensBefore = session.tokens;
        const snap = await session.snapshot(withOptionalPlaceholders(within));
        const view = await snapshotView(snap, { maxChars, mode, intent }, ai.describe);
        const usage = mode !== 'raw' && 'jevTokens' in view ? {
            jevTokens: view.jevTokens === null ? null : view.jevTokens + session.tokens - tokensBefore,
            ms: { ...view.ms, total: performance.now() - started },
        } : {};
        return ok({ ...view, ...usage });
    }));
    server.registerTool('ask', {
        description: ASK_DESCRIPTION,
        inputSchema: { claims: AskClaims, within: z.string().min(1).optional() },
        annotations: { readOnlyHint: true },
    }, ({ claims, within }) => queue(async () => {
        requireOpen();
        const tokensBefore = session.tokens;
        const { snapshot, probabilities, ms } = await session.ask(withPlaceholders(claims), withOptionalPlaceholders(within));
        return ok({ ...askResult(claims, probabilities, snapshot), jevTokens: session.tokens - tokensBefore, ms });
    }));
    if (READ_ENABLED)
        server.registerTool('read', {
            description: READ_DESCRIPTION,
            inputSchema: { question: z.string().min(1), within: z.string().min(1).optional() },
            annotations: { readOnlyHint: true },
        }, ({ question, within }) => queue(async () => {
            requireOpen();
            const started = performance.now();
            const tokensBefore = session.tokens;
            const { tokens: _, ...answer } = await session.read(withPlaceholders(question), withOptionalPlaceholders(within));
            return ok({ ...answer, jevTokens: session.tokens - tokensBefore, ms: Math.round(performance.now() - started) });
        }));
    server.registerTool('screenshot', {
        description: config.describe.screenshot,
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, () => queue(async () => {
        requireOpen();
        return { content: [{ type: 'image', mimeType: 'image/png', data: (await adapter.screenshot()).toString('base64') }] };
    }));
    server.registerTool('save', {
        description: config.describe.save,
        inputSchema: { path: z.string().min(1), name: z.string().min(1).optional() },
    }, ({ path, name }) => queue(async () => {
        requireOpen();
        if (!transcript.length)
            throw new Error('No successful steps to save');
        const file = resolve(path);
        const doc = {
            name: name ?? spec.name,
            ...config.saved(spec),
            ...(spec.goal ? { goal: spec.goal } : {}),
            ...(spec.hooks ? { hooks: relative(dirname(file), spec.hooks) } : {}),
            steps: transcript,
        };
        writeFileSync(file, stringify(doc), { mode: 0o600 });
        return ok({ path: file, steps: transcript.length });
    }));
    server.registerTool('close', { description: config.describe.close, inputSchema: {} }, () => queue(async () => {
        await close();
        return ok({ closed: true });
    }));
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
    server.server.onclose = () => void shutdown();
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => void shutdown());
    await server.connect(new StdioServerTransport());
}
