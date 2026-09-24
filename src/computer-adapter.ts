import type { App, Element } from '@crowecawcaw/xa11y';
import type { Candidate, Frame } from './automation.js';
import { MAX_CANDIDATES } from './jev.js';
import type { NativeAdapter } from './native.js';

export type ComputerKind = 'click' | 'fill' | 'check' | 'hover' | 'region' | 'scroll';
export type ComputerAction = 'click' | 'fill' | 'check' | 'uncheck' | 'hover' | 'dblclick' | 'rightclick' | 'scroll';
export interface ComputerTarget { app?: string; pid?: number; }
export interface ComputerAdapter<T = unknown> extends NativeAdapter<T, ComputerKind> {
  apps(): Promise<{ name: string; pid: number | null }[]>;
  open(target: ComputerTarget, activate: boolean): Promise<{ name: string; pid: number | null }>;
  act(kind: ComputerAction, element: T, value?: string): Promise<void>;
  mouse(x: number, y: number): Promise<void>;
  drag(source: T, target: T): Promise<void>;
}

export function matchesKind(el: Pick<Element, 'visible' | 'enabled' | 'editable' | 'checked' | 'actions' | 'focusable' | 'role'>, kind: ComputerKind): boolean {
  if (kind === 'region') return el.visible;
  if (kind === 'scroll') return el.visible && /scroll|list|table|tree|text|window|group/.test(el.role);
  if (!el.visible || !el.enabled) return false;
  if (kind === 'fill') return el.editable || el.actions.includes('set_value');
  if (kind === 'check') return el.checked !== null;
  return el.actions.length > 0 || el.focusable || /button|link|menu_item|tab|row|cell|image/.test(el.role);
}

type Node = Pick<Element, 'role' | 'name' | 'value' | 'visible' | 'enabled' | 'editable' | 'checked' | 'selected' | 'focused' |
  'actions' | 'focusable' | 'modal'> & { children(): Promise<Node[]> };
const TEXT_ROLE = /^(static_text|text)$/;
// The parts of a control rather than controls of their own: inside a candidate they are not candidates.
const PART_ROLE = /^(static_text|text|group|image|generic)$/;

/**
 * Walks an accessibility tree into the snapshot text and the candidates for `kind`. Electron and web
 * views list a control's own label as a separate static_text with actions ("Files & links" the tab, and
 * inside it "Files & links" the text): as two candidates they split Jev's confidence between one thing.
 * Text, groups and images inside a candidate are not candidates themselves (a real control inside one,
 * such as a row's button, still is); an unnamed candidate (Slack's Activity tab) is described by the text
 * inside it instead.
 */
export async function captureTree<T extends Node>(root: T, kind: ComputerKind, timeout: number):
  Promise<{ snapshot: { aria: string; truncated: boolean }; candidates: Candidate[]; elements: Map<number, T>; web: Set<T> }> {
  const candidates: Candidate[] = [];
  const elements = new Map<number, T>();
  const web = new Set<T>(); // candidates inside a web view (Electron apps, embedded browsers)
  const lines: string[] = [];
  let chars = 0, visited = 0, truncated = false;
  const deadline = Date.now() + timeout;
  // Returns the visible text of the subtree (capped), so an unnamed candidate can be described by it.
  const walk = async (el: T, depth: number, context: string, inCandidate: boolean, inWeb = false): Promise<string> => {
    if (++visited > 5000 || chars >= 60000 || Date.now() >= deadline) { truncated = true; return ''; }
    const state = [!el.enabled && 'disabled', el.checked && `checked=${el.checked}`, el.selected && 'selected', el.focused && 'focused'].filter(Boolean).join(' ');
    const desc = `${el.role} ${JSON.stringify(el.name ?? '')}${el.value === null ? '' : ` value=${JSON.stringify(el.value)}`}${state ? ` [${state}]` : ''}`;
    const line = `${'  '.repeat(depth)}${desc}\n`;
    lines.push(line.slice(0, 60000 - chars)); chars += line.length;
    const isText = TEXT_ROLE.test(el.role);
    let id: number | undefined;
    if (matchesKind(el, kind) && !(inCandidate && PART_ROLE.test(el.role))) {
      if (candidates.length < MAX_CANDIDATES) {
        id = candidates.length;
        candidates.push({ id, desc: `${desc}${context ? ` in ${context}` : ''}` });
        elements.set(id, el);
        if (inWeb) web.add(el);
      } else truncated = true;
    }
    let text = isText ? String(el.value || el.name || '') : '';
    if (depth >= 32) { truncated = true; return text; }
    const children = (await el.children()) as T[];
    // Modal/window contents win the cap before app menus and background content.
    children.sort((a, b) => Number(b.modal || b.role === 'dialog') - Number(a.modal || a.role === 'dialog'));
    for (const child of children) {
      if (visited >= 5000 || chars >= 60000 || Date.now() >= deadline) { truncated = true; break; }
      const inner = await walk(child, depth + 1, el.name ? `${el.role} ${JSON.stringify(el.name)}` : context, inCandidate || id !== undefined, inWeb || el.role === 'web_area');
      if (inner && text.length < 80) text = `${text} ${inner}`.trim().slice(0, 80);
    }
    // Only the name matters: Slack's tabs carry value "0"/"1" (their selection), not a label.
    if (id !== undefined && !el.name && text && text !== el.value) candidates[id].desc = candidates[id].desc.replace(desc, `${desc} text=${JSON.stringify(text)}`);
    return text;
  };
  await walk(root, 0, '', false);
  return { snapshot: { aria: lines.join(''), truncated }, candidates, elements, web };
}

// Lazy native import: browser use and MCP discovery work without desktop binaries or permissions.
export class Xa11yAdapter implements ComputerAdapter<Element> {
  private app: App | null = null;
  // Web content ignores the accessibility press on many elements (a Slack tab "clicked" that never
  // switched): those get a real pointer click. Native controls keep press, which needs no focus.
  private web = new WeakSet<Element>();
  constructor(private timeout = 15000) {}
  private async sdk() {
    try { return (await import('@crowecawcaw/xa11y')).default; }
    catch (error) { throw new Error(`Desktop backend unavailable. Install @crowecawcaw/xa11y@0.15.0 with optional native packages enabled. ${error}`); }
  }
  private current(): App {
    if (!this.app) throw new Error('call open first');
    return this.app;
  }
  async apps() {
    const sdk = await this.sdk();
    return (await sdk.App.list()).map(({ name, pid }) => ({ name, pid }));
  }
  async open(target: ComputerTarget, activate: boolean) {
    const sdk = await this.sdk();
    const app = target.pid !== undefined ? await sdk.App.byPid(target.pid, { timeout: this.timeout }) :
      await sdk.App.byName(target.app!, { timeout: this.timeout });
    if (activate) {
      const windows = await app.windows();
      const window = windows.find((w) => w.active) ?? windows.find((w) => w.modal) ?? windows[0];
      if (!window) throw new Error(`No window to activate for ${app.name}`);
      await window.activate();
    }
    this.app = app;
    return { name: app.name, pid: app.pid };
  }
  async capture(kind: ComputerKind, within?: Element): Promise<Frame<Element>> {
    const app = this.current();
    const { web, ...frame } = await captureTree(within ?? app.asElement(), kind, this.timeout);
    for (const el of web) this.web.add(el);
    return { ...frame, snapshot: { url: `desktop://${app.pid ?? encodeURIComponent(app.name)}`, title: app.name, ...frame.snapshot } };
  }
  private async foreground() {
    const app = this.current();
    const sdk = await this.sdk();
    const active = await sdk.App.foreground({ timeout: 0 });
    if (app.pid === null || active.pid !== app.pid) throw new Error(`Desktop focus changed. Open ${app.name} with activate: true before sending input.`);
    return sdk.inputSim();
  }
  async act(kind: ComputerAction, element: Element, value?: string) {
    if (kind === 'click' && !this.web.has(element)) return element.press();
    if (kind === 'fill') return element.setValue(value!);
    if (kind === 'check' || kind === 'uncheck') {
      if (element.checked === null) throw new Error('Control does not expose checked state');
      if (element.checked !== (kind === 'check' ? 'on' : 'off')) {
        if (element.checked === 'mixed') throw new Error('Mixed checkbox state cannot be set reliably; use click and verify');
        await element.toggle();
      }
      return;
    }
    const input = await this.foreground();
    if (kind === 'click') return input.click(element);
    if (kind === 'hover') return input.moveTo(element);
    if (kind === 'dblclick') return input.doubleClick(element);
    if (kind === 'rightclick') return input.rightClick(element);
    // Wheel scrolling works on macOS too (scrollIntoView is a no-op there).
    return input.scroll(element, 0, Number(value ?? 3));
  }
  async press(key: string) {
    const parts = key.split('+').map((s) => s.trim());
    if (parts.some((s) => !s)) throw new Error('Use a key or modifier+key, e.g. Control+a');
    const input = await this.foreground();
    const last = parts.pop()!;
    return parts.length ? input.chord(last, parts) : input.press(last);
  }
  async mouse(x: number, y: number) { await (await this.foreground()).moveTo([x, y]); }
  async drag(source: Element, target: Element) { await (await this.foreground()).drag(source, target); }
  async screenshot() {
    const sdk = await this.sdk();
    const windows = await this.current().windows();
    const window = windows.find((w) => w.active) ?? windows[0];
    if (!window) throw new Error('No application window available for screenshot');
    return (await sdk.screenshot({ element: window })).toPng();
  }
  async close() { this.app = null; } // Detach; never quit the user's app.
}
