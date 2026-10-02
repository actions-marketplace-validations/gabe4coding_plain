// The child process that runs one spec run's hooks module (forked by startHooks in src/core/hooks.ts). Only JSON
// crosses the IPC channel: a function or class instance in what `setup` returns is dropped.
import { pathToFileURL } from 'node:url';
import type { HooksModule } from './hooks.js';

const file = process.argv[2];
let hooks: HooksModule = {};

const send = (message: Record<string, unknown>): void => void process.send?.(message);
// Not imported from results.ts: this child process loads nothing it does not need.
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

process.on('disconnect', () => process.exit(0)); // never outlive the parent

process.on('message', async (message: { type: string; [key: string]: unknown }) => {
  if (message.type !== 'setup' && message.type !== 'teardown') return;
  try {
    if (message.type === 'setup') {
      const returned = hooks.setup ? await hooks.setup({ spec: message.spec as never }) : undefined;
      if (returned !== undefined && (returned === null || typeof returned !== 'object')) throw new Error('setup must return an object');
      send({ type: 'setup', ok: true, data: returned ?? {} });
    } else {
      await hooks.teardown?.({ spec: message.spec as never, data: message.data as Record<string, unknown>, result: message.result as never });
      send({ type: 'teardown', ok: true });
    }
  } catch (error) {
    send({ type: message.type, ok: false, message: errorMessage(error) });
  }
});

(async () => {
  try {
    hooks = await import(pathToFileURL(file).href);
    if (hooks.setup !== undefined && typeof hooks.setup !== 'function') throw new Error(`${file}: "setup" must be a function`);
    if (hooks.teardown !== undefined && typeof hooks.teardown !== 'function') throw new Error(`${file}: "teardown" must be a function`);
    send({ type: 'ready', has: { setup: typeof hooks.setup === 'function', teardown: typeof hooks.teardown === 'function' } });
  } catch (error) {
    send({ type: 'error', message: errorMessage(error) });
  }
})();
