import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutRelations, nativeLayout } from './layout.js';

const item = (name: string, top: number) => ({ description: `button "${name}"`, name: `button "${name}"`, bounds: { left: 0, top, right: 100, bottom: top + 40 } });

test('layoutRelations keeps the relations: a scroll changes no relation, a moved element does', () => {
  const at = (offset: number, order: string[]) => nativeLayout(order.map((name, i) => item(name, offset + i * 50)), 'points', false);
  const recorded = layoutRelations(at(0, ['Starts', 'Ends']));
  assert.match(recorded, /button "Starts" is above button "Ends"\./);
  assert.doesNotMatch(recorded, /bounds=/);
  assert.equal(layoutRelations(at(120, ['Starts', 'Ends'])), recorded, 'scrolled by 120 points');
  assert.notEqual(layoutRelations(at(0, ['Ends', 'Starts'])), recorded, 'the two swapped places');
});

test('layoutRelations with a subject keeps only the lines about that element: a clock elsewhere changes nothing', () => {
  const screen = (clock: string) => nativeLayout([item('Today', 0), item('Add', 50), item(clock, 200), item('Next', 250)], 'points', false);
  const subject = 'button "Today"';
  assert.match(layoutRelations(screen('08:36'), subject), /button "Today" is above button "Add"\./);
  assert.equal(layoutRelations(screen('08:37'), subject), layoutRelations(screen('08:36'), subject));
  assert.notEqual(layoutRelations(screen('08:37')), layoutRelations(screen('08:36')), 'the whole layout does change');
});

test('layoutRelations ignores a one-point jitter that flips a strict overlap', () => {
  const screen = (left: number) => nativeLayout([
    { description: 'button "Add"', name: 'button "Add"', bounds: { left: 300, top: 60, right: 340, bottom: 100 } },
    { description: 'button "Sat 10"', name: 'button "Sat 10"', bounds: { left, top: 130, right: left + 40, bottom: 170 } },
  ], 'points', false);
  assert.equal(layoutRelations(screen(340)), layoutRelations(screen(339)), 'edges 0 or 1 point apart');
  assert.notEqual(layoutRelations(screen(300)), layoutRelations(screen(339)), 'a real move');
});
