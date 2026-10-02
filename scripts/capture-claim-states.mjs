#!/usr/bin/env node
// Saves the accessibility snapshot of each UI state the claim benchmark judges (scripts/claim-states/<name>.json),
// so scripts/benchmark-claims.mjs runs on fixed pages. The actions are plain Playwright, no Jev: a state must
// be the same whatever the model does. Content pages are shared with the read benchmark (scripts/read-states/).
// Re-run only to refresh them (live sites change), then re-check the cases in scripts/claim-cases.json.
//   node scripts/capture-claim-states.mjs [--only <name>]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { snapshot, installSettleObserver, settle } from '../dist/browser/page.js';

const INTERNET = 'https://the-internet.herokuapp.com';
const login = async (page, username, password) => {
  await page.goto(`${INTERNET}/login`);
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('#flash');
};
const STATES = {
  'login-error': (page) => login(page, 'tomsmith', 'wrong-password'),
  // The demo's published credentials, as in examples/login.yaml.
  'login-ok': (page) => login(page, 'tomsmith', 'SuperSecretPassword!'),
  checkboxes: (page) => page.goto(`${INTERNET}/checkboxes`),
  dropdown: async (page) => {
    await page.goto(`${INTERNET}/dropdown`);
    await page.selectOption('#dropdown', '2');
  },
  'loading-before': (page) => page.goto(`${INTERNET}/dynamic_loading/2`),
  'loading-after': async (page) => {
    await page.goto(`${INTERNET}/dynamic_loading/2`);
    await page.click('#start button');
    await page.waitForSelector('#finish', { timeout: 15000 });
  },
  'controls-enabled': async (page) => {
    await page.goto(`${INTERNET}/dynamic_controls`);
    await page.click('#input-example button');
    await page.waitForSelector('#input-example input:enabled', { timeout: 15000 });
    await page.fill('#input-example input', 'hello');
  },
  todo: async (page) => {
    await page.goto('https://demo.playwright.dev/todomvc');
    for (const item of ['buy milk', 'call the bank', 'water the plants']) {
      await page.fill('.new-todo', item);
      await page.press('.new-todo', 'Enter');
    }
    await page.locator('.todo-list li').nth(1).locator('.toggle').check();
  },
};

const { values } = parseArgs({ options: { only: { type: 'string' } } });
mkdirSync(new URL('claim-states/', import.meta.url), { recursive: true });
const browser = await chromium.launch();
for (const [name, act] of Object.entries(STATES).filter(([n]) => !values.only || n === values.only)) {
  const page = await browser.newPage();
  await installSettleObserver(page);
  await act(page);
  await settle(page, 500, 5000);
  const snap = await snapshot(page);
  writeFileSync(new URL(`claim-states/${name}.json`, import.meta.url), JSON.stringify(snap));
  console.log(name, snap.aria.length, 'chars', snap.aria.split('\n').length, 'lines');
  await page.close();
}
await browser.close();
