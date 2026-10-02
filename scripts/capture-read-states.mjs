#!/usr/bin/env node
// Saves the accessibility snapshot of each page the read benchmark asks about (scripts/read-states/<name>.json),
// so scripts/benchmark-read.mjs runs on fixed pages. Re-run only to refresh them (live sites change).
//   node scripts/capture-read-states.mjs [--only <name>]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { snapshot, installSettleObserver, settle } from '../dist/browser/page.js';

const PAGES = {
  turing: 'https://en.wikipedia.org/wiki/Alan_Turing',
  hn: 'https://news.ycombinator.com/newest',
  ghissues: 'https://github.com/microsoft/playwright/issues',
  ol: 'https://openlibrary.org/search?q=the+left+hand+of+darkness',
  tables: 'https://the-internet.herokuapp.com/tables',
  books: 'https://books.toscrape.com/',
  quotes: 'https://quotes.toscrape.com/',
  ghrepo: 'https://github.com/microsoft/playwright',
};
const { values } = parseArgs({ options: { only: { type: 'string' } } });
const browser = await chromium.launch();
for (const [name, url] of Object.entries(PAGES).filter(([n]) => !values.only || n === values.only)) {
  const page = await browser.newPage();
  await installSettleObserver(page);
  await page.goto(url, { waitUntil: 'load' });
  await settle(page, 500, 5000);
  const snap = await snapshot(page);
  writeFileSync(new URL(`read-states/${name}.json`, import.meta.url), JSON.stringify(snap));
  console.log(name, snap.aria.length, 'chars', snap.aria.split('\n').length, 'lines');
  await page.close();
}
await browser.close();
