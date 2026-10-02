import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ariaChanges } from './aria-changes.js';

test('ariaChanges: new lines in order, removed count, title/url only when changed, capped', () => {
  const before = { title: 'A', url: 'u', aria: '- button "Open"\n- listitem: one\n- listitem: one' };
  const after = { title: 'A', url: 'u', aria: '- button "Open"\n- listitem: one\n- dialog "Menu"\n  - link "Settings"' };
  assert.deepEqual(ariaChanges(before, after), { added: ['- dialog "Menu"', '  - link "Settings"'], addedOmitted: 0, removed: 1 });
  const moved = ariaChanges(before, { title: 'B', url: 'v', aria: '- heading "New page"\n- text: long line here' }, 25);
  assert.deepEqual(moved, { title: 'B', url: 'v', added: ['- heading "New page"'], addedOmitted: 1, removed: 3 });
});
