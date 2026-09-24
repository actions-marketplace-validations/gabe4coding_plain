import { resolve } from 'node:path';
import { z } from 'zod';
import { Xa11yAdapter } from './computer-adapter.js';
import { intelligence } from './automation.js';
import { ComputerSession } from './computer.js';
import { ComputerTargetSchema } from './computer-spec.js';
import { createNativeServer, serveNative } from './native-mcp.js';
import { jsonResult as ok } from './mcp-result.js';
const blank = () => ({ name: 'computer session', app: '', dir: process.cwd(), env: {}, steps: [] });
export function createComputerServer(adapter, timeout = 15000, ai = intelligence) {
    return createNativeServer({
        name: 'plainwright-computer', version: '0.1.8', where: 'computer MCP', spec: blank(), ai,
        session: new ComputerSession(adapter, timeout, ai), kinds: ['click', 'fill', 'check', 'hover', 'region', 'scroll'],
        saved: (spec) => ({ app: spec.app }),
        describe: {
            step: 'One natural-language desktop action: {click:"the OK button"}, {fill:{target:"the editor",value:"hello"}}, {check:"the checkbox"}, {uncheck:"the checkbox"}, {hover:"the icon"}, {dblclick:"the file"}, {rightclick:"the row"}, {scroll:"down: the list"} (or up:), {press:"Control+a"}, {drag:{source:"the row",target:"the folder"}}, {mouse:{x:100,y:100}}, {expect:["claim"]}, {expect:{that:"claim",within:"the dialog"}}, {wait:"claim"}. optional:true tolerates errors/inconclusive as skipped. css=, goto, select and upload are browser-only. Jev picks at >=0.5 confidence (probability fallback); claims pass >=0.9, fail <=0.1. Rephrase inconclusive targets. Coordinates are logical desktop coordinates. Only passing steps are recorded; ${hooks.*} remain placeholders in saved YAML.',
            find: 'Ask Jev which desktop control matches a target without acting. No selector escape hatch.',
            snapshot: 'Read the attached app accessibility tree, optionally within a natural-language region. This reading is not recorded.',
            screenshot: 'Capture an attached application window as a PNG for inspection. May require screen-recording permission. Screenshot pixels do not feed Jev targeting.',
            save: 'Write successful recorded steps as a replayable desktop YAML spec. Uses the app name instead of its ephemeral pid. Preserves hook placeholders and makes hooks path relative to the saved file.',
            close: 'Detach and run teardown. Leaves the desktop application running.',
        },
        tools: ({ server, queue, open }) => {
            server.registerTool('apps', {
                description: 'List running desktop applications and process IDs without focusing them. Open an application yourself before attaching.',
                inputSchema: {}, annotations: { readOnlyHint: true },
            }, () => queue(async () => {
                const apps = await adapter.apps();
                return ok({ apps }, JSON.stringify(apps));
            }));
            server.registerTool('open', {
                description: 'Attach to one running app by exact app name OR pid. activate defaults to true and brings a window forward; false only attaches. Starts a new recording, releasing the previous hooks lease. Optional hooks module supplies ${hooks.*} placeholders. Does not launch or quit applications.',
                inputSchema: { app: z.string().optional(), pid: z.number().int().positive().optional(), activate: z.boolean().default(true), hooks: z.string().optional() },
            }, (args) => queue(async () => {
                const target = ComputerTargetSchema.parse(args);
                const spec = { ...blank(), app: target.app ?? `pid:${target.pid}`, hooks: args.hooks ? resolve(args.hooks) : undefined };
                return open(spec, async () => {
                    const app = await adapter.open(target, args.activate);
                    spec.app = app.name;
                    return app;
                });
            }));
        },
    });
}
export async function serveComputerMcp(timeout) {
    await serveNative(createComputerServer(new Xa11yAdapter(timeout), timeout));
}
