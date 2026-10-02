// The mods API is typed by the declarations Claude Code writes into .claude-plugin/types/ for the installed version;
// nothing type-checks this module at build time, so the hook arguments stay `any` here.
import { ENGINE, PLUGIN } from './config.ts';
import { apply, emptyState, jsonOf, payload, saveName, type State } from './model.ts';
import { render, type Elements } from './view.ts';

/** The pane and its command are named after the plugin, so each plugin's copy has its own. */
const PANE = PLUGIN;
const COMMAND = `${PLUGIN}-pane`;
/** Every tool of this plugin's MCP server, which has the plugin's name: `mcp__plugin_plainwright_plainwright__step`. */
const TOOL = new RegExp(`^mcp__plugin_${PLUGIN}_${PLUGIN}__(\\w+)$`);
/** The plugin's own MCP server, named as `$.mcp.call` takes it: the tool-name spelling without `mcp__` (the server has the plugin's name, as TOOL assumes). */
const SERVER = `plugin_${PLUGIN}_${PLUGIN}`;

let state: State = emptyState();
/** What the user typed in the Spec field; undefined follows the goal. */
let typedPath: string | undefined;
/** Whether this session's first `open` already showed the pane: later ones never reopen it. */
let shown = false;

const specPath = (): string => typedPath?.trim() || saveName(state.goal);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorText = (result: any): string => result?.content?.find((block: any) => block?.type === 'text')?.text ?? 'unknown error';

async function show($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: PLUGIN });
}

/** Asks the plugin's own server to write the passing steps: the same session Claude is driving. */
async function save($: any, path: string): Promise<void> {
  try {
    const result = await $.mcp.call(SERVER, 'save', { path });
    const data = jsonOf(result);
    $.ui.toast(result?.isError ? `Save failed: ${errorText(result)}` : `Saved ${data?.steps ?? '?'} steps to ${data?.path ?? path}`);
  } catch (error) {
    $.ui.toast(`Save failed: ${message(error)}`);
  }
}

async function copy($: any): Promise<void> {
  if (!state.lastFailure) return;
  try {
    const copied = await $.ui.copy({ text: JSON.stringify(state.lastFailure, null, 2) });
    $.ui.toast(copied?.isCopied ? 'Copied the last failure' : `Copy failed: ${copied?.reason ?? 'nothing was copied'}`);
  } catch (error) {
    $.ui.toast(`Copy failed: ${message(error)}`);
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    await $.command.register({ name: COMMAND, description: `Show the ${PLUGIN} session pane`, immediate: true });
    return next(e);
  });

  on('command.run', { command: COMMAND }, async ($: any) => {
    await show($);
    return {};
  });

  // Observe only: the result goes back to Claude exactly as the server sent it, whatever happens in here.
  on('tool.call', { tool: TOOL }, async ($: any, e: any, next: any) => {
    const outcome = await next(e);
    try {
      const data = payload(outcome);
      if (data) {
        const tool = TOOL.exec(e.tool)![1];
        state = apply(state, ENGINE, tool, e, data);
        $.ui.invalidate('ui.render');
        if (tool === 'open' && !shown) {
          shown = true;
          void show($).catch((error: unknown) => $.ui.toast(`${PLUGIN} pane: ${message(error)}`));
        }
      }
    } catch (error) {
      $.ui.toast(`${PLUGIN} pane: ${message(error)}`);
    }
    return outcome;
  });

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE) return next(e);
    return render(state, $.ui.resolve(e) as Elements, {
      columns: e.props?.bodyColumns ?? 60,
      savePath: specPath(),
      onSavePath: (path) => {
        typedPath = path;
      },
      onSave: (path) => save($, path?.trim() || specPath()),
      onCopy: () => copy($),
    });
  });
}
