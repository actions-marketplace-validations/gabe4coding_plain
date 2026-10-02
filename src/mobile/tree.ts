import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MAX_CANDIDATES } from '../jev/jev.js';
import type { Candidate, Frame } from '../core/automation.js';

export type MobileKind = 'click' | 'fill' | 'check' | 'region' | 'scroll';
export interface MobileNode {
  path: string;
  /** iOS class chain to the node from the application (type and index among same-type siblings); '' elsewhere. */
  chain?: string;
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
  /** Picked from a capture without XCUITest's `visible` (AppiumAdapter.capture): visibility still unconfirmed. */
  approximate?: boolean;
  /** iOS: a class chain lookup (~220 ms on a Calendar sheet) is quicker than the XPath one (~270 ms). */
  chain?: string;
}
// Identity excludes changing values/checked state, but includes labels and native identifiers.
export function nodeIdentity(node: MobileNode): string {
  return JSON.stringify([node.role, node.name, ...['resource-id', 'name', 'label', 'content-desc', 'text'].map(k => node.attrs[k] ?? '')]);
}

/**
 * `boundsVisibility`: for an iOS source read without the costly `visible` attribute (AppiumAdapter), a node
 * counts as visible when its frame has an area inside the window and every scrolling ancestor (scroll, table,
 * collection and web views). This keeps
 * every node XCUITest reports visible (checked on recorded Calendar trees) but also keeps covered ones
 * (content under a sheet), so it is only for picking targets whose visibility is confirmed before acting.
 */
export function parseMobileTree(xml: string, { boundsVisibility = false } = {}): { roots: MobileNode[]; truncated: boolean } {
  if (xml.length > 5_000_000) throw new Error('Mobile UI source exceeds 5 MB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are not supported in mobile UI source');
  if (XMLValidator.validate(xml) !== true) throw new Error('Appium returned invalid XML UI source');
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
    parseAttributeValue: false, parseTagValue: false, ignoreDeclaration: true }).parse(xml) as Record<string, unknown>[];
  let count = 0, truncated = false;
  type Box = { left: number; top: number; right: number; bottom: number };
  function walk(items: Record<string, unknown>[], path: string, depth: number, visible: boolean, enabled: boolean, clip?: Box, chain?: string): MobileNode[] {
    const nodes: MobileNode[] = [];
    let ordinal = 0;
    const sameType = new Map<string, number>();
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
      let box: Box | undefined, childClip = clip;
      if (boundsVisibility && attrs.visible === undefined && attrs.x !== undefined) {
        box = { left: +attrs.x, top: +attrs.y, right: +attrs.x + +attrs.width, bottom: +attrs.y + +attrs.height };
        // Containers whose content can lie outside their own frame (scrolled away): a web view's page too.
        if (/ScrollView|Table|CollectionView|WebView|Window|Application/.test(role)) childClip = !clip ? box : { left: Math.max(clip.left, box.left),
          top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
      }
      const effectiveVisible = box ? box.right > box.left && box.bottom > box.top && (!clip ||
          (box.left < clip.right && box.right > clip.left && box.top < clip.bottom && box.bottom > clip.top))
        : role.startsWith('XCUIElementType') && attrs.visible !== undefined ? nativeVisible : visible && nativeVisible;
      const typeIndex = (sameType.get(role) ?? 0) + 1; sameType.set(role, typeIndex);
      // The application itself (depth 0) is the chain's root; below it, iOS types only.
      const nodeChain = chain === undefined ? '' : role.startsWith('XCUIElementType') ? `${chain}${chain ? '/' : ''}${role}[${typeIndex}]` : '';
      const node: MobileNode = { path: `${path}/*[${ordinal}]`, chain: nodeChain, attrs, role, name: ownName,
        visible: effectiveVisible,
        enabled: enabled && attrs.enabled !== 'false', children: [] };
      const childChain = depth === 0 && role === 'XCUIElementTypeApplication' ? '' : nodeChain || undefined;
      node.children = walk(item[tag] as Record<string, unknown>[], node.path, depth + 1, node.visible, node.enabled, childClip, childChain);
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

/** `containersOnly`: region candidates are only nodes with children (AppiumAdapter's approximate region picks). */
/**
 * Jetpack Compose marks a clickable View's role with an unnamed, non-clickable child of the same bounds
 * (a Button inside "Add email" in Google Contacts). It is the same control: listing both split Jev's pick
 * between them (0.51/0.47, rejected), so the marker is not a candidate; its parent is.
 */
function roleMarker(node: MobileNode, parent?: MobileNode): boolean {
  const a = node.attrs;
  return !!parent && parent.attrs.clickable === 'true' && a.clickable === 'false' && a['long-clickable'] !== 'true' &&
    !a.text && !a['content-desc'] && a.bounds !== undefined && a.bounds === parent.attrs.bounds;
}

export function mobileFrame(roots: MobileNode[], kind: MobileKind, state: { url: string; title: string }, generation: number, truncated = false,
  { containersOnly = false } = {}): Frame<MobileElement> {
  const candidates: Candidate[] = [], elements = new Map<number, MobileElement>(), lines: string[] = [];
  let chars = 0;
  function walk(nodes: MobileNode[], depth: number, context: string, parent?: MobileNode) {
    for (const node of nodes) {
      if (!node.visible) {
        // Keep hidden nodes out of the snapshot/candidates, but inspect descendants:
        // a native iOS child's explicit visible=true is independent of its container.
        walk(node.children, depth, context, parent);
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
      if (mobileMatches(node, kind) && !(containersOnly && !node.children.length) && !roleMarker(node, parent)) {
        if (candidates.length >= MAX_CANDIDATES) truncated = true;
        else {
          const id = candidates.length;
          candidates.push({ id, desc: `${desc}${context ? ` in ${context}` : ''}` });
          elements.set(id, { path: node.path, identity: nodeIdentity(node), generation, ...(node.chain ? { chain: node.chain } : {}) });
        }
      }
      walk(node.children, depth + 1, node.name ? `${node.role} ${JSON.stringify(node.name)}` : context, node);
    }
  }
  walk(roots, 0, '');
  return { snapshot: { ...state, aria: lines.join(''), truncated }, candidates, elements };
}
