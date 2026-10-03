import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { CandidateKindSchema, candidates, elementById } from './candidates.js';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(() => browser.close());
const html = (body: string) => 'data:text/html,' + encodeURIComponent(`<!doctype html><body>${body}</body>`);

test('candidate kinds are the element-acting step kinds plus region', () => {
  assert.deepEqual(CandidateKindSchema.options, ['click', 'hover', 'fill', 'select', 'check', 'upload', 'region']);
});

test('fill finds empty and plaintext-only editable hosts and Playwright can fill them', async () => {
  await page.goto(html(`<div contenteditable aria-label="Body"></div>
    <div contenteditable="plaintext-only" aria-label="Notes"></div>
    <div contenteditable="false" aria-label="Locked"></div>
    <div contenteditable="invalid" aria-label="Invalid"></div>`));
  const found = await candidates(page, 'fill', 254);
  assert.deepEqual(found.map(c => c.desc), ['div aria-label="Body"', 'div aria-label="Notes"']);
  for (const candidate of found) {
    assert.equal(candidate.editable, true);
    await elementById(page, candidate.id).fill('Research');
  }
  assert.equal(await page.locator('[aria-label=Body]').innerText(), 'Research');
  assert.equal(await page.locator('[aria-label=Notes]').innerText(), 'Research');
  assert.equal(await page.locator('[aria-label=Locked]').innerText(), '');
});

test('inert controls do not consume the cap, including shadow descendants; removing inert restores them', async () => {
  await page.goto(html(`<main inert>${'<button>Continue</button>'.repeat(300)}<div id="shadow"></div></main>
    <button onclick="this.textContent='Done'">Continue</button>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Continue</button>'</script>`));
  const found = await candidates(page, 'click', 10);
  assert.deepEqual(found.map(c => c.desc), ['button "Continue"']);
  await elementById(page, found[0].id).click();
  assert.equal(await page.locator('body > button').innerText(), 'Done');
  await page.locator('main').evaluate(el => el.removeAttribute('inert'));
  assert.equal((await candidates(page, 'click', 400)).length, 302);
  await page.locator('body').evaluate(el => el.setAttribute('inert', ''));
  assert.deepEqual(await candidates(page, 'click', 400), []);
});

test('native modal dialogs escape inherited inertness but keep their own explicit inert', async () => {
  await page.goto(html('<main inert><button>Background</button><dialog><button>Continue</button></dialog></main>'));
  await page.locator('dialog').evaluate(el => (el as HTMLDialogElement).showModal());
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Continue"']);
  await page.locator('dialog').evaluate(el => el.setAttribute('inert', ''));
  assert.deepEqual(await candidates(page, 'click', 254), []);
});

test('inert embedding elements suppress candidates in nested and shadow-hosted frames', async () => {
  await page.goto(html(`<div inert><iframe srcdoc="<iframe srcdoc='&lt;button&gt;Nested&lt;/button&gt;'></iframe>"></iframe>
    <div id="shadow"></div></div><button>Continue</button>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<iframe srcdoc="<button>Shadow frame</button>"></iframe>'</script>`));
  assert.ok(page.frames().length >= 4);
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Continue"']);
});

test('disabled fieldsets suppress fields and hidden checkbox labels but preserve the first legend exemption', async () => {
  await page.goto(html(`<fieldset disabled><legend><input aria-label="Legend"></legend>
    <input aria-label="Disabled"><label><input type="checkbox" style="width:0;height:0;padding:0;border:0">Locked</label></fieldset>
    <input aria-label="Enabled">`));
  assert.deepEqual((await candidates(page, 'fill', 254)).map(c => c.desc), ['input aria-label="Legend" context: fieldset text="Locked"', 'input aria-label="Enabled"']);
  assert.deepEqual(await candidates(page, 'check', 254), []);
});
