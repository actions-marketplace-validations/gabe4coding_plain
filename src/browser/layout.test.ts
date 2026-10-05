import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { intelligence } from '../core/automation.js';
import { candidates } from './candidates.js';
import { layoutSnapshot, spatialCandidates } from './layout.js';
import { resolveLocators } from './locate.js';
import { askPage, judgeRegion } from './judge-page.js';
import { holdActivity } from './activity.js';
import { installSettleObserver } from './page.js';
import type { StepContext } from './context.js';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await installSettleObserver(page);
});
after(() => browser.close());

const reversed = '<style>.pair { display:flex; flex-direction:row-reverse; width:300px; justify-content:space-between }</style>' +
  '<section id="pair" class="pair"><button onclick="document.querySelector(\'output\').textContent=\'A clicked\'">A</button>' +
  '<button onclick="document.querySelector(\'output\').textContent=\'B clicked\'">B</button></section><output></output>';
const ctx = (): StepContext => ({ page, timeout: 5000, events: [], ms: {}, track: () => {},
  spec: { name: 'spatial', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] } });

test('spatial evidence uses rendered order, supports plain boxes and scopes the region without DOM writes', async () => {
  await page.setContent(reversed + '<div id="outside">Outside text</div><div style="display:contents"><div>Plain box</div></div>' +
    '<button disabled>Disabled</button><div aria-hidden="true"><button>Hidden</button></div>');
  await page.evaluate(() => {
    (window as unknown as { mutations: number }).mutations = 0;
    new MutationObserver((records) => { (window as unknown as { mutations: number }).mutations += records.length; })
      .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const layout = await layoutSnapshot(page);
  assert.match(layout, /Plain box/);
  assert.match(layout, /Disabled/);
  assert.doesNotMatch(layout, /Hidden/);
  const scoped = await layoutSnapshot(page, page.locator('#pair'));
  assert.doesNotMatch(scoped, /Outside text|Plain box|Disabled/);
  const bounds = (name: string) => JSON.parse(scoped.split('\n').find((line) => line.includes(`button "${name}"`))!.split('bounds=')[1]);
  assert.ok(bounds('B').right < bounds('A').left);
  assert.equal(await page.evaluate(() => (window as unknown as { mutations: number }).mutations), 0);
});

test('spatial candidates carry main viewport coordinates across transformed iframes and shadow roots', async () => {
  await page.setContent('<button>Main</button><div id="host"></div>' +
    '<iframe style="margin-left:200px;transform:scale(1.2)" srcdoc="<button>Frame</button>"></iframe>');
  await page.evaluate(() => { document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow</button>'; });
  const observed = await spatialCandidates(page, await candidates(page, 'click', 254));
  assert.equal(observed.length, 3);
  for (const candidate of observed) assert.ok(candidate.bounds!.right > candidate.bounds!.left);
  const frame = observed.find((candidate) => candidate.desc.includes('Frame'))!;
  const expected = await page.frames()[1].locator('button').boundingBox();
  assert.equal(frame.bounds!.left, expected!.x);
  assert.equal(frame.bounds!.right, expected!.x + expected!.width);
  assert.match(await layoutSnapshot(page), /iframe.*button "Frame" bounds=/);
});

test('detached iframe candidates do not abort geometry for an available main-page control', async (t) => {
  for (const duringCapture of [false, true]) {
    await page.setContent('<button>Main action</button><iframe srcdoc="<button>Frame action</button>"></iframe>');
    await page.frames()[1].locator('button').waitFor();
    const scanned = await candidates(page, 'click', 254);
    if (duringCapture) {
      const frame = page.frames()[1];
      const locator = frame.locator.bind(frame);
      t.mock.method(frame, 'locator', (selector: string) => {
        const found = locator(selector);
        const handles = found.elementHandles.bind(found);
        t.mock.method(found, 'elementHandles', async () => {
          await page.locator('iframe').evaluate((el) => el.remove());
          return handles();
        });
        return found;
      });
    } else await page.locator('iframe').evaluate((el) => el.remove());
    const observed = await spatialCandidates(page, scanned);
    assert.equal(observed.length, 1);
    assert.match(observed[0].desc, /Main action/);
    assert.ok(observed[0].bounds);
    t.mock.restoreAll();
  }
});

test('spatial picks include non-candidate references and reference motion invalidates an otherwise identical cache entry', async (t) => {
  await page.setContent('<style>#shipping { top:0px } input, h2 { position:absolute;left:0;margin:0 }</style>' +
    '<section style="position:relative;height:350px"><h2 id="shipping">Shipping</h2>' +
    '<input aria-label="Upper field" style="top:80px"><input aria-label="Lower field" style="top:240px"></section>');
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  intelligence.ask = async () => ({ answers: [{ choice: 'spatial', confidence: 1 }], tokens: 1 });
  intelligence.pick = async (observed, _targets, state) => {
    assert.equal(observed.length, 2);
    const heading = JSON.parse(state.layout!.split('\n').find((line) => line.includes('h2 "Shipping"'))!.split('bounds=')[1]);
    const below = observed.filter((candidate) => candidate.bounds!.top > heading.bottom)
      .sort((a, b) => a.bounds!.top - b.bounds!.top)[0];
    return [{ id: below.id, probability: 1, probabilities: {}, tokens: 1 }];
  };
  const context = ctx();
  const [upper] = await resolveLocators(context, 'fill', ['the field immediately below the Shipping heading']);
  assert.equal(await upper.element!.getAttribute('aria-label'), 'Upper field');
  const cands = await spatialCandidates(page, await candidates(page, 'fill', 254));
  assert.match(await layoutSnapshot(page), /field "Upper field" is below main: heading "Shipping"/);
  await page.evaluate(() => { document.styleSheets[0].insertRule('#shipping { top:160px }', 1); });
  const changed = await spatialCandidates(page, await candidates(page, 'fill', 254));
  assert.deepEqual(changed, cands);
  const movedLayout = await layoutSnapshot(page);
  assert.match(movedLayout, /field "Upper field" is above main: heading "Shipping"/);
  assert.match(movedLayout, /field "Lower field" is below main: heading "Shipping"/);
  const [lower] = await resolveLocators(context, 'fill', ['the field immediately below the Shipping heading']);
  await lower.element!.fill('shipping details');
  assert.equal(await page.getByLabel('Lower field').inputValue(), 'shipping details');
  assert.equal(await page.getByLabel('Upper field').inputValue(), '');
});

test('a spatial target clicks the visually left button', async (t) => {
  await page.setContent(reversed);
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  intelligence.ask = async () => ({ answers: [{ choice: 'spatial', confidence: 1 }], tokens: 2 });
  intelligence.pick = async (observed) => {
    assert.ok(observed.every((candidate) => candidate.bounds));
    const left = observed.reduce((a, b) => a.bounds!.left < b.bounds!.left ? a : b);
    return [{ id: left.id, probability: 1, probabilities: {}, tokens: 1 }];
  };
  const [resolved] = await resolveLocators(ctx(), 'click', ['the button on the left']);
  await resolved.element!.click();
  assert.equal(await page.locator('output').innerText(), 'B clicked');
});

test('a CSS-only order change during settle discards the early spatial pick', async (t) => {
  await page.setContent(reversed);
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  intelligence.ask = async () => ({ answers: [{ choice: 'spatial', confidence: 1 }], tokens: 2 });
  const release = holdActivity(page);
  t.after(release);
  let first = () => {};
  const firstPick = new Promise<void>((resolve) => { first = resolve; });
  let calls = 0;
  intelligence.pick = async (observed) => {
    const left = observed.reduce((a, b) => a.bounds!.left < b.bounds!.left ? a : b);
    if (++calls === 1) first();
    return [{ id: left.id, probability: 1, probabilities: {}, tokens: 1 }];
  };
  const context = ctx();
  const pending = resolveLocators(context, 'click', ['the left button']);
  await firstPick;
  await page.evaluate(() => { document.styleSheets[0].insertRule('.pair { flex-direction:row }', 1); });
  release();
  const [resolved] = await pending;
  assert.equal(await resolved.element!.innerText(), 'A');
  assert.equal(context.ms.reasked, 1);
});

test('scoped spatial assertions receive geometry without outside evidence and reuse their route', async (t) => {
  await page.setContent(reversed + '<button>Outside</button>');
  const { ask, judge } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.judge = judge; });
  let routes = 0;
  intelligence.ask = async () => { routes++; return { answers: [{ choice: 'spatial', confidence: 1 }], tokens: 2 }; };
  intelligence.judge = async (state) => {
    const observed = state as { layout: string; aria: string; url?: string };
    assert.match(observed.layout, /button "B" bounds=/);
    assert.doesNotMatch(observed.layout, /Outside/);
    assert.equal(observed.url, undefined);
    return { probabilities: [1], tokens: 1 };
  };
  const context = ctx();
  await askPage(context, ['B is left of A'], 'css=#pair');
  await askPage(context, ['B is left of A'], 'css=#pair');
  assert.equal(routes, 1);
});

test('a spatial capture explicitly reports truncation', async () => {
  await page.setContent(Array.from({ length: 270 }, (_, i) => `<button>Item ${i}</button>`).join(''));
  const layout = await layoutSnapshot(page);
  assert.match(layout, /Layout truncated/);
  assert.equal(layout.split('\n').filter((line) => line.includes('bounds=')).length, 254);
});

test('spatial claims retain slotted button labels and exclude an aria-hidden region', async () => {
  await page.setContent('<x-button>Slotted action</x-button><div aria-hidden="true"><section id="hidden">Hidden text</section></div>');
  await page.evaluate(() => {
    document.querySelector('x-button')!.attachShadow({ mode: 'open' }).innerHTML = '<button><slot></slot></button>';
  });
  assert.match(await layoutSnapshot(page), /button "Slotted action" bounds=/);
  assert.doesNotMatch(await layoutSnapshot(page, page.locator('#hidden')), /Hidden text/);
});

test('a semantic shadow-root judgment discards the early passing state after an action hold', async (t) => {
  await page.goto('data:text/html,<div id="host"></div>');
  await page.evaluate(() => {
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<section id="status">Ready</section>';
  });
  const { ask, judge } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.judge = judge; });
  intelligence.ask = async () => ({ answers: [{ choice: 'semantic', confidence: 1 }], tokens: 1 });
  let first = () => {};
  const firstAnswer = new Promise<void>((resolve) => { first = resolve; });
  let calls = 0;
  intelligence.judge = async (state) => {
    if (++calls === 1) first();
    return { probabilities: [(state as { aria: string }).aria.includes('Ready') ? 1 : 0], tokens: 1 };
  };
  const release = holdActivity(page);
  t.after(release);
  const context = ctx();
  const pending = judgeRegion(context, page.locator('#status'), 'Ready is shown', () => false);
  await firstAnswer;
  await page.locator('#status').evaluate((el) => { el.textContent = 'Pending'; });
  release();
  const result = await pending;
  assert.deepEqual(result.probabilities, [0]);
  assert.equal(context.ms.reasked, 1);
});

test('an uncertain evidence route preserves a hidden file input and performs the upload', async (t) => {
  await page.setContent('<label for="upload">Document</label><input id="upload" type="file" hidden>');
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  intelligence.ask = async () => ({ answers: [{ choice: 'semantic', confidence: 0.5 }], tokens: 1 });
  intelligence.pick = async (observed) => {
    assert.equal(observed.length, 1);
    assert.equal(observed[0].bounds, undefined);
    return [{ id: observed[0].id, probability: 1, probabilities: {}, tokens: 1 }];
  };
  const [resolved] = await resolveLocators(ctx(), 'upload', ['the Document upload']);
  await resolved.element!.setInputFiles({ name: 'document.txt', mimeType: 'text/plain', buffer: Buffer.from('test document') });
  assert.equal(await page.locator('#upload').evaluate((el) => (el as HTMLInputElement).files?.[0].name), 'document.txt');
});

test('candidate capture refreshes after routing and does not auto-wait for an unrelated removed candidate', async (t) => {
  await page.setContent('<button id="gone">Removed</button><button id="stable">Stable</button>');
  const scanned = await candidates(page, 'click', 254);
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  intelligence.ask = async () => {
    await page.locator('#gone').evaluate((el) => el.remove());
    return { answers: [{ choice: 'spatial', confidence: 1 }], tokens: 1 };
  };
  intelligence.pick = async (observed) => {
    assert.equal(observed.length, 1);
    assert.match(observed[0].desc, /Stable/);
    assert.ok(observed[0].bounds);
    return [{ id: observed[0].id, probability: 1, probabilities: {}, tokens: 1 }];
  };
  const [resolved] = await resolveLocators(ctx(), 'click', ['the left button']);
  await resolved.element!.click();
  assert.equal(await resolved.element!.innerText(), 'Stable');
  // The obsolete scan cannot wait for its old ids to reappear.
  const observed = await spatialCandidates(page, scanned);
  assert.equal(observed.length, 1);
});

test('layout descriptions associate native button values and referenced accessible names with bounds', async () => {
  await page.setContent('<input type="button" value="A"><input type="submit" value="B">' +
    '<span hidden id="name">Referenced action</span><button aria-labelledby="name"></button>' +
    '<button title="Title action"></button><button title="Tooltip description">Save</button>' +
    '<input placeholder="Placeholder field"><x-action></x-action>');
  await page.evaluate(() => {
    document.querySelector('x-action')!.attachShadow({ mode: 'open' }).innerHTML =
      '<span hidden id="name">Shadow action</span><button aria-labelledby="name"></button>';
  });
  const layout = await layoutSnapshot(page);
  assert.match(layout, /input\[type=button\] "A" bounds=/);
  assert.match(layout, /input\[type=submit\] "B" bounds=/);
  assert.match(layout, /button "" label="Referenced action" bounds=/);
  assert.match(layout, /button "" label="Shadow action" bounds=/);
  assert.match(layout, /button "" label="Title action" bounds=/);
  assert.match(layout, /button "Save" bounds=/);
  assert.doesNotMatch(layout, /Tooltip description/);
  assert.match(layout, /input\[type=text\] "" label="Placeholder field" value="" bounds=/);
});

test('a scoped shadow region captures visible text-only slot boxes without duplicating their geometry', async () => {
  await page.setContent('<x-boxes>A</x-boxes>');
  await page.evaluate(() => {
    document.querySelector('x-boxes')!.attachShadow({ mode: 'open' }).innerHTML =
      '<style>#pair { display:flex; gap:40px } .box { border:1px solid; padding:20px }</style>' +
      '<section id="pair"><div class="box"><slot></slot></div><div class="box">B</div></section>';
  });
  const layout = await layoutSnapshot(page, page.locator('#pair'));
  const boxes = layout.split('\n').filter((line) => /div "[AB]" bounds=/.test(line));
  assert.equal(boxes.length, 2);
  const bounds = (name: string) => JSON.parse(boxes.find((line) => line.includes(`div "${name}"`))!.split('bounds=')[1]);
  assert.ok(bounds('A').right < bounds('B').left);
  assert.match(layout, /div "A" is left of region: div "B"/);
});

test('a scoped shadow region includes assigned controls once and excludes other slots and unslotted content', async () => {
  await page.setContent('<x-panel><button>A</button><button>B</button><button slot="outside">Outside</button>' +
    '<button slot="missing">Unslotted</button></x-panel>');
  await page.evaluate(() => {
    document.querySelector('x-panel')!.attachShadow({ mode: 'open' }).innerHTML =
      '<style>#pair { display:flex; flex-direction:row-reverse; width:300px; justify-content:space-between }</style>' +
      '<section id="pair"><slot></slot></section><slot name="outside"></slot>';
  });
  const scoped = await layoutSnapshot(page, page.locator('#pair'));
  assert.doesNotMatch(scoped, /Outside|Unslotted/);
  const bounds = (name: string) => JSON.parse(scoped.split('\n').find((line) => line.includes(`button "${name}"`))!.split('bounds=')[1]);
  assert.ok(bounds('B').right < bounds('A').left);
  const whole = await layoutSnapshot(page);
  assert.equal(whole.split('\n').filter((line) => line.includes('button "A" bounds=')).length, 1);
  assert.equal(whole.split('\n').filter((line) => line.includes('button "B" bounds=')).length, 1);
  assert.match(whole, /button "Outside" bounds=/);
  assert.doesNotMatch(whole, /Unslotted/);
});

test('layout text excludes hidden children and unused slot fallback, and form values reflect the current controls', async () => {
  await page.setContent('<button><span hidden>Hidden action</span></button>' +
    '<x-action><span>Assigned action</span></x-action>' +
    '<div style="display:flex;flex-direction:row-reverse;justify-content:space-between;width:500px"><input value="Old input">' +
    '<textarea>Old textarea</textarea></div>');
  await page.evaluate(() => {
    document.querySelector('x-action')!.attachShadow({ mode: 'open' }).innerHTML =
      '<button><slot><span>Fallback action</span></slot></button>';
  });
  await page.locator('input').fill('Current right value');
  await page.locator('textarea').fill('Current left value');
  const layout = await layoutSnapshot(page);
  assert.doesNotMatch(layout, /Hidden action|Fallback action|Old input|Old textarea/);
  assert.match(layout, /button "Assigned action" bounds=/);
  assert.match(layout, /input\[type=text\] "Current right value" value="Current right value" bounds=/);
  assert.match(layout, /textarea "Current left value" value="Current left value" bounds=/);
  const bounds = (value: string) => JSON.parse(layout.split('\n').find((line) => line.includes(`value="${value}"`))!.split('bounds=')[1]);
  assert.ok(bounds('Current left value').right < bounds('Current right value').left);
});

test('a candidate removed during geometry capture cannot leave a stale locator after settled ids change', async (t) => {
  await page.setContent('<button id="gone">Removed</button><button id="stable">Stable</button>');
  const { ask, pick } = intelligence;
  t.after(() => { intelligence.ask = ask; intelligence.pick = pick; });
  intelligence.ask = async () => ({ answers: [{ choice: 'spatial', confidence: 1 }], tokens: 1 });
  const frame = page.mainFrame();
  const locator = frame.locator.bind(frame);
  let removed = false;
  t.mock.method(frame, 'locator', (selector: string) => {
    const found = locator(selector);
    if (selector === '[data-jev-id="0"]' && !removed) {
      t.mock.method(found, 'elementHandles', async () => {
        await locator('#gone').evaluate((el) => el.remove());
        removed = true;
        return [];
      });
    }
    return found;
  });
  const ids: number[] = [];
  intelligence.pick = async (observed) => {
    assert.equal(observed.length, 1);
    assert.match(observed[0].desc, /Stable/);
    ids.push(observed[0].id);
    return [{ id: observed[0].id, probability: 1, probabilities: {}, tokens: 1 }];
  };
  const context = ctx();
  const [resolved] = await resolveLocators(context, 'click', ['the left button']);
  assert.deepEqual(ids, [1, 0]);
  assert.equal(context.ms.reasked, 1);
  await resolved.element!.click();
  assert.equal(await resolved.element!.getAttribute('id'), 'stable');
});

test('a transient iframe does not abort a main-page layout capture and a vanished body has a bounded wait', async (t) => {
  for (const detached of [true, false]) {
    await page.setContent('<button>Main action</button><iframe srcdoc="<button>Frame action</button>"></iframe>');
    const frame = page.frames()[1];
    const root = frame.locator('body');
    await root.waitFor();
    t.mock.method(frame, 'locator', () => root);
    t.mock.method(root, 'count', async () => {
      if (detached) await page.locator('iframe').evaluate((el) => el.remove());
      else await frame.evaluate(() => document.body.remove());
      return 1;
    });
    const start = Date.now();
    const layout = await layoutSnapshot(page);
    assert.match(layout, /button "Main action" bounds=/);
    assert.match(layout, /Layout unavailable for iframe/);
    assert.ok(Date.now() - start < 4000, 'a transient iframe must not wait the page action timeout');
    t.mock.restoreAll();
  }
});

test('transparent child and slotted text are absent from visible text while explicit accessible names remain', async () => {
  await page.setContent('<button aria-label="Accessible name"><span style="opacity:0">Transparent child</span>Shown</button>' +
    '<div id="host"><span style="opacity:0">Transparent slotted child</span><span>Slotted shown</span></div>');
  await page.locator('#host').evaluate((el) => {
    el.attachShadow({ mode: 'open' }).innerHTML = '<button><slot></slot></button>';
  });
  const layout = await layoutSnapshot(page);
  assert.doesNotMatch(layout, /button "[^"]*Transparent child|button "[^"]*Transparent slotted child/);
  assert.match(layout, /button "Shown" label="Accessible name" visible_text="Shown" bounds=/);
  assert.match(layout, /button "Slotted shown" label="Transparent slotted child Slotted shown" visible_text="Slotted shown" bounds=/);
});

test('collapsed selects capture the displayed option and value, with the wrapping label separate', async () => {
  await page.setContent('<label>Plan <select><option value="monthly">Monthly</option><option value="yearly" label="Annual">Yearly</option></select></label>' +
    '<label>Note <textarea>Initial note</textarea></label><button>Continue</button>');
  const select = page.getByRole('combobox', { name: 'Plan', exact: true });
  assert.equal(await select.count(), 1);
  const before = await layoutSnapshot(page);
  assert.match(before, /select "Monthly" label="Plan" value="monthly" collapsed=true displayed_selection="Monthly" options_not_displayed="Annual" bounds=/);
  assert.doesNotMatch(before, /select "[^"]*Annual|label="Plan Monthly|label="Note Initial/);
  await select.selectOption('yearly');
  const after = await layoutSnapshot(page);
  assert.match(after, /select "Annual" label="Plan" value="yearly" collapsed=true displayed_selection="Annual" options_not_displayed="Monthly" bounds=/);
  assert.doesNotMatch(after, /select "[^"]*Monthly/);
  await page.locator('textarea').fill('Current note');
  assert.doesNotMatch(await layoutSnapshot(page), /Initial note/);
  assert.notEqual(before, after);
});

test('expanded native list boxes retain their displayed unselected options', async () => {
  await page.setContent('<label>Plan <select size="3"><option value="monthly" selected>Monthly</option><option value="annual" label="Annual">Yearly</option></select></label>');
  const layout = await layoutSnapshot(page);
  assert.match(layout, /select "Monthly Annual" label="Plan" value="monthly" collapsed=false/);
  assert.match(layout, /option "Annual" bounds=/);
  assert.doesNotMatch(layout, /Yearly/);
});

test('transparent embedding elements hide nested-frame geometry, including scoped captures', async () => {
  await page.setContent('<button>Visible anchor</button><div id="host"><iframe id="outer"></iframe></div>');
  const outer = page.frames()[1];
  await outer.setContent('<button>Outer action</button><iframe srcdoc="<button>Inner action</button>"></iframe>');
  await page.frameLocator('#outer').frameLocator('iframe').getByRole('button').waitFor();
  const inner = outer.childFrames()[0];
  assert.match(await layoutSnapshot(page), /Outer action/);
  assert.match(await layoutSnapshot(page), /Inner action/);
  for (const selector of ['#outer', '#host']) {
    await page.locator(selector).evaluate((el) => { (el as HTMLElement).style.opacity = '0'; });
    assert.doesNotMatch(await layoutSnapshot(page), /Outer action|Inner action/);
    assert.doesNotMatch(await layoutSnapshot(page, inner.locator('button')), /Inner action/);
    const observed = await spatialCandidates(page, await candidates(page, 'click', 254));
    assert.equal(observed.length, 1);
    assert.match(observed[0].desc, /Visible anchor/);
    await page.locator(selector).evaluate((el) => { (el as HTMLElement).style.opacity = '1'; });
  }
  assert.match(await layoutSnapshot(page), /Inner action/);
});

test('layout text shows a filled password field with a mask, never its value', async () => {
  await page.setContent('<label>Password <input type="password"></label><label>Unused <input type="password"></label>');
  await page.locator('input').first().fill('hunter2');
  const layout = await layoutSnapshot(page);
  assert.doesNotMatch(layout, /hunter2/);
  assert.match(layout, /main: input\[type=password\] "" label="Password" value="\[filled\]" bounds=/);
  assert.match(layout, /main: input\[type=password\] "" label="Unused" value="" bounds=/);
});
