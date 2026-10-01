#!/usr/bin/env node
import { AppiumAdapter } from './mobile-adapter.js';
import { MobileSession, runMobileSpec } from './mobile.js';
import { loadMobileSpec } from './mobile-spec.js';
import { nativeCli } from './native.js';

const appium = (values: Record<string, string | undefined>) => values.server ?? process.env.PLAINWRIGHT_APPIUM_URL ?? 'http://127.0.0.1:4723';
await nativeCli('plainwright-mobile', '[--server http://127.0.0.1:4723] ', { server: { type: 'string' } }, 'mobile', {
  serve: async (timeout, values) => (await import('./mobile-mcp.js')).serveMobileMcp(timeout, appium(values)), // MCP SDK only when serving
  load: loadMobileSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
  run: (spec, timeout, values, observer, info, specTimeout) => runMobileSpec(spec,
    new MobileSession(new AppiumAdapter(appium(values), timeout, undefined, true), timeout), observer, info, specTimeout),
});
