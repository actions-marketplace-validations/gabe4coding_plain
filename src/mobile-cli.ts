#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { USER_ENV_FILE, provider, warmUp } from './jev.js';
import { AppiumAdapter } from './mobile-adapter.js';
import { MobileSession, runMobileSpec } from './mobile.js';
import { loadMobileSpec } from './mobile-spec.js';
import { serveMobileMcp } from './mobile-mcp.js';

for (const file of ['.env', USER_ENV_FILE]) {
  try { process.loadEnvFile(file); } catch { /* optional file */ }
}
try {
  const { values, positionals } = parseArgs({ options: { timeout: { type: 'string', default: '15000' }, server: { type: 'string' } }, allowPositionals: true });
  const timeout = Number(values.timeout);
  const server = values.server ?? process.env.PLAINWRIGHT_APPIUM_URL ?? 'http://127.0.0.1:4723';
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be a positive number of milliseconds');
  if (!positionals.length) throw new Error('usage: plainwright-mobile [--timeout 15000] [--server http://127.0.0.1:4723] mcp | <spec.yaml> [more.yaml ...]');
  warmUp(); // connect to Jev while the session starts
  if (positionals[0] === 'mcp') {
    if (positionals.length !== 1) throw new Error('mcp takes no positional arguments');
    await serveMobileMcp(timeout, server);
  } else {
    provider();
    // One device, one input stream: never run specs concurrently.
    let passed = true;
    for (const file of positionals) {
      try {
        const result = await runMobileSpec(loadMobileSpec(file), new MobileSession(new AppiumAdapter(server, timeout), timeout));
        console.log(JSON.stringify(result));
        if (result.status !== 'pass') passed = false;
      } catch (error) { console.error(`${file}: ${error}`); passed = false; }
    }
    process.exitCode = passed ? 0 : 1;
  }
} catch (error) { console.error(`plainwright-mobile: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; }
