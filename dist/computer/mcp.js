import { resolve } from 'node:path';
import { z } from 'zod';
import { intelligence } from '../core/automation.js';
import { jsonResult as ok } from '../core/mcp-result.js';
import { createNativeServer, serveNative } from '../native/mcp.js';
import { Xa11yAdapter } from './adapter.js';
import { ComputerSession } from './session.js';
import { ComputerTargetSchema } from './spec.js';
const DESCRIPTIONS = {
    step: 'One natural-language desktop action: {click:"the OK button"}, {fill:{target:"the editor",value:"hello"}}, ' +
        '{check:"the checkbox"}, {uncheck:"the checkbox"}, {hover:"the icon"}, {dblclick:"the file"}, {rightclick:"the row"}, ' +
        '{scroll:"down: the list"} (or up:), {press:"Control+a"}, {drag:{source:"the row",target:"the folder"}}, {mouse:{x:100,y:100}}, ' +
        '{expect:["claim"]}, {expect:{that:"claim",within:"the dialog"}}, {wait:"claim"}. optional:true tolerates errors/inconclusive ' +
        'as skipped. css=, goto, select and upload are browser-only. Jev picks at >=0.5 confidence (probability fallback); claims pass ' +
        '>=0.9, fail <=0.1. Rephrase inconclusive targets. Coordinates are logical desktop coordinates. Only passing steps are recorded; ' +
        '${hooks.*} remain placeholders in saved YAML.',
    find: 'Ask Jev which desktop control matches a target without acting. No selector escape hatch.',
    snapshot: 'Read the attached app accessibility tree, optionally within a natural-language region. To read a value, use `read` instead. ' +
        'This reading is not recorded.',
    screenshot: 'Capture an attached application window as a PNG for inspection. May require screen-recording permission. ' +
        'Screenshot pixels do not feed Jev targeting.',
    save: 'Write successful recorded steps as a replayable desktop YAML spec. Uses the app name instead of its ephemeral pid. ' +
        'Preserves hook placeholders and makes hooks path relative to the saved file.',
    close: 'Detach and run teardown. Leaves the desktop application running.',
};
const APPS_DESCRIPTION = 'List running desktop applications and process IDs without focusing them. Open an application yourself before attaching.';
const OPEN_DESCRIPTION = 'Attach to one running app by exact app name OR pid. activate defaults to true and brings a window forward; ' +
    'false only attaches. Starts a new recording, releasing the previous hooks lease. Optional hooks module supplies ${hooks.*} ' +
    'placeholders. Optional goal (what the whole flow is for, one sentence) settles vague targets toward it; claims never see it. ' +
    'Does not launch or quit applications.';
const blankSpec = () => ({ name: 'computer session', app: '', dir: process.cwd(), env: {}, steps: [] });
export function createComputerServer(adapter, timeout = 15000, ai = intelligence) {
    return createNativeServer({
        name: 'plainwright-computer',
        version: '0.2.0',
        placeholderSource: 'computer MCP',
        spec: blankSpec(),
        ai,
        session: new ComputerSession(adapter, timeout, ai),
        kinds: ['click', 'fill', 'check', 'hover', 'region', 'scroll'],
        saved: (spec) => ({ app: spec.app }),
        describe: DESCRIPTIONS,
        registerPlatformTools: ({ server, queue, open }) => {
            server.registerTool('apps', {
                description: APPS_DESCRIPTION,
                inputSchema: {},
                annotations: { readOnlyHint: true },
            }, () => queue(async () => {
                const apps = await adapter.apps();
                return ok({ apps }, JSON.stringify(apps));
            }));
            server.registerTool('open', {
                description: OPEN_DESCRIPTION,
                inputSchema: {
                    app: z.string().optional(),
                    pid: z.number().int().positive().optional(),
                    activate: z.boolean().default(true),
                    hooks: z.string().optional(),
                    goal: z.string().min(1).optional(),
                },
            }, (args) => queue(async () => {
                const target = ComputerTargetSchema.parse(args);
                const spec = { ...blankSpec(), app: target.app ?? `pid:${target.pid}`, hooks: args.hooks ? resolve(args.hooks) : undefined, goal: args.goal };
                return open(spec, async () => {
                    const app = await adapter.open(target, args.activate);
                    spec.app = app.name; // `save` writes the name: a pid changes every launch
                    return app;
                });
            }));
        },
    });
}
export async function serveComputerMcp(timeout) {
    await serveNative(createComputerServer(new Xa11yAdapter(timeout), timeout));
}
