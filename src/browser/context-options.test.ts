import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devices } from 'playwright';
import { browserContextOptions } from './context-options.js';
import { openSession, closeSharedBrowser } from './session.js';
import { runSpec } from './runner.js';
import type { Spec } from '../core/spec.js';

const opts = { headed: false, timeout: 5000 };
const blank = { name: 'context', dir: '.', url: 'about:blank', dialogs: 'accept', steps: [{ kind: 'goto', url: 'about:blank' }] } satisfies Spec;
after(closeSharedBrowser);
function fixture(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...blank, dir };
}

test('device settings apply first, explicit options override, and auth/geolocation remain supported', () => {
  const browser = { device: 'iPhone 15', viewport: { width: 1280, height: 800 }, locale: 'it-IT', timezone: 'Europe/Rome', colorScheme: 'dark' } as const;
  const result = browserContextOptions({ ...blank, browser, auth: { user: 'u', pass: 'p' }, geolocation: { lat: 41, lon: 12 } }, opts);
  assert.deepEqual(result.viewport, browser.viewport);
  assert.equal(result.userAgent, devices['iPhone 15'].userAgent);
  assert.equal(result.isMobile, true);
  assert.equal(result.hasTouch, true);
  assert.equal(result.deviceScaleFactor, devices['iPhone 15'].deviceScaleFactor);
  assert.equal(result.locale, 'it-IT');
  assert.equal(result.timezoneId, 'Europe/Rome');
  assert.equal(result.colorScheme, 'dark');
  assert.equal('defaultBrowserType' in result, false);
  assert.deepEqual(result.httpCredentials, { username: 'u', password: 'p' });
  assert.deepEqual(result.geolocation, { latitude: 41, longitude: 12 });
  assert.deepEqual(result.permissions, ['geolocation']);
});

test('unknown devices list three real close names, including a matching nearby device', () => {
  for (const device of ['iPhon 15', 'toString']) {
    assert.throws(() => browserContextOptions({ ...blank, browser: { device } }, opts), (error: Error) => {
      assert.match(error.message, /unknown browser device/);
      const names = error.message.split('close names: ')[1].split(', ');
      assert.equal(names.length, 3);
      assert.ok(names.every(name => Object.hasOwn(devices, name)));
      if (device === 'iPhon 15') assert.ok(names.includes('iPhone 15'));
      return true;
    });
  }
});

test('CDP rejects every browser key before attachment; an empty browser block is allowed', () => {
  const browser: NonNullable<Spec['browser']> = { device: 'iPhone 15', viewport: { width: 500, height: 500 }, locale: 'it-IT', timezone: 'Europe/Rome', colorScheme: 'dark', storageState: 'state.json', saveState: 'state.json' };
  for (const [key, value] of Object.entries(browser))
    assert.throws(() => browserContextOptions({ ...blank, browser: { [key]: value } }, { ...opts, cdp: 'http://127.0.0.1:1' }), /--cdp attaches.*`browser`.*not supported/);
  assert.deepEqual(browserContextOptions({ ...blank, browser: {} }, { ...opts, cdp: 'http://127.0.0.1:1' }), {});
  assert.throws(() => browserContextOptions({ ...blank, browser: { storageState: 'missing.json' } }, { ...opts, profile: 'profile' }), /--profile.*storageState/);
});

test('missing storageState reports the resolved path and prerequisite at session open', async (t) => {
  const spec = fixture(t);
  const file = path.join(spec.dir, '.auth', 'user.json');
  await assert.rejects(openSession({ ...spec, browser: { storageState: '.auth/user.json' } }, opts, () => {}),
    { message: `storageState file not found: ${file} (run the spec that saves it first)` });
});

test('Chromium applies viewport, locale, timezone and color scheme, also with a persistent profile', async (t) => {
  const spec = fixture(t);
  const url = 'data:text/html,' + encodeURIComponent(`<script>document.title = [innerWidth, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, matchMedia('(prefers-color-scheme: dark)').matches].join('|')</script>`);
  for (const profile of [undefined, path.join(spec.dir, 'profile')]) {
    const titles: string[] = [];
    const result = await runSpec({ ...spec, browser: { viewport: { width: 777, height: 600 }, locale: 'it-IT', timezone: 'Europe/Rome', colorScheme: 'dark' }, steps: [{ kind: 'goto', url }] }, { ...opts, profile }, {
      stepEnd: async ({ target }) => { titles.push(await target.page!().title()); },
    });
    assert.equal(result.status, 'pass');
    assert.deepEqual(titles, ['777|it-IT|Europe/Rome|true']);
  }
});

test('saveState creates directories after pass and storageState round trips cookies and localStorage', async (t) => {
  const spec = fixture(t);
  const seed = { cookies: [{ name: 'session', value: 'fixture', domain: 'fixture.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://fixture.test', localStorage: [{ name: 'user', value: 'Ada' }] }] };
  fs.writeFileSync(path.join(spec.dir, 'seed.json'), JSON.stringify(seed));
  const file = path.join(spec.dir, '.auth', 'user.json');
  const result = await runSpec({ ...spec, browser: { storageState: 'seed.json', saveState: '.auth/user.json' } }, opts);
  assert.equal(result.status, 'pass');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.cookies[0].value, 'fixture');
  assert.deepEqual(saved.origins, seed.origins);
  const session = await openSession({ ...spec, browser: { storageState: '.auth/user.json' } }, opts, () => {});
  try { assert.deepEqual(await session.ctx.page.context().storageState(), saved); }
  finally { await session.close(); }
});

test('saveState never creates or overwrites state after step, interpolation, setup or teardown errors', async (t) => {
  const spec = fixture(t);
  const file = path.join(spec.dir, 'state.json');
  const hooks = path.join(spec.dir, 'hooks.mjs');
  const cases: Spec[] = [
    { ...spec, steps: [{ kind: 'goto', url: 'http://127.0.0.1:9' }] },
    { ...spec, steps: [{ kind: 'goto', url: '${hooks.missing}' }] },
  ];
  for (const phase of ['setup', 'teardown']) {
    fs.writeFileSync(hooks, `export function ${phase}() { throw new Error('${phase} failure'); }`);
    const result = await runSpec({ ...spec, hooks, browser: { saveState: 'state.json' } }, opts);
    assert.equal(result.status, 'error');
    assert.equal(fs.existsSync(file), false);
  }
  for (const failed of cases) {
    for (const existing of [false, true]) {
      fs.rmSync(file, { force: true });
      if (existing) fs.writeFileSync(file, 'keep existing state');
      const result = await runSpec({ ...failed, browser: { saveState: 'state.json' } }, opts);
      assert.equal(result.status, 'error');
      if (existing) assert.equal(fs.readFileSync(file, 'utf8'), 'keep existing state');
      else assert.equal(fs.existsSync(file), false);
    }
  }
});

test('saveState write failures become an error and still close the session', async (t) => {
  const spec = fixture(t);
  let page: import('playwright').Page | undefined;
  const result = await runSpec({ ...spec, browser: { saveState: '.' } }, opts, { sessionOpen: async ({ target }) => { page = target.page!(); } });
  assert.equal(result.status, 'error');
  assert.equal(result.steps.at(-1)?.step, 'saveState');
  assert.equal(page?.isClosed(), true);
});
