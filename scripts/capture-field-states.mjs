#!/usr/bin/env node
// Refresh the field-state eval page (empty fields, editor text, enabled and disabled fields) from real Chromium and
// the local e2e page. Build first. The claim benchmark judges the saved tree: scripts/claim-states/field-state.json.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startSite } from '../e2e/site.mjs';
import { snapshot } from '../dist/browser/page.js';

const site = await startSite();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${site.url}/field-state`);
  await page.getByLabel('City').fill('Paris');
  await page.getByRole('textbox', { name: 'Article body' }).fill('Draft about lighthouses');
  const state = { ...await snapshot(page), url: 'http://127.0.0.1/field-state' };
  writeFileSync(new URL('./claim-states/field-state.json', import.meta.url), JSON.stringify(state, null, 2) + '\n');
} finally {
  await browser.close();
  await site.close();
}
