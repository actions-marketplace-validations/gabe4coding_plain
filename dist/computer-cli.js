#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { USER_ENV_FILE, provider, warmUp } from './jev.js';
import { Xa11yAdapter } from './computer-adapter.js';
import { ComputerSession, runComputerSpec } from './computer.js';
import { loadComputerSpec } from './computer-spec.js';
import { serveComputerMcp } from './computer-mcp.js';
for (const file of ['.env', USER_ENV_FILE]) {
    try {
        process.loadEnvFile(file);
    }
    catch { /* optional file */ }
}
try {
    const { values, positionals } = parseArgs({ options: { timeout: { type: 'string', default: '15000' } }, allowPositionals: true });
    const timeout = Number(values.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error('--timeout must be a positive number of milliseconds');
    if (!positionals.length)
        throw new Error('usage: plainwright-computer [--timeout 15000] mcp | <spec.yaml> [more.yaml ...]');
    warmUp(); // connect to Jev while the session starts
    if (positionals[0] === 'mcp') {
        if (positionals.length !== 1)
            throw new Error('mcp takes no positional arguments');
        await serveComputerMcp(timeout);
    }
    else {
        provider();
        // One desktop, one input stream: never run specs concurrently.
        let passed = true;
        for (const file of positionals) {
            try {
                const result = await runComputerSpec(loadComputerSpec(file), new ComputerSession(new Xa11yAdapter(timeout), timeout));
                console.log(JSON.stringify(result));
                if (result.status !== 'pass')
                    passed = false;
            }
            catch (error) {
                console.error(`${file}: ${error}`);
                passed = false;
            }
        }
        process.exitCode = passed ? 0 : 1;
    }
}
catch (error) {
    console.error(`plainwright-computer: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
}
