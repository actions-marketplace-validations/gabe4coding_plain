import { counts, type State, type Status } from './model.ts';

/** The element factories `$.ui.resolve(e)` returns; only the four both the terminal and Desktop draw. */
export type Elements = Record<'Box' | 'Text' | 'Button' | 'Input', (props: Record<string, unknown>) => unknown>;
export type Controls = {
  columns: number;
  savePath: string;
  onSavePath: (path: string) => void;
  /** With a path from the field's Enter; without one from the button, which uses the latest typed path. */
  onSave: (path?: string) => unknown;
  onCopy: () => unknown;
};

const ICON: Record<Status, string> = { pass: '✓', fail: '✗', inconclusive: '?', error: '!', skipped: '–' };
const COLOR: Partial<Record<Status, string>> = { pass: 'green', fail: 'red', inconclusive: 'yellow', error: 'red' };

/** `text` cut to `width` characters, with an ellipsis when cut. */
export function fit(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

/** `left`, then spaces, then `right` ending at `width`; `left` is cut first. */
export function spread(left: string, right: string, width: number): string {
  if (!right) return fit(left, width);
  const start = fit(left, Math.max(1, width - right.length - 1));
  return start + ' '.repeat(Math.max(1, width - start.length - right.length)) + right;
}

/** The pane: target and goal, one line per row (detail under a non-pass step), totals, then the controls. */
export function render(state: State, el: Elements, controls: Controls): unknown {
  const { Box, Text, Button, Input } = el;
  const width = Math.max(20, controls.columns);
  const line = (text: string, style: Record<string, unknown> = {}) => Text({ ...style, children: [text] });

  const children: unknown[] = [line(fit(state.target ?? 'No page open yet', width), { bold: true })];
  if (state.goal) children.push(line(fit(`goal: ${state.goal}`, width), { dimColor: true }));
  children.push(line(' '));
  if (state.rows.length === 0) children.push(line('Waiting for the first step…', { dimColor: true }));
  for (const row of state.rows) {
    const icon = row.status ? ICON[row.status] : '·';
    const color = row.status && COLOR[row.status];
    const style = row.dim ? { dimColor: true } : color ? { color } : {};
    children.push(line(spread(`${icon} ${row.label}`, row.tokens ? `${row.tokens} tk` : '', width), style));
    if (row.detail) children.push(line(fit(`  ${row.status}: ${row.detail}`, width), { dimColor: true }));
  }

  const { steps, passed } = counts(state);
  children.push(line(' '));
  children.push(line(fit(`${steps} steps · ${passed} pass · ${state.tokens} Jev tokens`, width), { dimColor: true }));
  children.push(Input({
    key: 'save-path',
    label: 'Spec',
    value: controls.savePath,
    submitLabel: 'save',
    onInput: controls.onSavePath,
    onSubmit: (path: string) => controls.onSave(path),
  }));
  const buttons = [Button({ key: 'save', label: 'Save as spec', onPress: () => controls.onSave() })];
  if (state.lastFailure) buttons.push(Button({ key: 'copy', label: 'Copy last failure', onPress: () => controls.onCopy() }));
  children.push(Box({ flexDirection: 'row', columnGap: 2, children: buttons }));
  return Box({ flexDirection: 'column', children });
}
