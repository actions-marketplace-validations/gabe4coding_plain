import { expect, test } from 'claude-code/testing';
import { apply, emptyState } from './model.ts';
import { fit, render, spread, type Elements } from './view.ts';

type Node = { type: string; props: Record<string, any> };
const el = Object.fromEntries(['Box', 'Text', 'Button', 'Input'].map((type) => [type, (props: Record<string, unknown>) => ({ type, props })])) as Elements;

/** Every node of the tree, depth first. */
function nodes(node: Node): Node[] {
  const kids = (node.props.children ?? []).filter((kid: unknown) => typeof kid === 'object');
  return [node, ...kids.flatMap(nodes)];
}
const lines = (tree: unknown) => nodes(tree as Node).filter((node) => node.type === 'Text').map((node) => node.props.children.join(''));
const keyed = (tree: unknown, key: string) => nodes(tree as Node).find((node) => node.props.key === key);

const controls = (over = {}) => ({ columns: 40, savePath: 'flow.yaml', onSavePath: () => {}, onSave: () => {}, onCopy: () => {}, ...over });

test('fit cuts with an ellipsis; spread right-aligns the second part', async () => {
  expect(fit('abcdef', 4)).toBe('abc…');
  expect(fit('abc', 4)).toBe('abc');
  expect(spread('left', '9 tk', 12)).toBe('left    9 tk');
  expect(spread('a very long label', '9 tk', 12)).toBe('a very… 9 tk');
});

test('an empty session says it is waiting, and offers no copy button', async () => {
  const tree = render(emptyState(), el, controls());
  expect(lines(tree)).toContain('No page open yet');
  expect(lines(tree)).toContain('Waiting for the first step…');
  expect(keyed(tree, 'save')).toBeDefined();
  expect(keyed(tree, 'copy')).toBeUndefined();
});

test('steps show icon, label and tokens; a failure shows its detail and the copy button', async () => {
  let state = apply(emptyState(), 'browser', 'open', { url: 'https://example.test', goal: 'Read it' }, { url: 'https://example.test/' });
  state = apply(state, 'browser', 'step', { step: { expect: 'comments show' } }, { status: 'inconclusive', detail: 'p=0.62', jevTokens: 340 });
  const tree = render(state, el, controls());
  const text = lines(tree);
  expect(text).toContain('https://example.test/');
  expect(text).toContain('goal: Read it');
  expect(text).toContain('✓ goto "https://example.test"');
  expect(text).toContain(spread('? expect "comments show"', '340 tk', 40));
  expect(text).toContain('  inconclusive: p=0.62');
  expect(text).toContain('2 steps · 1 pass · 340 Jev tokens');
  expect(keyed(tree, 'copy')).toBeDefined();
});

test('the save controls pass the path on', async () => {
  const saved: (string | undefined)[] = [];
  const typed: string[] = [];
  const tree = render(emptyState(), el, controls({ onSave: (path?: string) => saved.push(path), onSavePath: (path: string) => typed.push(path) }));
  const input = keyed(tree, 'save-path')!;
  expect(input.props.value).toBe('flow.yaml');
  input.props.onInput('specs/a.yaml');
  input.props.onSubmit('specs/a.yaml');
  keyed(tree, 'save')!.props.onPress();
  expect(typed).toEqual(['specs/a.yaml']);
  expect(saved).toEqual(['specs/a.yaml', undefined]);
});
