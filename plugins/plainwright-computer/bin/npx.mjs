#!/usr/bin/env node
// Copied into each plugin as bin/npx.mjs by scripts/build-plugins.mjs: edit this file, not the copies.
// Runs `npx <args>` on this process's stdio, which is the MCP channel. Plugin hosts can start `node` on every
// platform, but on Windows `npx` is a .cmd script that some hosts cannot start without `cmd /c`.
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npx', ...args], { stdio: 'inherit' })
  : spawn('npx', args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(`plainwright: cannot start npx: ${error.message}`); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
