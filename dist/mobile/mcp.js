import { resolve } from 'node:path';
import { z } from 'zod';
import { intelligence } from '../core/automation.js';
import { jsonResult as ok } from '../core/mcp-result.js';
import { createNativeServer, serveNative } from '../native/mcp.js';
import { AppiumAdapter, DEFAULT_APPIUM_URL } from './adapter.js';
import { MobileSession } from './session.js';
import { MobileTargetSchema } from './spec.js';
import { LocalMobileDiscovery, AppListingSchema } from './discovery.js';
const DESCRIPTIONS = {
    step: 'One mobile action: {tap:"the Sign in button"} (click alias), {fill:{target:"Email",value:"hello"}}, {longpress:"the row"}, ' +
        '{dblclick:"the image"}, {check:"the switch"}, {uncheck:"the switch"}, {scroll:"down: the list"}, {swipe:"left"} or ' +
        '{swipe:{direction:"up",within:"the panel"}}, {press:"Back"}, {expect:["claim"]}, {expect:{that:"claim",within:"the dialog"}}, ' +
        '{wait:"claim"}. fill replaces text or selects an iOS picker-wheel value. Back/Enter are Android only; Home/HideKeyboard work on ' +
        'both platforms. Scroll direction is content navigation; swipe direction is finger movement. Browser/desktop-only steps and css= ' +
        'are rejected. optional:true skips errors/inconclusive, never a definite failed assertion. Picks need confidence >=0.5 (probability ' +
        'fallback); claims pass >=0.9, fail <=0.1. Only passing steps are recorded; ${hooks.*} remain placeholders.',
    find: 'Ask Jev which mobile control matches a target without acting. No selector escape hatch.',
    snapshot: 'Read the device native UI tree, optionally within a natural-language region. To read a value, use `read` instead. ' +
        'This reading is not recorded.',
    screenshot: 'Capture the device screen as a PNG for inspection. Screenshot pixels do not feed Jev targeting.',
    save: 'Write successful recorded steps as a replayable mobile YAML spec with platform, device and app. Preserves hook placeholders ' +
        'and makes hooks path relative to the saved file.',
    close: 'Run teardown and delete the Appium session. Preserves app data; does not uninstall the app.',
};
const LIST_DEVICES_DESCRIPTION = 'Discover devices on this MCP host: connected Android devices/emulators via ADB and available iOS ' +
    'simulators via Xcode. Returns explicit IDs, readiness/state and per-platform setup errors. Local discovery only, even with a ' +
    'remote Appium URL; physical iPhones are not discovered. No open session or Jev key required. Does not boot or select devices.';
const LIST_APPS_DESCRIPTION = 'List installed apps on an explicit local Android device/emulator or booted iOS simulator. Returns app IDs ' +
    'for open and iOS display names. Android lists packages, including services that may not have a launchable UI. query filters ' +
    'ID/name; include_system defaults true. Results are paginated: pass nextOffset as offset. No Appium session/Jev key needed; never ' +
    'launches apps or changes a recording. Remote devices and physical iPhones are not supported by discovery.';
const OPEN_DESCRIPTION = 'Launch/activate an installed native app on an explicit iOS UDID or Android ADB serial through Appium. Requires ' +
    'platform (ios/android), device and app (bundle ID/package). Optional capabilities configure signing/activity. Preserves app data; ' +
    'starts a new recording and releases the previous hooks lease. Optional hooks supplies ${hooks.*} placeholders. Optional goal (what ' +
    'the whole flow is for, one sentence) settles vague targets toward it; claims never see it. Does not install apps, start emulators, ' +
    'or start Appium.';
export function createMobileServer(adapter, timeout = 15000, ai = intelligence, discovery = new LocalMobileDiscovery()) {
    return createNativeServer({
        name: 'plainwright-mobile',
        version: '0.1.19',
        placeholderSource: 'mobile MCP',
        ai,
        spec: { name: 'mobile session', platform: 'android', device: '', app: '', dir: process.cwd(), env: {}, steps: [] },
        session: new MobileSession(adapter, timeout, ai),
        kinds: ['click', 'fill', 'check', 'region', 'scroll'],
        saved: (spec) => ({
            platform: spec.platform,
            device: spec.device,
            app: spec.app,
            ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
        }),
        describe: DESCRIPTIONS,
        registerPlatformTools: ({ server, queue, open, withPlaceholders }) => {
            server.registerTool('list_devices', {
                description: LIST_DEVICES_DESCRIPTION,
                inputSchema: { platform: z.enum(['android', 'ios']).optional() },
                annotations: { readOnlyHint: true },
            }, ({ platform }) => queue(async () => ok(await discovery.listDevices(platform))));
            server.registerTool('list_apps', {
                description: LIST_APPS_DESCRIPTION,
                inputSchema: AppListingSchema.shape,
                annotations: { readOnlyHint: true },
            }, (args) => queue(async () => ok(await discovery.listApps(args))));
            server.registerTool('open', {
                description: OPEN_DESCRIPTION,
                inputSchema: { ...MobileTargetSchema.shape, hooks: z.string().min(1).optional(), goal: z.string().min(1).optional() },
            }, ({ hooks, goal, ...raw }) => queue(async () => {
                const target = MobileTargetSchema.parse(raw);
                const spec = { name: 'mobile session', ...target, dir: process.cwd(), env: {}, steps: [], hooks: hooks ? resolve(hooks) : undefined, goal };
                return open(spec, async (data) => {
                    const app = await adapter.open(withPlaceholders(target, data));
                    return { platform: app.platform, device: app.device, app: app.app };
                });
            }));
        },
    });
}
export async function serveMobileMcp(timeout, endpoint = DEFAULT_APPIUM_URL) {
    await serveNative(createMobileServer(new AppiumAdapter(endpoint, timeout, undefined, true), timeout));
}
