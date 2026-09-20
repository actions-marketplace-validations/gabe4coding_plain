// Verify each archive as an isolated plugin-host cache, including first-run installation.
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'plainwright-plugins-'));
try {
  for (const name of ['plainwright', 'plainwright-computer']) {
    const plugin = join(dir, name);
    cpSync(join(root, 'plugins', name), plugin, { recursive: true, filter: (source) => !source.includes('/.runtime') });
    const manifest = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8'));
    const config = manifest.mcpServers[name];
    const args = config.args.map(v => v.replaceAll('${PLUGIN_ROOT}', plugin));
    const client = new Client({ name: 'isolated-plugin-smoke', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args, cwd: config.cwd.replaceAll('${PLUGIN_ROOT}', plugin), stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    await client.connect(transport, { timeout: 120000 });
    try {
      const tools = (await client.listTools()).tools.map(t => t.name);
      assert.equal(tools.length, name === 'plainwright' ? 6 : 8);
      if (name === 'plainwright') {
        const opened = await client.callTool({ name: 'open', arguments: { url: 'data:text/html,<main>Isolated browser plugin works</main>' } });
        assert.ok(!opened.isError, JSON.stringify(opened));
        const snap = await client.callTool({ name: 'snapshot', arguments: {} });
        assert.match(JSON.stringify(snap), /Isolated browser plugin works/);
      } else {
        const beforeOpen = await client.callTool({ name: 'snapshot', arguments: {} });
        assert.equal(beforeOpen.isError, true);
        assert.ok(tools.includes('screenshot'));
      }
      console.log(`${name}: isolated archive installation and MCP protocol passed`);
    } finally { await client.close(); }
    assert.doesNotMatch(stderr, /triggerUncaughtException|cleanup failed|teardown failed/);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
