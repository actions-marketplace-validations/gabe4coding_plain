import { MAX_CANDIDATES } from './jev.js';
export function matchesKind(el, kind) {
    if (kind === 'region')
        return el.visible;
    if (kind === 'scroll')
        return el.visible && /scroll|list|table|tree|text|window|group/.test(el.role);
    if (!el.visible || !el.enabled)
        return false;
    if (kind === 'fill')
        return el.editable || el.actions.includes('set_value');
    if (kind === 'check')
        return el.checked !== null;
    return el.actions.length > 0 || el.focusable || /button|link|menu_item|tab|row|cell|image/.test(el.role);
}
const TEXT_ROLE = /^(static_text|text)$/;
// The parts of a control rather than controls of their own: inside a candidate they are not candidates.
// A table cell inside a candidate row is a part too (Fork lists each commit as a row plus its 5 cells).
const PART_ROLE = /^(static_text|text|group|image|generic|table_cell|cell)$/;
// A candidate names the start of a long value (an editor's whole file); the snapshot keeps all of it.
const VALUE_CHARS = 100;
// Enough inner text to name a row by all its cells (message, author, hash, date).
const TEXT_CHARS = 160;
/**
 * Walks an accessibility tree into the snapshot text and the candidates for `kind`. Electron and web
 * views list a control's own label as a separate static_text with actions ("Files & links" the tab, and
 * inside it "Files & links" the text): as two candidates they split Jev's confidence between one thing.
 * Text, groups and images inside a candidate are not candidates themselves (a real control inside one,
 * such as a row's button, still is); an unnamed candidate (Slack's Activity tab) is described by the text
 * inside it instead. "in window X" is left out when the app has one window, and "in application X" always: it would repeat on every candidate.
 */
export async function captureTree(root, kind, timeout) {
    const candidates = [];
    const elements = new Map();
    const web = new Set(); // candidates inside a web view (Electron apps, embedded browsers)
    const lines = [];
    let chars = 0, visited = 0, truncated = false;
    const deadline = Date.now() + timeout;
    // Returns the visible text of the subtree (capped), so an unnamed candidate can be described by it.
    const walk = async (el, depth, context, inCandidate, inWeb = false) => {
        if (++visited > 5000 || chars >= 60000 || Date.now() >= deadline) {
            truncated = true;
            return '';
        }
        const state = [!el.enabled && 'disabled', el.checked && `checked=${el.checked}`, el.selected && 'selected', el.focused && 'focused'].filter(Boolean).join(' ');
        const named = `${el.role} ${JSON.stringify(el.name ?? '')}`, flags = state ? ` [${state}]` : '';
        const desc = `${named}${el.value === null ? '' : ` value=${JSON.stringify(el.value)}`}${flags}`;
        const short = el.value !== null && el.value.length > VALUE_CHARS ? `${named} value=${JSON.stringify(`${el.value.slice(0, VALUE_CHARS)}…`)}${flags}` : desc;
        const line = `${'  '.repeat(depth)}${desc}\n`;
        lines.push(line.slice(0, 60000 - chars));
        chars += line.length;
        const isText = TEXT_ROLE.test(el.role);
        let id;
        if (matchesKind(el, kind) && !(inCandidate && PART_ROLE.test(el.role))) {
            if (candidates.length < MAX_CANDIDATES) {
                id = candidates.length;
                candidates.push({ id, desc: `${short}${context ? ` in ${context}` : ''}` });
                elements.set(id, el);
                if (inWeb)
                    web.add(el);
            }
            else
                truncated = true;
        }
        let text = isText ? String(el.value || el.name || '') : '';
        if (depth >= 32) {
            truncated = true;
            return text;
        }
        const children = (await el.children());
        // Modal/window contents win the cap before app menus and background content.
        children.sort((a, b) => Number(b.modal || b.role === 'dialog') - Number(a.modal || a.role === 'dialog'));
        const own = el.name && el.role !== 'application' && !(el.role === 'window' && windows === 1) ? `${el.role} ${JSON.stringify(el.name)}` : context;
        for (const child of children) {
            if (visited >= 5000 || chars >= 60000 || Date.now() >= deadline) {
                truncated = true;
                break;
            }
            const inner = await walk(child, depth + 1, own, inCandidate || id !== undefined, inWeb || el.role === 'web_area');
            if (inner && text.length < TEXT_CHARS)
                text = `${text} ${inner}`.trim().slice(0, TEXT_CHARS);
        }
        // Only the name matters: Slack's tabs carry value "0"/"1" (their selection), not a label.
        if (id !== undefined && !el.name && text && text !== el.value)
            candidates[id].desc = candidates[id].desc.replace(short, `${short} text=${JSON.stringify(text)}`);
        return text;
    };
    const windows = root.role === 'application' ? (await root.children()).filter((c) => c.role === 'window').length : 0;
    await walk(root, 0, '', false);
    return { snapshot: { aria: lines.join(''), truncated }, candidates, elements, web };
}
// Lazy native import: browser use and MCP discovery work without desktop binaries or permissions.
export class Xa11yAdapter {
    timeout;
    app = null;
    // Web content ignores the accessibility press on many elements (a Slack tab "clicked" that never
    // switched): those get a real pointer click. Native controls keep press, which needs no focus,
    // unless they do not offer it (a Fork sidebar row): then the pointer click too.
    web = new WeakSet();
    constructor(timeout = 15000) {
        this.timeout = timeout;
    }
    async sdk() {
        try {
            return (await import('@crowecawcaw/xa11y')).default;
        }
        catch (error) {
            throw new Error(`Desktop backend unavailable. Install @crowecawcaw/xa11y@0.15.0 with optional native packages enabled. ${error}`);
        }
    }
    current() {
        if (!this.app)
            throw new Error('call open first');
        return this.app;
    }
    async apps() {
        const sdk = await this.sdk();
        return (await sdk.App.list()).map(({ name, pid }) => ({ name, pid }));
    }
    async open(target, activate) {
        const sdk = await this.sdk();
        const app = target.pid !== undefined ? await sdk.App.byPid(target.pid, { timeout: this.timeout }) :
            await sdk.App.byName(target.app, { timeout: this.timeout });
        if (activate) {
            const windows = await app.windows();
            const window = windows.find((w) => w.active) ?? windows.find((w) => w.modal) ?? windows[0];
            if (!window)
                throw new Error(`No window to activate for ${app.name}`);
            await window.activate();
        }
        this.app = app;
        return { name: app.name, pid: app.pid };
    }
    async capture(kind, within) {
        const app = this.current();
        const { web, ...frame } = await captureTree(within ?? app.asElement(), kind, this.timeout);
        for (const el of web)
            this.web.add(el);
        return { ...frame, snapshot: { url: `desktop://${app.pid ?? encodeURIComponent(app.name)}`, title: app.name, ...frame.snapshot } };
    }
    async foreground() {
        const app = this.current();
        const sdk = await this.sdk();
        const active = await sdk.App.foreground({ timeout: 0 });
        if (app.pid === null || active.pid !== app.pid)
            throw new Error(`Desktop focus changed. Open ${app.name} with activate: true before sending input.`);
        return sdk.inputSim();
    }
    async act(kind, element, value) {
        if (kind === 'click' && !this.web.has(element) && element.actions.includes('press'))
            return element.press();
        if (kind === 'fill')
            return element.setValue(value);
        if (kind === 'check' || kind === 'uncheck') {
            if (element.checked === null)
                throw new Error('Control does not expose checked state');
            if (element.checked !== (kind === 'check' ? 'on' : 'off')) {
                if (element.checked === 'mixed')
                    throw new Error('Mixed checkbox state cannot be set reliably; use click and verify');
                await element.toggle();
            }
            return;
        }
        const input = await this.foreground();
        if (kind === 'click')
            return input.click(element);
        if (kind === 'hover')
            return input.moveTo(element);
        if (kind === 'dblclick')
            return input.doubleClick(element);
        if (kind === 'rightclick')
            return input.rightClick(element);
        // Wheel scrolling works on macOS too (scrollIntoView is a no-op there).
        return input.scroll(element, 0, Number(value ?? 3));
    }
    async press(key) {
        const parts = key.split('+').map((s) => s.trim());
        if (parts.some((s) => !s))
            throw new Error('Use a key or modifier+key, e.g. Control+a');
        const input = await this.foreground();
        const last = parts.pop();
        return parts.length ? input.chord(last, parts) : input.press(last);
    }
    async mouse(x, y) { await (await this.foreground()).moveTo([x, y]); }
    async drag(source, target) { await (await this.foreground()).drag(source, target); }
    async screenshot() {
        const sdk = await this.sdk();
        const windows = await this.current().windows();
        const window = windows.find((w) => w.active) ?? windows[0];
        if (!window)
            throw new Error('No application window available for screenshot');
        return (await sdk.screenshot({ element: window })).toPng();
    }
    async close() { this.app = null; } // Detach; never quit the user's app.
}
