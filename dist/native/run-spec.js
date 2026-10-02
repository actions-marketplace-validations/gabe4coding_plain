import fs from 'node:fs';
import path from 'node:path';
import { startHooks } from '../core/hooks.js';
import { isFailure } from '../core/results.js';
import { withCacheDump } from '../core/pick-cache.js';
import { observerCalls } from '../suite/observe.js';
import { specDeadline } from '../suite/spec-timeout.js';
/**
 * hooks setup → `open` (interpolates, attaches the app or device, returns the resolved steps) → steps → teardown →
 * close. Observers see the session only once `open` has attached it.
 */
export async function runNativeSpec(spec, session, open, observer, info, specTimeout) {
    const deadline = specDeadline(spec.timeout ?? specTimeout, performance.now());
    const steps = [];
    const { picks, ...specInfo } = info ?? { file: spec.name, name: spec.name, tags: spec.tags ?? [], attempt: 0 };
    session.picks = picks;
    session.goal = spec.goal;
    const observe = observerCalls(observer, specInfo);
    const target = {
        engine: 'platform' in spec ? 'mobile' : 'desktop',
        screenshot: async (file) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, await session.adapter.screenshot());
        },
    };
    let opened = false;
    const record = async (result) => {
        const index = steps.push(result) - 1;
        if (opened)
            await observe('stepEnd', { index, result, target });
    };
    let status = 'pass';
    let hooks;
    let data = {};
    let setupDone = false;
    try {
        if (spec.hooks) {
            hooks = await startHooks(spec.hooks);
            if (hooks.has.setup)
                data = await hooks.setup(spec);
        }
        setupDone = true;
        const runSteps = await open({ env: spec.env, hooks: data });
        opened = true;
        await observe('sessionOpen', { target });
        for (const step of runSteps) {
            const ran = await deadline.step(() => session.run(step), () => session.label(step));
            const result = withCacheDump(ran, picks?.endStep(ran.status));
            await record(result);
            if (isFailure(result.status)) {
                status = result.status;
                break;
            }
        }
    }
    catch (error) {
        status = 'error';
        await record({ step: setupDone ? 'open/interpolate' : 'setup', status, detail: String(error) });
    }
    finally {
        try {
            if (setupDone && hooks?.has.teardown)
                await hooks.teardown({ spec, data, result: { status, steps } });
        }
        catch (error) {
            status = 'error';
            await record({ step: 'teardown', status, detail: String(error) });
        }
        finally {
            hooks?.close();
            if (opened)
                await observe('sessionClose', { status, target });
            try {
                await session.adapter.close();
            }
            catch (error) {
                status = 'error';
                steps.push({ step: 'close', status, detail: String(error) });
            }
        }
    }
    return { name: spec.name, status, steps, jevCalls: session.calls, totalTokens: session.tokens };
}
