import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Forks src/hooks-child.ts (compiled next to this file) to import and validate a hooks module in its
// own process — one child per spec run, so module-level state never leaks between specs and
// concurrent specs (--workers) never share a module instance. Shared by the batch runner and the MCP
// server's `open {hooks}`, so both fail the same way on a broken module. Requests are sequential
// (one in flight at a time): a simple one-pending-reply pattern is enough for setup/teardown.
export async function startHooks(file) {
    const child = fork(fileURLToPath(new URL('./hooks-child.js', import.meta.url)), [file]);
    let pending = null;
    const settle = (fn) => { if (pending)
        fn(pending); pending = null; };
    child.on('message', (msg) => settle((p) => p.resolve(msg)));
    const onGone = (reason) => settle((p) => p.reject(new Error(`hooks child for ${file} ${reason}`)));
    child.on('exit', (code) => onGone(`exited (code ${code}) before responding`));
    child.on('error', (err) => onGone(`failed: ${err.message}`));
    // One request in flight at a time: the next message from the child is its reply.
    const call = (msg) => {
        const reply = new Promise((resolve, reject) => (pending = { resolve, reject }));
        if (msg)
            child.send(msg);
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
            if (!reply.ok)
                throw new Error(reply.message);
            return reply.data ?? {};
        },
        async teardown(args) {
            const reply = await call({ type: 'teardown', ...args });
            if (!reply.ok)
                throw new Error(reply.message);
        },
        close: () => void child.kill(),
    };
}
// Leaf paths of `data` as `${hooks.a.b}` placeholders for an MCP `open` response — never the values
// themselves, since leased data can be credentials. Arrays and non-object leaves are leaves.
export function placeholderPaths(data, prefix = 'hooks') {
    return Object.entries(data).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ?
        placeholderPaths(v, `${prefix}.${k}`) : ['${' + prefix + '.' + k + '}']);
}
