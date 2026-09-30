import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MAX_CANDIDATES } from './jev.js';
// Identity excludes changing values/checked state, but includes labels and native identifiers.
export function nodeIdentity(node) {
    return JSON.stringify([node.role, node.name, ...['resource-id', 'name', 'label', 'content-desc', 'text'].map(k => node.attrs[k] ?? '')]);
}
/**
 * `boundsVisibility`: for an iOS source read without the costly `visible` attribute (AppiumAdapter), a node
 * counts as visible when its frame has an area inside the window and every scrolling ancestor. This keeps
 * every node XCUITest reports visible (checked on recorded Calendar trees) but also keeps covered ones
 * (content under a sheet), so it is only for picking targets whose visibility is confirmed before acting.
 */
export function parseMobileTree(xml, { boundsVisibility = false } = {}) {
    if (xml.length > 5_000_000)
        throw new Error('Mobile UI source exceeds 5 MB');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new Error('DTD/entity declarations are not supported in mobile UI source');
    if (XMLValidator.validate(xml) !== true)
        throw new Error('Appium returned invalid XML UI source');
    const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
        parseAttributeValue: false, parseTagValue: false, ignoreDeclaration: true }).parse(xml);
    let count = 0, truncated = false;
    function walk(items, path, depth, visible, enabled, clip) {
        const nodes = [];
        let ordinal = 0;
        for (const item of items) {
            const tag = Object.keys(item).find(k => k !== ':@' && !k.startsWith('#') && !k.startsWith('?'));
            if (!tag)
                continue;
            ordinal++;
            if (count >= 5000 || depth > 32) {
                truncated = true;
                break;
            }
            count++;
            const attrs = (item[':@'] ?? {});
            const role = attrs.type ?? attrs.class ?? tag;
            const password = attrs.password === 'true' || /SecureTextField/.test(role);
            const ownName = password ? attrs['content-desc'] || attrs.label || 'password' : attrs['content-desc'] || attrs.label || attrs.text || attrs.name || '';
            // XCUITest can mark a layout container invisible while its controls are visible.
            // Its explicit per-element visibility wins; Android visibility remains inherited.
            const nativeVisible = attrs.visible !== 'false' && attrs.displayed !== 'false';
            let box, childClip = clip;
            if (boundsVisibility && attrs.visible === undefined && attrs.x !== undefined) {
                box = { left: +attrs.x, top: +attrs.y, right: +attrs.x + +attrs.width, bottom: +attrs.y + +attrs.height };
                if (/ScrollView|Table|CollectionView|Window|Application/.test(role))
                    childClip = !clip ? box : { left: Math.max(clip.left, box.left),
                        top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
            }
            const effectiveVisible = box ? box.right > box.left && box.bottom > box.top && (!clip ||
                (box.left < clip.right && box.right > clip.left && box.top < clip.bottom && box.bottom > clip.top))
                : role.startsWith('XCUIElementType') && attrs.visible !== undefined ? nativeVisible : visible && nativeVisible;
            const node = { path: `${path}/*[${ordinal}]`, attrs, role, name: ownName,
                visible: effectiveVisible,
                enabled: enabled && attrs.enabled !== 'false', children: [] };
            node.children = walk(item[tag], node.path, depth + 1, node.visible, node.enabled, childClip);
            // React Native often puts text inside an otherwise unnamed pressable container.
            if (!node.name)
                node.name = node.children.filter(c => c.visible).map(c => c.name).filter(Boolean).join(' ').slice(0, 500);
            nodes.push(node);
        }
        return nodes;
    }
    // XCUITest wraps page source in AppiumAUT, but its XPath lookup is rooted at the
    // application itself. Remove only this synthetic wrapper so paths address real nodes.
    const source = parsed.length === 1 && Array.isArray(parsed[0].AppiumAUT)
        ? parsed[0].AppiumAUT : parsed;
    const roots = walk(source, '', 0, true, true);
    return { roots, truncated };
}
export function findMobileNode(roots, path) {
    for (const node of roots) {
        if (node.path === path)
            return node;
        if (path.startsWith(node.path + '/')) {
            const found = findMobileNode(node.children, path);
            if (found)
                return found;
        }
    }
}
export function mobileMatches(node, kind) {
    if (!node.visible)
        return false;
    if (kind === 'region')
        return true;
    if (!node.enabled)
        return false;
    if (kind === 'fill')
        return node.attrs.editable === 'true' || /EditText|AutoCompleteTextView|XCUIElementType(SecureTextField|TextField|TextView|SearchField|PickerWheel)/.test(node.role);
    if (kind === 'check')
        return node.attrs.checkable === 'true' || /Switch|CheckBox|Checkbox|ToggleButton/.test(node.role);
    if (kind === 'scroll')
        return node.attrs.scrollable === 'true' || /ScrollView|ListView|RecyclerView|Table|CollectionView|WebView/.test(node.role);
    return node.attrs.clickable === 'true' || node.attrs['long-clickable'] === 'true' || node.attrs.focusable === 'true' ||
        /Button|Link|Cell|TextField|TextView|EditText|Switch|CheckBox|Checkbox|Image|StaticText/.test(node.role) ||
        (node.attrs.accessible === 'true' && !!node.name);
}
export function mobileFrame(roots, kind, state, generation, truncated = false) {
    const candidates = [], elements = new Map(), lines = [];
    let chars = 0;
    function walk(nodes, depth, context) {
        for (const node of nodes) {
            if (!node.visible) {
                // Keep hidden nodes out of the snapshot/candidates, but inspect descendants:
                // a native iOS child's explicit visible=true is independent of its container.
                walk(node.children, depth, context);
                continue;
            }
            if (chars >= 60000) {
                truncated = true;
                return;
            }
            const a = node.attrs;
            const password = a.password === 'true' || /SecureTextField/.test(node.role);
            const nativeValue = a.value ?? (mobileMatches(node, 'fill') ? a.text : undefined);
            const value = !password && nativeValue !== undefined ? ` value=${JSON.stringify(nativeValue)}` : '';
            const checkable = a.checkable === 'true' || /Switch|CheckBox|Checkbox|ToggleButton/.test(node.role);
            const flags = [!node.enabled && 'disabled', checkable && a.checked !== undefined && `checked=${a.checked}`, a.selected === 'true' && 'selected', password && 'password'].filter(Boolean).join(' ');
            const desc = `${node.role} ${JSON.stringify(password ? a.label || a['content-desc'] || 'password' : node.name)}${value}${flags ? ` [${flags}]` : ''}`;
            const line = `${'  '.repeat(depth)}${desc}\n`;
            if (chars + line.length > 60000)
                truncated = true;
            lines.push(line.slice(0, 60000 - chars));
            chars += line.length;
            if (mobileMatches(node, kind)) {
                if (candidates.length >= MAX_CANDIDATES)
                    truncated = true;
                else {
                    const id = candidates.length;
                    candidates.push({ id, desc: `${desc}${context ? ` in ${context}` : ''}` });
                    elements.set(id, { path: node.path, identity: nodeIdentity(node), generation });
                }
            }
            walk(node.children, depth + 1, node.name ? `${node.role} ${JSON.stringify(node.name)}` : context);
        }
    }
    walk(roots, 0, '');
    return { snapshot: { ...state, aria: lines.join(''), truncated }, candidates, elements };
}
