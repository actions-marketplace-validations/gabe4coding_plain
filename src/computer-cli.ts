#!/usr/bin/env node
import { Xa11yAdapter } from './computer-adapter.js';
import { ComputerSession, runComputerSpec } from './computer.js';
import { loadComputerSpec } from './computer-spec.js';
import { nativeCli } from './native.js';

await nativeCli('plainwright-computer', '', {}, {
  serve: async (timeout) => (await import('./computer-mcp.js')).serveComputerMcp(timeout), // MCP SDK only when serving
  run: (file, timeout) => runComputerSpec(loadComputerSpec(file), new ComputerSession(new Xa11yAdapter(timeout), timeout)),
});
