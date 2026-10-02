#!/usr/bin/env node
import { AppiumAdapter } from './adapter.js';
import { MobileSession, runMobileSpec } from './session.js';
import { loadMobileSpec } from './spec.js';
import { nativeCli } from '../native/native.js';
const appium = (values) => values.server ?? process.env.PLAINWRIGHT_APPIUM_URL ?? 'http://127.0.0.1:4723';
await nativeCli('plainwright-mobile', '[--server http://127.0.0.1:4723] ', 'mobile', {
    serve: async (timeout, values) => (await import('./mcp.js')).serveMobileMcp(timeout, appium(values)), // MCP SDK only when serving
    load: loadMobileSpec,
    meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
    run: (spec, timeout, values, observer, info, specTimeout) => runMobileSpec(spec, new MobileSession(new AppiumAdapter(appium(values), timeout, undefined, true), timeout), observer, info, specTimeout),
});
