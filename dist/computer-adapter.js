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
// Lazy native import: browser use and MCP discovery work without desktop binaries or permissions.
export class Xa11yAdapter {
    timeout;
    app = null;
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
        const candidates = [];
        const elements = new Map();
        const lines = [];
        let chars = 0, visited = 0, truncated = false;
        const deadline = Date.now() + this.timeout;
        const walk = async (el, depth, context) => {
            if (++visited > 5000 || chars >= 60000 || Date.now() >= deadline) {
                truncated = true;
                return;
            }
            const state = [!el.enabled && 'disabled', el.checked && `checked=${el.checked}`, el.selected && 'selected', el.focused && 'focused'].filter(Boolean).join(' ');
            const desc = `${el.role} ${JSON.stringify(el.name ?? '')}${el.value === null ? '' : ` value=${JSON.stringify(el.value)}`}${state ? ` [${state}]` : ''}`;
            const line = `${'  '.repeat(depth)}${desc}\n`;
            lines.push(line.slice(0, 60000 - chars));
            chars += line.length;
            if (matchesKind(el, kind)) {
                if (candidates.length < MAX_CANDIDATES) {
                    const id = candidates.length;
                    candidates.push({ id, desc: `${desc}${context ? ` in ${context}` : ''}` });
                    elements.set(id, el);
                }
                else
                    truncated = true;
            }
            if (depth >= 32) {
                truncated = true;
                return;
            }
            const children = await el.children();
            // Modal/window contents win the cap before app menus and background content.
            children.sort((a, b) => Number(b.modal || b.role === 'dialog') - Number(a.modal || a.role === 'dialog'));
            for (const child of children) {
                if (visited >= 5000 || chars >= 60000 || Date.now() >= deadline) {
                    truncated = true;
                    break;
                }
                await walk(child, depth + 1, el.name ? `${el.role} ${JSON.stringify(el.name)}` : context);
            }
        };
        await walk(within ?? app.asElement(), 0, '');
        return { snapshot: { url: `desktop://${app.pid ?? encodeURIComponent(app.name)}`, title: app.name, aria: lines.join(''), truncated }, candidates, elements };
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
        if (kind === 'click')
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
