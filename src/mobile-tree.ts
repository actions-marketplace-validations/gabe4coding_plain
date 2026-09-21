import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MAX_CANDIDATES } from './jev.js';
import type { Candidate, Snapshot } from './automation.js';

export type MobileKind = 'click' | 'fill' | 'check' | 'region' | 'scroll';
export interface MobileNode {
  path: string;
  attrs: Record<string, string>;
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  children: MobileNode[];
}
export interface MobileElement {
  path: string;
  identity: string;
  generation: number;
}
export interface MobileFrame<T = MobileElement> {
  snapshot: Snapshot;
  candidates: Candidate[];
  elements: Map<number, T>;
}
// Identity excludes changing values/checked state, but includes labels and native identifiers.
export function nodeIdentity(node: MobileNode): string {
  return JSON.stringify([node.role, node.name, ...['resource-id', 'name', 'label', 'content-desc', 'text'].map(k => node.attrs[k] ?? '')]);
}

export function parseMobileTree(xml: string): { roots: MobileNode[]; truncated: boolean } {
  if (xml.length > 5_000_000) throw new Error('Mobile UI source exceeds 5 MB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are not supported in mobile UI source');
  if (XMLValidator.validate(xml) !== true) throw new Error('Appium returned invalid XML UI source');
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
    parseAttributeValue: false, parseTagValue: false, ignoreDeclaration: true }).parse(xml) as Record<string, unknown>[];
  let count = 0, truncated = false;
  function walk(items: Record<string, unknown>[], path: string, depth: number, visible: boolean, enabled: boolean): MobileNode[] {
    const nodes: MobileNode[] = [];
    let ordinal = 0;
    for (const item of items) {
      const tag = Object.keys(item).find(k => k !== ':@' && !k.startsWith('#') && !k.startsWith('?'));
      if (!tag) continue;
      ordinal++;
      if (count >= 5000 || depth > 32) { truncated = true; break; }
      count++;
      const attrs = (item[':@'] ?? {}) as Record<string, string>;
      const role = attrs.type ?? attrs.class ?? tag;
      const password = attrs.password === 'true' || /SecureTextField/.test(role);
      const ownName = password ? attrs['content-desc'] || attrs.label || 'password' : attrs['content-desc'] || attrs.label || attrs.text || attrs.name || '';
      // XCUITest can mark a layout container invisible while its controls are visible.
      // Its explicit per-element visibility wins; Android visibility remains inherited.
      const nativeVisible = attrs.visible !== 'false' && attrs.displayed !== 'false';
      const effectiveVisible = role.startsWith('XCUIElementType') && attrs.visible !== undefined
        ? nativeVisible : visible && nativeVisible;
      const node: MobileNode = { path: `${path}/*[${ordinal}]`, attrs, role, name: ownName,
        visible: effectiveVisible,
        enabled: enabled && attrs.enabled !== 'false', children: [] };
      node.children = walk(item[tag] as Record<string, unknown>[], node.path, depth + 1, node.visible, node.enabled);
      // React Native often puts text inside an otherwise unnamed pressable container.
      if (!node.name) node.name = node.children.filter(c => c.visible).map(c => c.name).filter(Boolean).join(' ').slice(0, 500);
      nodes.push(node);
    }
    return nodes;
  }
  // XCUITest wraps page source in AppiumAUT, but its XPath lookup is rooted at the
  // application itself. Remove only this synthetic wrapper so paths address real nodes.
  const source = parsed.length === 1 && Array.isArray(parsed[0].AppiumAUT)
    ? parsed[0].AppiumAUT as Record<string, unknown>[] : parsed;
  const roots = walk(source, '', 0, true, true);
  return { roots, truncated };
}

export function findMobileNode(roots: MobileNode[], path: string): MobileNode | undefined {
  for (const node of roots) {
    if (node.path === path) return node;
    if (path.startsWith(node.path + '/')) { const found = findMobileNode(node.children, path); if (found) return found; }
  }
}

export function mobileMatches(node: MobileNode, kind: MobileKind): boolean {
  if (!node.visible) return false;
  if (kind === 'region') return true;
  if (!node.enabled) return false;
  if (kind === 'fill') return node.attrs.editable === 'true' || /EditText|AutoCompleteTextView|XCUIElementType(SecureTextField|TextField|TextView|SearchField|PickerWheel)/.test(node.role);
  if (kind === 'check') return node.attrs.checkable === 'true' || /Switch|CheckBox|Checkbox|ToggleButton/.test(node.role);
  if (kind === 'scroll') return node.attrs.scrollable === 'true' || /ScrollView|ListView|RecyclerView|Table|CollectionView|WebView/.test(node.role);
  return node.attrs.clickable === 'true' || node.attrs['long-clickable'] === 'true' || node.attrs.focusable === 'true' ||
    /Button|Link|Cell|TextField|TextView|EditText|Switch|CheckBox|Checkbox|Image|StaticText/.test(node.role) ||
    (node.attrs.accessible === 'true' && !!node.name);
}

export function mobileFrame(roots: MobileNode[], kind: MobileKind, state: { url: string; title: string }, generation: number, truncated = false): MobileFrame {
  const candidates: Candidate[] = [], elements = new Map<number, MobileElement>(), lines: string[] = [];
  let chars = 0;
  function walk(nodes: MobileNode[], depth: number, context: string) {
    for (const node of nodes) {
      if (!node.visible) {
        // Keep hidden nodes out of the snapshot/candidates, but inspect descendants:
        // a native iOS child's explicit visible=true is independent of its container.
        walk(node.children, depth, context);
        continue;
      }
      if (chars >= 60000) { truncated = true; return; }
      const a = node.attrs;
      const password = a.password === 'true' || /SecureTextField/.test(node.role);
      const nativeValue = a.value ?? (mobileMatches(node, 'fill') ? a.text : undefined);
      const value = !password && nativeValue !== undefined ? ` value=${JSON.stringify(nativeValue)}` : '';
      const checkable = a.checkable === 'true' || /Switch|CheckBox|Checkbox|ToggleButton/.test(node.role);
      const flags = [!node.enabled && 'disabled', checkable && a.checked !== undefined && `checked=${a.checked}`, a.selected === 'true' && 'selected', password && 'password'].filter(Boolean).join(' ');
      const desc = `${node.role} ${JSON.stringify(password ? a.label || a['content-desc'] || 'password' : node.name)}${value}${flags ? ` [${flags}]` : ''}`;
      const line = `${'  '.repeat(depth)}${desc}\n`;
      if (chars + line.length > 60000) truncated = true;
      lines.push(line.slice(0, 60000 - chars)); chars += line.length;
      if (mobileMatches(node, kind)) {
        if (candidates.length >= MAX_CANDIDATES) truncated = true;
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
