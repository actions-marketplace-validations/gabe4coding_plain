import { expect, test } from 'claude-code/testing';

const TOOL = 'mcp__plugin_plainwright_plainwright__';
const PANE = {
  plugin: 'plainwright-session-pane',
  component: 'Pane',
  requestId: 'plainwright',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'plainwright', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

/** A plainwright result as its MCP server sends it: one JSON text block, and the same object as structured content. */
const mcp = (data: object) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });

const ANSWERS: Record<string, object> = {
  open: { url: 'https://example.test/', title: 'Example', notes: [] },
  step: { status: 'inconclusive', detail: 'p=0.62', notes: [], url: 'https://example.test/item', jevTokens: 340 },
};

/** Answers tool calls in Claude Code's place: plainwright tools from ANSWERS, any other tool with 'ok'. */
function stubTools(on: any, seen: unknown[] = []): void {
  on('tool.call', ($: any, e: any) => {
    const name = String(e.tool).startsWith(TOOL) ? String(e.tool).slice(TOOL.length) : '';
    const reply = ANSWERS[name] ? { ref: 1, result: mcp(ANSWERS[name]), text: JSON.stringify(ANSWERS[name]) } : { ref: 1, result: 'ok', text: 'ok' };
    seen.push(reply);
    return reply;
  });
}
const placed = () => ({ value: { isPlaced: true } });
const done = () => ({ value: undefined });

test('records each step and returns the tool result unchanged', async ($, on) => {
  const seen: unknown[] = [];
  stubTools(on, seen);
  on('ui.open', placed);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/', goal: 'Read the discussion' });
  const out = await $.tool.call({ tool: TOOL + 'step', step: { expect: 'comments are shown' } });
  expect(out).toEqual(seen[1]);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'goal: Read the discussion' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^\? expect "comments are shown" +340 tk$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '  inconclusive: p=0.62' })).toBeDefined();
  await ui.unmount();
});

test('draws the same pane on Desktop', async ($, on) => {
  stubTools(on);
  on('ui.open', placed);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect(await ui.find({ type: 'Text', text: '✓ goto "https://example.test/"' })).toBeDefined();
  await ui.unmount();
});

test('opens the pane on the first open only', async ($, on) => {
  let opens = 0;
  stubTools(on);
  on('ui.open', () => {
    opens += 1;
    return placed();
  });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/b' });
  expect(opens).toBe(1);
});

test('other tools leave the pane empty', async ($, on) => {
  const seen: unknown[] = [];
  stubTools(on, seen);
  const out = await $.tool.call({ tool: 'Bash', command: 'ls' });
  expect(out).toEqual(seen[0]);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'Waiting for the first step…' })).toBeDefined();
  await ui.unmount();
});

test('Save as spec calls the server save tool with the goal file name', async ($, on) => {
  const calls: any[] = [];
  const toasts: string[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('mcp.call', ($: any, e: any) => {
    calls.push(e);
    return { value: mcp({ path: '/work/read-the-discussion.yaml', steps: 2 }) };
  });
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text);
    return done();
  });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/', goal: 'Read the discussion' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'save' });
  expect(calls[0]).toMatchObject({ server: 'plugin_plainwright_plainwright', tool: 'save', args: { path: 'read-the-discussion.yaml' } });
  expect(toasts).toContain('Saved 2 steps to /work/read-the-discussion.yaml');
  await ui.unmount();
});

test('a typed spec path is the one saved', async ($, on) => {
  const calls: any[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('mcp.call', ($: any, e: any) => {
    calls.push(e);
    return { value: mcp({ path: '/work/specs/flow.yaml', steps: 1 }) };
  });
  on('ui.toast', done);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.input({ key: 'save-path', text: 'specs/flow.yaml' });
  expect(calls[0]).toMatchObject({ args: { path: 'specs/flow.yaml' } });
  await ui.unmount();
});

test('Copy last failure copies the failing step as JSON', async ($, on) => {
  const copied: string[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('ui.copy', ($: any, e: any) => {
    copied.push(JSON.stringify(e));
    return { value: { isCopied: true } };
  });
  on('ui.toast', done);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  await $.tool.call({ tool: TOOL + 'step', step: { expect: 'comments are shown' } });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'copy' });
  expect(copied[0]).toContain('inconclusive');
  expect(copied[0]).toContain('comments are shown');
  await ui.unmount();
});

test('the pane command shows the pane', async ($, on) => {
  let opens = 0;
  on('session.start', () => ({ cwd: '/work' }));
  on('command.register', done);
  on('ui.open', () => {
    opens += 1;
    return placed();
  });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  await $.command.run({ command: 'plainwright-pane', args: '' });
  expect(opens).toBe(1);
});

test('a failing pane still returns the tool result', async ($, on) => {
  const seen: unknown[] = [];
  stubTools(on, seen);
  on('ui.open', () => ({ deny: 'no panes here' }));
  on('ui.toast', done);
  const first = await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  const second = await $.tool.call({ tool: TOOL + 'step', step: { expect: 'comments are shown' } });
  expect(first).toEqual(seen[0]);
  expect(second).toEqual(seen[1]);
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /^\? expect "comments are shown"/ })).toBeDefined();
  await ui.unmount();
});

test('an error result adds no row', async ($, on) => {
  on('tool.call', () => ({
    ref: 1,
    result: { content: [{ type: 'text', text: 'call open first' }], isError: true },
    text: 'call open first',
    isError: true,
  }));
  on('ui.open', placed);
  await $.tool.call({ tool: TOOL + 'step', step: { click: 'Add' } });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'Waiting for the first step…' })).toBeDefined();
  await ui.unmount();
});

test("Save reports the server's error", async ($, on) => {
  const toasts: string[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'call open first' }], isError: true } }));
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text);
    return done();
  });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'save' });
  expect(toasts).toContain('Save failed: call open first');
  await ui.unmount();
});

test('a pane held back by a narrow terminal points to the command', async ($, on) => {
  const toasts: string[] = [];
  stubTools(on);
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is narrower than 144 columns' } }));
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text);
    return done();
  });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  await new Promise((settle) => setTimeout(settle, 10)); // the pane opens without holding the tool result
  expect(toasts).toEqual(['Run /plainwright-pane to show the plainwright session pane']);
});

test('a new goal drops the typed spec path, so a new flow does not overwrite the old spec', async ($, on) => {
  stubTools(on);
  on('ui.open', placed);
  on('mcp.call', () => ({ value: mcp({ path: '/work/a.yaml', steps: 1 }) }));
  on('ui.toast', done);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/', goal: 'Flow A' });
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.input({ key: 'save-path', text: 'a.yaml' });
  expect((await ui.find({ key: 'save-path' }))?.props.value).toBe('a.yaml');
  await ui.unmount();
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/b', goal: 'Flow B' });
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ key: 'save-path' }))?.props.value).toBe('flow-b.yaml');
  await ui.unmount();
});
