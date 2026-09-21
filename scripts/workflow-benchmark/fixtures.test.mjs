import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture, taskNames, validate, startFixtures } from './fixtures.mjs';

test('oracle rejects missing saves, wrong fields, extra state and wrong-row changes', () => {
  const contact = fixture('contact', 0);
  assert.equal(validate(contact, [], 'Saved successfully'), false);
  assert.equal(validate(contact, [{ kind: 'saved', value: { ...contact.expected, extra: 'bad' } }], ''), false);
  assert.equal(validate(contact, [{ kind: 'saved', value: contact.expected }], ''), true);
  const record = fixture('record', 0);
  assert.equal(validate(record, [{ kind: 'saved', value: { ...record.expected, row: '1' } }], ''), false);
  assert.equal(validate(record, [{ kind: 'saved', value: record.expected }, { kind: 'saved', value: record.expected }], ''), false);
  assert.equal(validate(fixture('catalog', 0), [], 'OTHER-52'), false);
});

test('every fixture is solvable through visible controls and independently validated', async () => {
  const fixtures = await startFixtures();
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    for (const name of taskNames) {
      const spec = fixtures.add(name, name, 0);
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(spec.url);
      if (name === 'catalog') {
        await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Field notebook 31', exact: true }) }).getByRole('button').click();
        assert.equal(fixtures.result(name, await page.locator('main').innerText()).success, true);
      } else {
        if (name === 'record') await page.getByRole('row').filter({ hasText: 'Account 31' }).getByRole('button').click();
        if (name === 'wizard') { await page.getByRole('textbox', { name: 'Project name' }).fill('Research 31'); await page.getByRole('button', { name: 'Next' }).click(); }
        if (name === 'validation') {
          await page.getByRole('textbox', { name: 'Alias', exact: true }).fill('studio');
          await page.getByRole('button', { name: 'Reserve alias' }).click();
          await page.getByRole('alert').waitFor();
          assert.equal(fixtures.result(name, '').success, false);
        }
        for (const [key, value] of Object.entries(spec.expected)) {
          if (key === 'row' || key === 'Project name') continue;
          const input = page.getByLabel(key, { exact: true });
          const tag = await input.evaluate(e => e.tagName);
          if (tag === 'SELECT') await input.selectOption({ label: value });
          else if (await input.getAttribute('type') === 'checkbox') await input.check();
          else await input.fill(value);
        }
        if (name === 'preferences') await page.getByLabel('Promotional email').uncheck();
        await page.locator('form button').click();
        await page.getByRole('heading', { name: 'Saved successfully' }).waitFor();
        assert.equal(fixtures.result(name, '').success, true, name);
      }
      assert.deepEqual(errors, [], name);
      await page.close();
    }
  } finally { await browser.close(); await fixtures.close(); }
});
