// Verify each plugin as a plugin host runs it: the manifests agree, the MCP configs run the plugin's npx shim on
// the package version in package.json, and that command starts the MCP server from a fresh npx install of the
// packed package (`npm pack`, so exactly the files and the shrinkwrap that `npm publish` would send).
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { npxArgs } from './build-plugins.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name: PACKAGE, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'plainwright-plugins-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', dir],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }));
  const files = packed[0].files.map((file) => file.path);
  assert.ok(files.includes('npm-shrinkwrap.json'), 'the package ships the lockfile as npm-shrinkwrap.json');
  assert.ok(files.includes('dist/cli.js') && files.includes('bin/plainwright.mjs'));
  assert.deepEqual(files.filter((file) => file.endsWith('.test.js') || file.startsWith('src/') || file.startsWith('plugins/')), []);
  const tarball = join(dir, packed[0].filename);
  // The command of a config, with the registry package swapped for the local tarball.
  const local = (args) => args.map((arg) => arg === `--package=${PACKAGE}@${version}` ? `--package=${tarball}` : arg);

  for (const name of ['plainwright', 'plainwright-computer', 'plainwright-mobile']) {
    const plugin = join(dir, name);
    cpSync(join(root, 'plugins', name), plugin, { recursive: true });
    const identities = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'].map(file => {
      const { name, version, description } = JSON.parse(readFileSync(join(plugin, file), 'utf8'));
      return { name, version, description };
    });
    assert.deepEqual(identities[0], identities[1]);
    assert.deepEqual(identities[0], identities[2]);
    assert.equal(identities[0].version, version, `${name}: plugin version must equal the package version`);
    const config = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8')).mcpServers[name];
    const claude = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')).mcpServers[name];
    assert.deepEqual([config.command, config.cwd, ...config.args], ['node', '${PLUGIN_ROOT}', 'bin/npx.mjs', ...npxArgs(name)]);
    assert.deepEqual([claude.command, ...claude.args], ['node', '${CLAUDE_PLUGIN_ROOT}/bin/npx.mjs', ...npxArgs(name)]);
    const client = new Client({ name: 'isolated-plugin-smoke', version: '1' });
    // The plugin copy has no package.json or node_modules: npx must not need a checkout.
    const transport = new StdioClientTransport({ command: process.execPath, args: local(config.args), cwd: plugin, stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    await client.connect(transport, { timeout: 300000 });
    try {
      const tools = (await client.listTools()).tools.map(t => t.name);
      assert.equal(tools.length, name === 'plainwright' ? 9 : name === 'plainwright-computer' ? 10 : 11);
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
      console.log(`${name}: npx install of the packed package and MCP protocol passed`);
    } finally { await client.close(); }
    assert.doesNotMatch(stderr, /triggerUncaughtException|cleanup failed|teardown failed/);
    if (name === 'plainwright-mobile') {
      const client = new Client({ name: 'claude-plugin-smoke', version: '1' });
      // Claude substitutes an absolute plugin root and can launch from an unrelated cwd.
      const transport = new StdioClientTransport({ command: process.execPath,
        args: local(claude.args).map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin)), cwd: dir, stderr: 'pipe' });
      transport.stderr.on('data', chunk => process.stderr.write(chunk));
      try {
        await client.connect(transport);
        assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
          ['ask', 'close', 'find', 'list_apps', 'list_devices', 'open', 'read', 'save', 'screenshot', 'snapshot', 'step']);
        const invalid = await client.callTool({ name: 'open', arguments: { platform: 'android', app: 'com.example.fixture' } });
        assert.equal(invalid.isError, true, 'No implicit device selection');
        assert.ok(!(await client.callTool({ name: 'close', arguments: {} })).isError);
        console.log(`${name}: Claude plugin entrypoint and tool discovery passed`);
      } finally { await client.close(); }
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
