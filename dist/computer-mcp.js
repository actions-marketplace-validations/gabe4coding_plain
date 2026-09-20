import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Xa11yAdapter } from './computer-adapter.js';
import { intelligence } from './automation.js';
import { ComputerSession } from './computer.js';
import { ComputerTargetSchema, parseComputerStep } from './computer-spec.js';
import { interpolate } from './spec.js';
import { startHooks } from './hooks.js';
// Desktop input is a shared resource. Serialize reads too: a second snapshot must not race an action.
export function serialQueue() {
    let tail = Promise.resolve();
    return (fn) => {
        const result = tail.then(fn);
        tail = result.catch(() => { });
        return result;
    };
}
function placeholders(data, prefix = 'hooks') {
    return Object.entries(data).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ?
        placeholders(v, `${prefix}.${k}`) : ['${' + prefix + '.' + k + '}']);
}
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function createComputerServer(adapter, timeout = 15000, ai = intelligence) {
    const server = new McpServer({ name: 'plainwright-computer', version: '0.1.0' });
    const session = new ComputerSession(adapter, timeout, ai);
    const queue = serialQueue();
    let opened = false;
    let spec = { name: 'computer session', app: '', dir: process.cwd(), env: {}, steps: [] };
    let transcript = [];
    let hooks;
    let data = {};
    let results = [];
    let overall = 'pass';
    const requireOpen = () => { if (!opened)
        throw new Error('call open first'); };
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
            await adapter.close();
        }
    }
    server.registerTool('apps', {
        description: 'List running desktop applications and process IDs without focusing them. Open an application yourself before attaching.',
        inputSchema: {}, annotations: { readOnlyHint: true },
    }, () => queue(async () => ok(await adapter.apps())));
    server.registerTool('open', {
        description: 'Attach to one running app by exact app name OR pid. activate defaults to true and brings a window forward; false only attaches. Starts a new recording, releasing the previous hooks lease. Optional hooks module supplies ${hooks.*} placeholders. Does not launch or quit applications.',
        inputSchema: { app: z.string().optional(), pid: z.number().int().positive().optional(), activate: z.boolean().default(true), hooks: z.string().optional() },
    }, (args) => queue(async () => {
        const target = ComputerTargetSchema.parse(args);
        await close();
        transcript = [];
        results = [];
        overall = 'pass';
        spec = { name: 'computer session', app: target.app ?? `pid:${target.pid}`, dir: process.cwd(), env: {}, steps: [], hooks: args.hooks ? resolve(args.hooks) : undefined };
        let setupDone = false;
        try {
            if (spec.hooks) {
                hooks = await startHooks(spec.hooks);
                if (hooks.has.setup)
                    data = await hooks.setup(spec);
            }
            setupDone = true;
            const app = await adapter.open(target, args.activate);
            spec.app = app.name;
            opened = true;
            return ok({ ...app, placeholders: placeholders(data) });
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
    }));
    server.registerTool('step', {
        description: 'One natural-language desktop action: {click:"the OK button"}, {fill:{target:"the editor",value:"hello"}}, {check:"the checkbox"}, {uncheck:"the checkbox"}, {hover:"the icon"}, {dblclick:"the file"}, {rightclick:"the row"}, {scroll:"down: the list"} (or up:), {press:"Control+a"}, {drag:{source:"the row",target:"the folder"}}, {mouse:{x:100,y:100}}, {expect:["claim"]}, {expect:{that:"claim",within:"the dialog"}}, {wait:"claim"}. optional:true tolerates errors/inconclusive as skipped. css=, goto, select and upload are browser-only. Jev picks at >=0.5 confidence (probability fallback); claims pass >=0.9, fail <=0.1. Rephrase inconclusive targets. Coordinates are logical desktop coordinates. Only passing steps are recorded; ${hooks.*} remain placeholders in saved YAML.',
        inputSchema: { step: z.record(z.string(), z.unknown()) },
    }, ({ step }) => queue(async () => {
        requireOpen();
        const parsed = parseComputerStep(step);
        const before = session.tokens;
        const resolved = interpolate(parsed, { env: {}, hooks: data }, 'computer MCP');
        const result = await session.run(resolved);
        results.push(result);
        if (result.status !== 'pass' && result.status !== 'skipped')
            overall = result.status;
        if (result.status === 'pass')
            transcript.push(step);
        return ok({ ...result, jevTokens: session.tokens - before });
    }));
    server.registerTool('find', {
        description: 'Ask Jev which desktop control matches a target without acting. No selector escape hatch.',
        inputSchema: { kind: z.enum(['click', 'fill', 'check', 'hover', 'region', 'scroll']), target: z.string().min(1) },
        annotations: { readOnlyHint: true },
    }, ({ kind, target }) => queue(async () => {
        requireOpen();
        const [r] = await session.find(kind, [interpolate(target, { env: {}, hooks: data }, 'computer MCP')]);
        return ok({ found: r.element !== null, detail: r.detail, confidence: r.confidence, jevTokens: r.tokens });
    }));
    server.registerTool('snapshot', {
        description: 'Read the attached app accessibility tree, optionally within a natural-language region. This reading is not recorded.',
        inputSchema: { within: z.string().optional(), maxChars: z.number().int().min(1).max(60000).default(20000) }, annotations: { readOnlyHint: true },
    }, ({ within, maxChars }) => queue(async () => {
        requireOpen();
        const snap = await session.snapshot(within ? interpolate(within, { env: {}, hooks: data }, 'computer MCP') : undefined);
        return ok({ ...snap, aria: snap.aria.slice(0, maxChars), truncated: snap.truncated || snap.aria.length > maxChars });
    }));
    server.registerTool('screenshot', {
        description: 'Capture an attached application window as a PNG for inspection. May require screen-recording permission. Screenshot pixels do not feed Jev targeting.',
        inputSchema: {}, annotations: { readOnlyHint: true },
    }, () => queue(async () => {
        requireOpen();
        return { content: [{ type: 'image', mimeType: 'image/png', data: (await adapter.screenshot()).toString('base64') }] };
    }));
    server.registerTool('save', {
        description: 'Write successful recorded steps as a replayable desktop YAML spec. Uses the app name instead of its ephemeral pid. Preserves hook placeholders and makes hooks path relative to the saved file.',
        inputSchema: { path: z.string().min(1), name: z.string().min(1).optional() },
    }, ({ path, name }) => queue(async () => {
        requireOpen();
        if (!transcript.length)
            throw new Error('No successful steps to save');
        const file = resolve(path);
        const doc = { name: name ?? spec.name, app: spec.app, ...(spec.hooks ? { hooks: relative(dirname(file), spec.hooks) } : {}), steps: transcript };
        writeFileSync(file, stringify(doc), { mode: 0o600 });
        return ok({ path: file, steps: transcript.length });
    }));
    server.registerTool('close', { description: 'Detach and run teardown. Leaves the desktop application running.', inputSchema: {} }, () => queue(async () => { await close(); return ok({ closed: true }); }));
    return { server, close: () => queue(close) };
}
export async function serveComputerMcp(timeout) {
    const { server, close } = createComputerServer(new Xa11yAdapter(timeout), timeout);
    const transport = new StdioServerTransport();
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
    await server.connect(transport);
}
