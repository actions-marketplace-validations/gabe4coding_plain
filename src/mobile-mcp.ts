import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppiumAdapter, type MobileAdapter } from './mobile-adapter.js';
import { intelligence, type Intelligence } from './automation.js';
import { MobileSession } from './mobile.js';
import { MobileTargetSchema, parseMobileStep, type MobileSpec } from './mobile-spec.js';
import { interpolate } from './spec.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from './snapshot-view.js';
import { startHooks, type HooksRunner } from './hooks.js';
import type { StepResult, Status } from './results.js';
import { LocalMobileDiscovery, AppListingSchema, type MobileDiscovery } from './mobile-discovery.js';

// Device input is a shared resource. Serialize reads too: a second snapshot must not race an action.
import { serialQueue } from './serial-queue.js';
import { jsonResult as ok } from './mcp-result.js';
export { serialQueue } from './serial-queue.js';

function placeholders(data: Record<string, unknown>, prefix = 'hooks'): string[] {
  return Object.entries(data).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ?
    placeholders(v as Record<string, unknown>, `${prefix}.${k}`) : ['${' + prefix + '.' + k + '}']);
}

export function createMobileServer<T>(adapter: MobileAdapter<T>, timeout = 15000, ai: Intelligence = intelligence,
  discovery: MobileDiscovery = new LocalMobileDiscovery()) {
  const server = new McpServer({ name: 'plainwright-mobile', version: '0.1.2' });
  const session = new MobileSession(adapter, timeout, ai);
  const queue = serialQueue();
  let opened = false;
  let spec: MobileSpec = { name: 'mobile session', platform: 'android', device: '', app: '', dir: process.cwd(), env: {}, steps: [] };
  let transcript: Record<string, unknown>[] = [];
  let hooks: HooksRunner<MobileSpec> | undefined;
  let data: Record<string, unknown> = {};
  let results: StepResult[] = [];
  let overall: Status = 'pass';
  const requireOpen = () => { if (!opened) throw new Error('call open first'); };
  async function close() {
    opened = false;
    try { if (hooks?.has.teardown) await hooks.teardown({ spec, data, result: { status: overall, steps: results } }); }
    finally { hooks?.close(); hooks = undefined; data = {}; await adapter.close(); }
  }
  server.registerTool('list_devices', {
    description: 'Discover devices on this MCP host: connected Android devices/emulators via ADB and available iOS simulators via Xcode. Returns explicit IDs, readiness/state and per-platform setup errors. Local discovery only, even with a remote Appium URL; physical iPhones are not discovered. No open session or Jev key required. Does not boot or select devices.',
    inputSchema: { platform: z.enum(['android', 'ios']).optional() }, annotations: { readOnlyHint: true },
  }, ({ platform }) => queue(async () => ok(await discovery.listDevices(platform))));
  server.registerTool('list_apps', {
    description: 'List installed apps on an explicit local Android device/emulator or booted iOS simulator. Returns app IDs for open and iOS display names. Android lists packages, including services that may not have a launchable UI. query filters ID/name; include_system defaults true. Results are paginated: pass nextOffset as offset. No Appium session/Jev key needed; never launches apps or changes a recording. Remote devices and physical iPhones are not supported by discovery.',
    inputSchema: AppListingSchema.shape, annotations: { readOnlyHint: true },
  }, (args) => queue(async () => ok(await discovery.listApps(args))));
  server.registerTool('open', {
    description: 'Launch/activate an installed native app on an explicit iOS UDID or Android ADB serial through Appium. Requires platform (ios/android), device and app (bundle ID/package). Optional capabilities configure signing/activity. Preserves app data; starts a new recording and releases the previous hooks lease. Optional hooks supplies ${hooks.*} placeholders. Does not install apps, start emulators, or start Appium.',
    inputSchema: { ...MobileTargetSchema.shape, hooks: z.string().min(1).optional() },
  }, (args) => queue(async () => {
    const { hooks: hookPath, ...rawTarget } = args;
    const target = MobileTargetSchema.parse(rawTarget);
    await close();
    transcript = []; results = []; overall = 'pass';
    spec = { name: 'mobile session', ...target, dir: process.cwd(), env: {}, steps: [], hooks: hookPath ? resolve(hookPath) : undefined };
    let setupDone = false;
    try {
      if (spec.hooks) { hooks = await startHooks<MobileSpec>(spec.hooks); if (hooks.has.setup) data = await hooks.setup(spec); }
      setupDone = true;
      const resolved = interpolate(target, { env: {}, hooks: data }, 'mobile MCP');
      const app = await adapter.open(resolved);
      opened = true;
      return ok({ platform: app.platform, device: app.device, app: app.app, placeholders: placeholders(data) });
    } catch (error) {
      overall = 'error'; results.push({ step: setupDone ? 'open' : 'setup', status: 'error', detail: String(error) });
      if (!setupDone) { hooks?.close(); hooks = undefined; }
      try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Open and teardown failed'); }
      throw error;
    }
  }));
  server.registerTool('step', {
    description: 'One mobile action: {tap:"the Sign in button"} (click alias), {fill:{target:"Email",value:"hello"}}, {longpress:"the row"}, {dblclick:"the image"}, {check:"the switch"}, {uncheck:"the switch"}, {scroll:"down: the list"}, {swipe:"left"} or {swipe:{direction:"up",within:"the panel"}}, {press:"Back"}, {expect:["claim"]}, {expect:{that:"claim",within:"the dialog"}}, {wait:"claim"}. fill replaces text or selects an iOS picker-wheel value. Back/Enter are Android only; Home/HideKeyboard work on both platforms. Scroll direction is content navigation; swipe direction is finger movement. Browser/desktop-only steps and css= are rejected. optional:true skips errors/inconclusive, never a definite failed assertion. Picks need confidence >=0.5 (probability fallback); claims pass >=0.9, fail <=0.1. Only passing steps are recorded; ${hooks.*} remain placeholders.',
    inputSchema: { step: z.record(z.string(), z.unknown()) },
  }, ({ step }) => queue(async () => {
    requireOpen();
    const parsed = parseMobileStep(step);
    const before = session.tokens;
    const resolved = interpolate(parsed, { env: {}, hooks: data }, 'mobile MCP');
    const result = await session.run(resolved);
    results.push(result);
    if (result.status !== 'pass' && result.status !== 'skipped') overall = result.status;
    if (result.status === 'pass') transcript.push(step);
    return ok({ ...result, jevTokens: session.tokens - before });
  }));
  server.registerTool('find', {
    description: 'Ask Jev which mobile control matches a target without acting. No selector escape hatch.',
    inputSchema: { kind: z.enum(['click', 'fill', 'check', 'region', 'scroll']), target: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, ({ kind, target }) => queue(async () => {
    requireOpen();
    const [r] = await session.find(kind, [interpolate(target, { env: {}, hooks: data }, 'mobile MCP')]);
    return ok({ found: r.element !== null, detail: r.detail, confidence: r.confidence, jevTokens: r.tokens });
  }));
  server.registerTool('snapshot', {
    description: 'Read the device native UI tree, optionally within a natural-language region. This reading is not recorded.' + SNAPSHOT_MODES_DESCRIPTION,
    inputSchema: { within: z.string().optional(), ...SnapshotOptions }, annotations: { readOnlyHint: true },
  }, ({ within, maxChars, mode, intent }) => queue(async () => {
    requireOpen();
    const started = performance.now();
    const before = session.tokens;
    const snap = await session.snapshot(within ? interpolate(within, { env: {}, hooks: data }, 'mobile MCP') : undefined);
    const view = await snapshotView(snap, { maxChars, mode, intent }, ai.describe);
    return ok({ ...view, ...(mode !== 'raw' && 'jevTokens' in view ? {
      jevTokens: view.jevTokens === null ? null : view.jevTokens + session.tokens - before,
      ms: { ...view.ms, total: performance.now() - started },
    } : {}) });
  }));
  server.registerTool('screenshot', {
    description: 'Capture the device screen as a PNG for inspection. Screenshot pixels do not feed Jev targeting.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, () => queue(async () => {
    requireOpen();
    return { content: [{ type: 'image' as const, mimeType: 'image/png', data: (await adapter.screenshot()).toString('base64') }] };
  }));
  server.registerTool('save', {
    description: 'Write successful recorded steps as a replayable mobile YAML spec with platform, device and app. Preserves hook placeholders and makes hooks path relative to the saved file.',
    inputSchema: { path: z.string().min(1), name: z.string().min(1).optional() },
  }, ({ path, name }) => queue(async () => {
    requireOpen();
    if (!transcript.length) throw new Error('No successful steps to save');
    const file = resolve(path);
    const doc = { name: name ?? spec.name, platform: spec.platform, device: spec.device, app: spec.app, ...(spec.capabilities ? { capabilities: spec.capabilities } : {}), ...(spec.hooks ? { hooks: relative(dirname(file), spec.hooks) } : {}), steps: transcript };
    writeFileSync(file, stringify(doc), { mode: 0o600 });
    return ok({ path: file, steps: transcript.length });
  }));
  server.registerTool('close', { description: 'Run teardown and delete the Appium session. Preserves app data; does not uninstall the app.', inputSchema: {} }, () => queue(async () => { await close(); return ok({ closed: true }); }));
  return { server, close: () => queue(close) };
}

export async function serveMobileMcp(timeout: number, endpoint = 'http://127.0.0.1:4723') {
  const { server, close } = createMobileServer(new AppiumAdapter(endpoint, timeout), timeout);
  const transport = new StdioServerTransport();
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try { await close(); } catch (error) { console.error(error); process.exitCode = 1; }
    await server.close();
  }
  server.server.onclose = () => { void shutdown(); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await server.connect(transport);
}
