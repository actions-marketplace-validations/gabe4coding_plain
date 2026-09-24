import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Intelligence } from './automation.js';
import type { NativeSession, NativeAdapter } from './native.js';
import { interpolate } from './spec.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from './snapshot-view.js';
import { startHooks, placeholderPaths, type HooksRunner, type HookSpec } from './hooks.js';
import type { StepResult, Status } from './results.js';
import { serialQueue } from './serial-queue.js';
import { jsonResult as ok, askResult, AskClaims, ASK_DESCRIPTION } from './mcp-result.js';

type Spec = HookSpec & { hooks?: string };
type Tools<S extends Spec> = {
  server: McpServer;
  // Desktop/device input is a shared resource. Serialize reads too: a second snapshot must not race an action.
  queue: ReturnType<typeof serialQueue>;
  /** Starts a new recording of `spec`: releases the previous hooks lease, runs setup, then `attach` (the platform's open). */
  open(spec: S, attach: (data: Record<string, unknown>) => Promise<object>): Promise<ReturnType<typeof ok>>;
};

// The desktop and mobile MCP servers: step, find, snapshot, screenshot, save and close are shared;
// `tools` registers the platform's own (open, discovery) first, so tool order stays as documented.
export function createNativeServer<S extends Spec>(cfg: {
  name: string; version: string; where: string; spec: S; ai: Intelligence;
  session: NativeSession<unknown, string, { kind: string; optional?: boolean }, NativeAdapter<unknown, string>>;
  kinds: [string, ...string[]];
  describe: { step: string; find: string; snapshot: string; screenshot: string; save: string; close: string };
  saved: (spec: S) => Record<string, unknown>;
  tools: (t: Tools<S>) => void;
}) {
  const { session, ai, where } = cfg;
  const adapter = session.adapter;
  const server = new McpServer({ name: cfg.name, version: cfg.version });
  const queue = serialQueue();
  let opened = false;
  let spec = cfg.spec;
  let transcript: Record<string, unknown>[] = [];
  let hooks: HooksRunner<S> | undefined;
  let data: Record<string, unknown> = {};
  let results: StepResult[] = [];
  let overall: Status = 'pass';
  const requireOpen = () => { if (!opened) throw new Error('call open first'); };
  const fill = <V>(value: V) => interpolate(value, { env: {}, hooks: data }, where);
  async function close() {
    opened = false;
    try { if (hooks?.has.teardown) await hooks.teardown({ spec, data, result: { status: overall, steps: results } }); }
    finally { hooks?.close(); hooks = undefined; data = {}; await adapter.close(); }
  }
  cfg.tools({ server, queue, async open(next, attach) {
    await close();
    transcript = []; results = []; overall = 'pass'; spec = next;
    let setupDone = false;
    try {
      if (spec.hooks) { hooks = await startHooks<S>(spec.hooks); if (hooks.has.setup) data = await hooks.setup(spec); }
      setupDone = true;
      const app = await attach(data);
      opened = true;
      return ok({ ...app, placeholders: placeholderPaths(data) });
    } catch (error) {
      overall = 'error'; results.push({ step: setupDone ? 'open' : 'setup', status: 'error', detail: String(error) });
      if (!setupDone) { hooks?.close(); hooks = undefined; }
      try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Open and teardown failed'); }
      throw error;
    }
  } });
  server.registerTool('step', { description: cfg.describe.step, inputSchema: { step: z.record(z.string(), z.unknown()) } }, ({ step }) => queue(async () => {
    requireOpen();
    const parsed = session.parse(step);
    const before = session.tokens;
    const result = await session.run(fill(parsed));
    results.push(result);
    if (result.status !== 'pass' && result.status !== 'skipped') overall = result.status;
    if (result.status === 'pass') transcript.push(step);
    return ok({ ...result, jevTokens: session.tokens - before });
  }));
  server.registerTool('find', {
    description: cfg.describe.find, inputSchema: { kind: z.enum(cfg.kinds), target: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, ({ kind, target }) => queue(async () => {
    requireOpen();
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
  server.registerTool('screenshot', { description: cfg.describe.screenshot, inputSchema: {}, annotations: { readOnlyHint: true } }, () => queue(async () => {
    requireOpen();
    return { content: [{ type: 'image' as const, mimeType: 'image/png', data: (await adapter.screenshot()).toString('base64') }] };
  }));
  server.registerTool('save', {
    description: cfg.describe.save, inputSchema: { path: z.string().min(1), name: z.string().min(1).optional() },
  }, ({ path, name }) => queue(async () => {
    requireOpen();
    if (!transcript.length) throw new Error('No successful steps to save');
    const file = resolve(path);
    const doc = { name: name ?? spec.name, ...cfg.saved(spec), ...(spec.hooks ? { hooks: relative(dirname(file), spec.hooks) } : {}), steps: transcript };
    writeFileSync(file, stringify(doc), { mode: 0o600 });
    return ok({ path: file, steps: transcript.length });
  }));
  server.registerTool('close', { description: cfg.describe.close, inputSchema: {} }, () => queue(async () => { await close(); return ok({ closed: true }); }));
  return { server, close: () => queue(close) };
}

export async function serveNative({ server, close }: { server: McpServer; close: () => Promise<void> }) {
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
  await server.connect(new StdioServerTransport());
}
