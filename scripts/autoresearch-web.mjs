#!/usr/bin/env node
// Real MCP calls and live Jev against disposable sites, with timing, tokens and independent DOM checks.
// node scripts/autoresearch-web.mjs --runs 3 --out /tmp/research.json
// --cli selects a baseline build; --observe records findings without failing the run.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSite, USER } from '../e2e/site.mjs';

const { values } = parseArgs({ options: {
  runs: { type: 'string', default: '3' },
  out: { type: 'string' },
  cli: { type: 'string' },
  observe: { type: 'boolean', default: false },
} });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const cli = values.cli ?? fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const report = [];
const problems = [];
const servers = [];
const client = new Client({ name: 'plain-autoresearch', version: '1' });
let local;
let run = 0;

const background = Array.from({ length: 180 }, (_, i) => `<button>Browse product ${i}</button>`).join('');
const pages = {
  modal: `<h1>Store</h1><main inert>${background}
<button onclick="document.querySelector('#result').textContent='BACKGROUND'">Continue</button></main>
<div role="dialog" aria-modal="true"><h2>Confirm choice</h2>
<button onclick="document.querySelector('#result').textContent='DIALOG'">Continue</button></div><p id="result" role="status"></p>`,
  fieldset: `<h1>Account</h1><fieldset disabled><label>Email<input id="disabled" type="email"></label>
<button>Save</button></fieldset><label>Email<input id="enabled" type="email"></label>`,
  editor: `<h1>Article editor</h1><label>Title<input></label>
<div contenteditable role="textbox" aria-label="Article body" style="border:1px solid;padding:20px"></div>`,
  shadow: `<h1>Shadow dialog</h1><div inert><x-menu></x-menu></div>
<button onclick="this.textContent='Done'">Continue</button><script>
customElements.define('x-menu',class extends HTMLElement {
  connectedCallback() { this.attachShadow({mode:'open'}).innerHTML='<button>Continue</button>'; }
});</script>`,
};

const STATE = `({
  text: document.body.innerText,
  values: [...document.querySelectorAll('input,[contenteditable]')].map(e => ({id: e.id, value: e.value ?? e.textContent})),
  tagged: [...document.querySelectorAll('[data-jev-id]')].length
})`;
const verify = {
  modal: v => v.text.includes('DIALOG') && !v.text.includes('BACKGROUND') && v.tagged === 1,
  fieldset: v => v.values[0].value === '' && v.values[1].value === 'research' && v.tagged === 1,
  editor: v => v.values[1].value === 'research',
  shadow: v => v.text.includes('Done'),
};

async function call(site, name, args) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const data = result.structuredContent ?? { error: result.content?.[0]?.text };
  const row = { run, site, name, args, ms: Math.round(performance.now() - start), isError: !!result.isError, data };
  report.push(row);
  console.log(JSON.stringify({ run, site, name, ms: row.ms, status: data.status ?? (result.isError ? 'error' : 'ok'), tokens: data.jevTokens ?? 0 }));
  if (result.isError || (data.status && data.status !== 'pass')) {
    problems.push({ run, site, name, detail: data.detail ?? data.error });
  }
  return data;
}

async function demoFlows() {
  await call('demo', 'open', { url: local.url + '/login' });
  await call('demo', 'batch', { steps: [
    { fill: { target: 'the Username field', value: USER.name } },
    { fill: { target: 'the Password field', value: USER.pass } },
    { click: 'the Login button' },
    { expect: 'the Secure Area heading is shown' },
  ] });
  await call('demo', 'open', { url: local.url + '/forms' });
  await call('demo', 'batch', { steps: [
    { select: { target: 'the Size dropdown', value: 'Large' } },
    { check: 'the Cheese checkbox' },
    { fill: { target: 'the Search field', value: 'research' } },
    { press: 'Enter' },
    { wait: 'Results for research is visible' },
  ] });
  await call('demo', 'open', { url: local.url + '/frames' });
  await call('demo', 'batch', { steps: [
    { fill: { target: 'the Comment textarea', value: 'research' } },
    { click: 'the Add one button' },
    { expect: 'Count: 1 is shown' },
  ] });
}

try {
  local = await startSite();
  const urls = {};
  for (const [name, body] of Object.entries(pages)) {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><title>${name}</title></head><body>${body}</body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    urls[name] = `http://127.0.0.1:${server.address().port}`;
  }
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--headless', '--timeout', '1800', 'mcp'],
    env: { ...process.env, PLAIN_RESEARCH_CLI: cli },
    stderr: 'inherit',
  }));
  for (run = 1; run <= runs; run++) {
    await demoFlows();
    for (const site of Object.keys(pages)) {
      await call(site, 'open', { url: urls[site] });
      const target = site === 'fieldset' ? 'the enabled Email field'
        : site === 'editor' ? 'the Article body textbox' : 'the Continue button';
      const step = site === 'fieldset' || site === 'editor' ? { fill: { target, value: 'research' } } : { click: target };
      await call(site, 'step', { step });
      const { value } = await call(site, 'evaluate', { js: STATE });
      if (!value || !verify[site](value)) problems.push({ run, site, name: 'DOM verification', state: value });
    }
  }
} catch (error) {
  problems.push({ run, name: 'research', detail: String(error) });
} finally {
  await client.close();
  if (local) await local.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
if (values.out) writeFileSync(values.out, JSON.stringify({ runs, cli, report, problems }, null, 2) + '\n');
console.log(JSON.stringify({ runs, calls: report.length, jevTokens: report.reduce((n, row) => n + (row.data.jevTokens ?? 0), 0),
  problems: problems.map(({ state: _state, ...problem }) => problem) }));
if (problems.length && !values.observe) process.exitCode = 1;
