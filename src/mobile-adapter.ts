import type { Browser } from 'webdriverio';
import type { NativeAdapter } from './native.js';
import { MobileTargetSchema, type MobileTarget, type Direction } from './mobile-spec.js';
import { parseMobileTree, findMobileNode, nodeIdentity, mobileFrame, type MobileElement, type MobileKind } from './mobile-tree.js';

export type MobileAction = 'click' | 'tap' | 'fill' | 'dblclick' | 'longpress' | 'check' | 'uncheck';
export interface MobileAdapter<T = unknown> extends NativeAdapter<T, MobileKind> {
  open(target: MobileTarget): Promise<MobileTarget>;
  act(kind: MobileAction, element: T, value?: string): Promise<void>;
  gesture(kind: 'swipe' | 'scroll', direction: Direction, element?: T): Promise<void>;
}
type DriverCommands = 'getPageSource' | 'findElement' | 'elementClick' | 'elementClear' | 'elementSendKeys' |
  'getElementAttribute' | 'executeScript' | 'getWindowRect' | 'pressKeyCode' | 'hideKeyboard' | 'takeScreenshot' | 'deleteSession' | 'activateApp' |
  'getSettings' | 'updateSettings';
export type MobileDriver = { [K in DriverCommands]: OmitThisParameter<Browser[K]> };
export type ConnectMobile = (options: Parameters<typeof import('webdriverio').remote>[0]) => Promise<MobileDriver>;

export function mobileCapabilities(target: MobileTarget): Record<string, unknown> & { platformName: string } {
  // Session lifecycle belongs to Plainwright. Extra capabilities configure signing/device details only.
  const reserved = new Set(['platformName', 'browserName', 'appium:automationName', 'appium:udid', 'appium:app', 'appium:bundleId',
    'appium:appPackage', 'appium:noReset', 'appium:fullReset', 'appium:autoLaunch', 'appium:dontStopAppOnReset',
    'appium:forceAppLaunch', 'appium:shouldTerminateApp', 'appium:autoWebview']);
  for (const key of Object.keys(target.capabilities ?? {})) {
    if (reserved.has(key) || !key.includes(':') || key === 'appium:options')
      throw new Error(`Capability ${key} is managed by Plainwright or unsupported; use platform, device and app`);
  }
  return { ...target.capabilities, platformName: target.platform === 'ios' ? 'iOS' : 'Android',
    'appium:automationName': target.platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
    'appium:udid': target.device, 'appium:noReset': true, 'appium:fullReset': false,
    'appium:autoLaunch': true,
    ...(target.platform === 'ios' ? { 'appium:bundleId': target.app, 'appium:shouldTerminateApp': false,
      // Element lookups return what revalidation checks (AppiumAdapter.resolve), so no tree read is needed.
      'appium:shouldUseCompactResponses': false, 'appium:elementResponseAttributes': IOS_FOUND_ATTRIBUTES } :
      { 'appium:appPackage': target.app, 'appium:dontStopAppOnReset': true, 'appium:forceAppLaunch': false }),
  };
}

const CHANGED = 'Mobile UI changed after targeting; inspect the screen and retry';
const IOS_FOUND_ATTRIBUTES = 'type,enabled,rect,attribute/name,attribute/label,attribute/visible';
type FoundElement = { 'element-6066-11e4-a52e-4f735466cecf'?: string; type?: string; enabled?: boolean;
  rect?: { width: number; height: number }; 'attribute/name'?: string | null; 'attribute/label'?: string | null; 'attribute/visible'?: boolean };
/** The picked element is covered or off screen: MobileSession targets it again from an exact capture. */
export class HiddenTargetError extends Error {
  constructor() { super('Mobile control is not visible (covered or off screen)'); this.name = 'HiddenTargetError'; }
}

export class AppiumAdapter implements MobileAdapter<MobileElement> {
  private driver?: MobileDriver;
  private target?: MobileTarget;
  private generation = 0;
  private idleTimeout?: number; // the session's UiAutomator2 waitForIdleTimeout, restored after each early capture
  private exactNext = false; // a fast pick was hidden: the next targeting capture is exact
  /** `fastTargets`: iOS target captures skip XCUITest's `visible` attribute (see capture()). Spec runs only. */
  constructor(private server = 'http://127.0.0.1:4723', private timeout = 15000,
    private connect: ConnectMobile = async options => (await import('webdriverio')).remote(options), private fastTargets = false) {}
  private current(): MobileDriver {
    if (!this.driver) throw new Error('call open first');
    return this.driver;
  }
  async open(raw: MobileTarget) {
    const target = MobileTargetSchema.parse(raw);
    const capabilities = mobileCapabilities(target);
    const url = new URL(this.server);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Appium server must be an HTTP(S) URL without credentials, query or fragment');
    await this.close();
    try {
      this.driver = await this.connect({ protocol: url.protocol === 'https:' ? 'https' : 'http', hostname: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), path: url.pathname,
        capabilities, logLevel: 'silent', connectionRetryCount: 0, connectionRetryTimeout: this.timeout });
      this.target = target;
      await this.driver.activateApp(target.app);
      return target;
    } catch (error) {
      try { await this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Mobile open and session cleanup failed'); }
      throw new Error(`Cannot open mobile session. Start Appium with the ${target.platform === 'ios' ? 'xcuitest' : 'uiautomator2'} driver, check device ${target.device} and installed app ${target.app}. ${error}`);
    }
  }
  private checkHandle(element: MobileElement, roots: ReturnType<typeof parseMobileTree>['roots']) {
    const node = findMobileNode(roots, element.path);
    if (element.generation !== this.generation || !node || nodeIdentity(node) !== element.identity)
      throw new Error(CHANGED);
    return node;
  }
  /**
   * With `fastTargets`, an iOS capture for picking a target (every kind but region, whole screen) reads the
   * source without XCUITest's `visible` attribute, most of its cost (Calendar: 1,050-2,450 ms with it,
   * 150-460 ms without), and judges visibility by bounds (parseMobileTree). That view also shows covered
   * elements, so resolve() confirms the pick's own `visible` before acting (free in the lookup's response),
   * and a hidden pick is targeted again from an exact capture. Claims and regions always see the exact tree,
   * read without `accessible` (only click candidates use it; ~250 ms less on a 340-node Calendar sheet).
   */
  async capture(kind: MobileKind, within?: MobileElement) {
    const driver = this.current();
    const ios = this.target!.platform === 'ios';
    const fast = this.fastTargets && ios && kind !== 'region' && !within;
    if (fast && !this.exactNext) return this.frame(await this.iosSource(driver, 'visible'), kind, undefined, true);
    if (fast) this.exactNext = false;
    return this.frame(ios && kind === 'region' ? await this.iosSource(driver, 'accessible') : await driver.getPageSource(), kind, within);
  }
  private async iosSource(driver: MobileDriver, excludedAttributes: 'visible' | 'accessible') {
    return String(await driver.executeScript('mobile: source', [{ format: 'xml', excludedAttributes }]));
  }
  private frame(source: string, kind: MobileKind, within?: MobileElement, boundsVisibility = false) {
    const tree = parseMobileTree(source, { boundsVisibility });
    const roots = within ? [this.checkHandle(within, tree.roots)] : tree.roots;
    return mobileFrame(roots, kind, { url: `mobile://${this.target!.platform}/${encodeURIComponent(this.target!.app)}`, title: this.target!.app }, this.generation, tree.truncated);
  }
  /**
   * Android only: the tree without UiAutomator's idle wait. After an action, getPageSource waits for
   * ~500 ms of accessibility-event quiet (measured 480-600 ms on an emulator, versus 12-110 ms without),
   * so MobileSession sends this quick tree to Jev while capture() waits, and keeps the answer only if
   * the settled tree is the same. null on iOS: XCUITest already waits for quiescence inside the action,
   * and a quick read there was no faster and never different (measured), so it would only cost calls.
   */
  async captureEarly(kind: MobileKind, within?: MobileElement) {
    if (this.target?.platform !== 'android') return null;
    const driver = this.current();
    this.idleTimeout ??= Number((await driver.getSettings())?.waitForIdleTimeout) || 10000;
    await driver.updateSettings({ waitForIdleTimeout: 0 });
    let source: string;
    try { source = await driver.getPageSource(); }
    finally { await driver.updateSettings({ waitForIdleTimeout: this.idleTimeout }); }
    return this.frame(source, kind, within);
  }
  /**
   * Finds the target again and checks it is still the element Jev picked (same path, type and names),
   * visible and enabled. On iOS a tree read costs 1-2.5 s (see capture()), so the lookup's own response
   * carries type, names, enabled, size and `visible` (IOS_FOUND_ATTRIBUTES, ~270 ms in all). That is the
   * whole check when the element names itself; one named only by its children is also compared against a
   * source read without `visible`. Android reads the tree as before.
   */
  private async resolve(element: MobileElement) {
    const driver = this.current();
    const [role, name, , ownName, label] = JSON.parse(element.identity) as string[];
    const found = async () => {
      // WebdriverIO returns a missing element as an error object, not a rejection.
      const ref = await driver.findElement('xpath', element.path) as FoundElement & { error?: string };
      const id = ref['element-6066-11e4-a52e-4f735466cecf'];
      if (!id) throw new Error(ref.error === 'no such element' ? CHANGED : 'Appium returned no element handle');
      return { id, ref };
    };
    if (this.target!.platform === 'ios') {
      if (element.generation !== this.generation) throw new Error(CHANGED);
      const { id, ref } = await found();
      if (ref.type === undefined) { // a server that ignores elementResponseAttributes: the tree, with size for visibility
        const node = this.checkHandle(element, parseMobileTree(await this.iosSource(driver, 'visible')).roots);
        if (!node.enabled || !(Number(node.attrs.width ?? 1) > 0 && Number(node.attrs.height ?? 1) > 0)) throw new Error('Mobile control is no longer visible/enabled');
        return { id, role: node.role };
      }
      if (name !== '' && name === (label || ownName)) {
        if (ref.type !== role || (ref['attribute/name'] ?? '') !== ownName || (ref['attribute/label'] ?? '') !== label) throw new Error(CHANGED);
      } else this.checkHandle(element, parseMobileTree(await this.iosSource(driver, 'visible')).roots);
      if (ref['attribute/visible'] === false) { this.exactNext = true; throw new HiddenTargetError(); }
      if (!ref.enabled || !(ref.rect && ref.rect.width > 0 && ref.rect.height > 0)) throw new Error('Mobile control is no longer visible/enabled');
      return { id, role };
    }
    const node = this.checkHandle(element, parseMobileTree(await driver.getPageSource()).roots);
    if (!node.visible || !node.enabled) throw new Error('Mobile control is no longer visible/enabled');
    return { id: (await found()).id, role: node.role };
  }
  async act(kind: MobileAction, element: MobileElement, value?: string) {
    const driver = this.current(), { id, role } = await this.resolve(element);
    if (kind === 'fill') {
      // XCUITest sets picker wheels through the value endpoint; they cannot be cleared
      // as text fields. Use the role from the freshly validated native snapshot.
      if (!(this.target!.platform === 'ios' && role === 'XCUIElementTypePickerWheel')) await driver.elementClear(id);
      await driver.elementSendKeys(id, value ?? '');
    }
    else if (kind === 'check' || kind === 'uncheck') {
      const value = await driver.getElementAttribute(id, this.target!.platform === 'ios' ? 'value' : 'checked');
      if (!['true', 'false', '1', '0'].includes(String(value))) throw new Error('Control does not expose a boolean checked state');
      if (['true', '1'].includes(String(value)) !== (kind === 'check')) await driver.elementClick(id);
    } else if (kind === 'longpress' || kind === 'dblclick') {
      const ios = this.target!.platform === 'ios';
      const command = kind === 'longpress' ? (ios ? 'touchAndHold' : 'longClickGesture') : (ios ? 'doubleTap' : 'doubleClickGesture');
      await driver.executeScript(`mobile: ${command}`, [{ elementId: id, ...(kind === 'longpress' ? { duration: ios ? 1 : 1000 } : {}) }]);
    } else await driver.elementClick(id);
  }
  async gesture(kind: 'swipe' | 'scroll', direction: Direction, element?: MobileElement) {
    const driver = this.current();
    const elementId = element ? (await this.resolve(element)).id : undefined;
    if (this.target!.platform === 'ios') {
      await driver.executeScript(`mobile: ${kind}`, [{ direction, ...(elementId ? { elementId } : {}) }]);
    } else {
      const rect = elementId ? undefined : await driver.getWindowRect();
      const area = elementId ? { elementId } : { left: rect!.x + Math.round(rect!.width * .1), top: rect!.y + Math.round(rect!.height * .1),
        width: Math.round(rect!.width * .8), height: Math.round(rect!.height * .8) };
      await driver.executeScript(`mobile: ${kind}Gesture`, [{ ...area, direction, percent: .75 }]);
    }
  }
  async press(key: string) {
    const driver = this.current();
    if (key === 'HideKeyboard') { await driver.hideKeyboard(); return; }
    if (this.target!.platform === 'ios') {
      if (key !== 'Home') throw new Error(`${key} is unsupported on iOS; tap the visible navigation/keyboard control`);
      await driver.executeScript('mobile: pressButton', [{ name: 'home' }]);
    } else {
      const code = { Back: 4, Home: 3, Enter: 66 }[key];
      if (code === undefined) throw new Error(`Unsupported mobile key ${key}`);
      await driver.pressKeyCode(code);
    }
  }
  async screenshot() { return Buffer.from(await this.current().takeScreenshot(), 'base64'); }
  async close() {
    const driver = this.driver;
    this.driver = undefined; this.target = undefined; this.idleTimeout = undefined; this.generation++;
    if (driver) await driver.deleteSession();
  }
}
