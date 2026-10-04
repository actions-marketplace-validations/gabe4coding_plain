#!/usr/bin/env node
// Refresh the spatial eval evidence from real Chromium and the local e2e page. Build first.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startSite } from '../e2e/site.mjs';
import { candidates } from '../dist/browser/candidates.js';
import { layoutSnapshot, spatialCandidates } from '../dist/browser/layout.js';
import { snapshot } from '../dist/browser/page.js';

const site = await startSite();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${site.url}/spatial`);
  const snap = await snapshot(page);
  const layout = await layoutSnapshot(page);
  const picks = await spatialCandidates(page, await candidates(page, 'click', 254));
  const state = { ...snap, url: 'http://127.0.0.1/spatial', layout };
  writeFileSync(new URL('./claim-states/spatial-order.json', import.meta.url), JSON.stringify(state, null, 2) + '\n');
  writeFileSync(new URL('./pick-states/spatial-order.json', import.meta.url), JSON.stringify({
    url: state.url, title: state.title, kind: 'click', candidates: picks, layout,
  }, null, 2) + '\n');
  await page.goto(`${site.url}/spatial-names`);
  const names = { ...await snapshot(page), url: 'http://127.0.0.1/spatial-names', layout: await layoutSnapshot(page) };
  writeFileSync(new URL('./claim-states/spatial-names.json', import.meta.url), JSON.stringify(names, null, 2) + '\n');
  await page.goto(`${site.url}/spatial-values`);
  await page.locator('input').fill('Current right value');
  await page.locator('textarea').fill('Current left value');
  const values = { ...await snapshot(page), url: 'http://127.0.0.1/spatial-values', layout: await layoutSnapshot(page) };
  writeFileSync(new URL('./claim-states/spatial-values.json', import.meta.url), JSON.stringify(values, null, 2) + '\n');
  await page.goto(`${site.url}/spatial-transparent`);
  const transparent = { ...await snapshot(page), url: 'http://127.0.0.1/spatial-transparent', layout: await layoutSnapshot(page) };
  writeFileSync(new URL('./claim-states/spatial-transparent.json', import.meta.url), JSON.stringify(transparent, null, 2) + '\n');
  await page.goto(`${site.url}/spatial-controls`);
  for (const changed of [false, true]) {
    if (changed) await page.getByRole('combobox', { name: 'Plan', exact: true }).selectOption('annual');
    const controls = { ...await snapshot(page), url: 'http://127.0.0.1/spatial-controls', layout: await layoutSnapshot(page) };
    const name = changed ? 'spatial-controls-selected' : 'spatial-controls';
    writeFileSync(new URL(`./claim-states/${name}.json`, import.meta.url), JSON.stringify(controls, null, 2) + '\n');
  }
  await page.goto(`${site.url}/spatial-iframe`);
  await page.frameLocator('iframe').getByRole('button').count();
  for (const shown of [false, true]) {
    if (shown) await page.getByRole('button', { name: 'Reveal frame' }).click();
    const framed = { ...await snapshot(page), url: 'http://127.0.0.1/spatial-iframe', layout: await layoutSnapshot(page) };
    const name = shown ? 'spatial-iframe-visible' : 'spatial-iframe-hidden';
    writeFileSync(new URL(`./claim-states/${name}.json`, import.meta.url), JSON.stringify(framed, null, 2) + '\n');
  }
  await page.goto(`${site.url}/spatial-reference`);
  for (const moved of [false, true]) {
    if (moved) await page.getByRole('button', { name: 'Move heading' }).click();
    const reference = { url: 'http://127.0.0.1/spatial-reference', title: await page.title(), kind: 'fill',
      candidates: await spatialCandidates(page, await candidates(page, 'fill', 254)), layout: await layoutSnapshot(page) };
    const name = moved ? 'spatial-reference-moved' : 'spatial-reference';
    writeFileSync(new URL(`./pick-states/${name}.json`, import.meta.url), JSON.stringify(reference, null, 2) + '\n');
  }
} finally {
  await browser.close();
  await site.close();
}
