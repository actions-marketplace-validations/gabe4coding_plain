import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Spec } from './spec.js';
import type { Status, StepResult } from './results.js';
export interface HookSpec { name: string; steps: unknown[]; }

// What a hooks module (`spec.hooks`) may export. Both are optional; anything else is rejected once
// imported, before the browser opens. Exported so the MCP server can lease the same module shape.
// No `page`: hooks run in their own child process (see hooks-child.ts), so only JSON-serializable
// arguments cross the IPC channel.
export interface HooksModule<S extends HookSpec = Spec> {
  setup?: (args: { spec: S }) => unknown;
  teardown?: (args: { spec: S; data: Record<string, unknown>; result: { status: Status; steps: StepResult[] } }) => unknown;
}

export type HooksRunner<S extends HookSpec = Spec> = {
  has: { setup: boolean; teardown: boolean };
  setup(spec: S): Promise<Record<string, unknown>>;
  teardown(args: { spec: S; data: Record<string, unknown>; result: { status: Status; steps: StepResult[] } }): Promise<void>;
  close(): void; // kills the child
};

type ChildReply = { type: string; ok?: boolean; data?: Record<string, unknown>; message?: string; has?: { setup: boolean; teardown: boolean } };

// Forks src/hooks-child.ts (compiled next to this file) to import and validate a hooks module in its
// own process — one child per spec run, so module-level state never leaks between specs and
// concurrent specs (--workers) never share a module instance. Shared by the batch runner and the MCP
// server's `open {hooks}`, so both fail the same way on a broken module. Requests are sequential
// (one in flight at a time): a simple one-pending-reply pattern is enough for setup/teardown.
export async function startHooks<S extends HookSpec = Spec>(file: string): Promise<HooksRunner<S>> {
  const child: ChildProcess = fork(fileURLToPath(new URL('./hooks-child.js', import.meta.url)), [file]);

  let pending: { resolve: (msg: ChildReply) => void; reject: (err: Error) => void } | null = null;
  const settle = (fn: (p: NonNullable<typeof pending>) => void) => { if (pending) fn(pending); pending = null; };
  child.on('message', (msg: ChildReply) => settle((p) => p.resolve(msg)));
  const onGone = (reason: string) => settle((p) => p.reject(new Error(`hooks child for ${file} ${reason}`)));
  child.on('exit', (code) => onGone(`exited (code ${code}) before responding`));
  child.on('error', (err) => onGone(`failed: ${err.message}`));
  // One request in flight at a time: the next message from the child is its reply.
  const call = (msg?: Record<string, unknown>): Promise<ChildReply> => {
    const reply = new Promise<ChildReply>((resolve, reject) => (pending = { resolve, reject }));
    if (msg) child.send(msg);
    return reply;
  };

  const first = await call(); // the child sends 'ready' or 'error' as soon as it has imported and validated the module
  if (first.type === 'error') {
    child.kill();
    throw new Error(first.message);
  }

  return {
    has: first.has ?? { setup: false, teardown: false },
    async setup(spec) {
      const reply = await call({ type: 'setup', spec });
      if (!reply.ok) throw new Error(reply.message);
      return reply.data ?? {};
    },
    async teardown(args) {
      const reply = await call({ type: 'teardown', ...args });
      if (!reply.ok) throw new Error(reply.message);
    },
    close: () => void child.kill(),
  };
}

// Leaf paths of `data` as `${hooks.a.b}` placeholders for an MCP `open` response — never the values
// themselves, since leased data can be credentials. Arrays and non-object leaves are leaves.
export function placeholderPaths(data: Record<string, unknown>, prefix = 'hooks'): string[] {
  return Object.entries(data).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ?
    placeholderPaths(v as Record<string, unknown>, `${prefix}.${k}`) : ['${' + prefix + '.' + k + '}']);
}
