import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/**
 * Imports and checks a hooks module in its own child process (src/core/hooks-child.ts), one per spec run: module
 * state never leaks between specs, and concurrent specs never share a module instance. One request is in
 * flight at a time, so the child's next message is always the reply.
 */
export async function startHooks(file) {
    const child = fork(fileURLToPath(new URL('./hooks-child.js', import.meta.url)), [file]);
    let pending = null;
    const settle = (fn) => {
        if (pending)
            fn(pending);
        pending = null;
    };
    child.on('message', (reply) => settle((waiting) => waiting.resolve(reply)));
    const onGone = (reason) => settle((waiting) => waiting.reject(new Error(`hooks child for ${file} ${reason}`)));
    child.on('exit', (code) => onGone(`exited (code ${code}) before responding`));
    child.on('error', (error) => onGone(`failed: ${error.message}`));
    const request = (message) => {
        const reply = new Promise((resolve, reject) => (pending = { resolve, reject }));
        if (message)
            child.send(message);
        return reply;
    };
    const ready = await request(); // 'ready' or 'error', as soon as the module is imported and checked
    if (ready.type === 'error') {
        child.kill();
        throw new Error(ready.message);
    }
    return {
        has: ready.has ?? { setup: false, teardown: false },
        async setup(spec) {
            const reply = await request({ type: 'setup', spec });
            if (!reply.ok)
                throw new Error(reply.message);
            return reply.data ?? {};
        },
        async teardown(args) {
            const reply = await request({ type: 'teardown', ...args });
            if (!reply.ok)
                throw new Error(reply.message);
        },
        close: () => void child.kill(),
    };
}
/** The `${hooks.a.b}` placeholders `data` offers, for the MCP `open` result: never the values, which may be secrets. */
export function placeholderPaths(data, prefix = 'hooks') {
    return Object.entries(data).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
        ? placeholderPaths(value, `${prefix}.${key}`)
        : ['${' + prefix + '.' + key + '}']);
}
