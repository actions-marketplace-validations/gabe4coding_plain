import type { Browser } from 'webdriverio';
import type { CaptureOptions, NativeAdapter } from '../native/session.js';
import { HiddenTargetError } from '../core/automation.js';
import { MobileTargetSchema, type MobileTarget, type Direction } from './spec.js';
import { parseMobileTree, findMobileNode, nodeIdentity, parseIdentity, mobileFrame, type MobileElement, type MobileKind, type MobileNode } from './tree.js';

export type MobileAction = 'click' | 'tap' | 'fill' | 'dblclick' | 'longpress' | 'check' | 'uncheck';

export interface MobileAdapter<T = unknown> extends NativeAdapter<T, MobileKind> {
  open(target: MobileTarget): Promise<MobileTarget>;
  act(kind: MobileAction, element: T, value?: string): Promise<void>;
  gesture(kind: 'swipe' | 'scroll', direction: Direction, element?: T): Promise<void>;
}

type DriverCommands = 'getPageSource' | 'findElement' | 'elementClick' | 'elementClear' | 'elementSendKeys' |
  'getElementAttribute' | 'executeScript' | 'getWindowRect' | 'pressKeyCode' | 'hideKeyboard' | 'takeScreenshot' | 'deleteSession' |
  'activateApp' | 'getSettings' | 'updateSettings';
export type MobileDriver = { [K in DriverCommands]: OmitThisParameter<Browser[K]> };
export type ConnectMobile = (options: Parameters<typeof import('webdriverio').remote>[0]) => Promise<MobileDriver>;

/** Plainwright owns the session lifecycle: extra capabilities may only configure signing and device details. */
const RESERVED_CAPABILITIES = new Set(['platformName', 'browserName', 'appium:automationName', 'appium:udid', 'appium:app',
  'appium:bundleId', 'appium:appPackage', 'appium:noReset', 'appium:fullReset', 'appium:autoLaunch', 'appium:dontStopAppOnReset',
  'appium:forceAppLaunch', 'appium:shouldTerminateApp', 'appium:autoWebview']);

/** What an iOS element lookup returns, so revalidation needs no tree read (AppiumAdapter.resolve). */
const IOS_FOUND_ATTRIBUTES = 'type,enabled,rect,attribute/name,attribute/label,attribute/visible';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const CHANGED = 'Mobile UI changed after targeting; inspect the screen and retry';
const NOT_ACTIONABLE = 'Mobile control is no longer visible/enabled';
const ANDROID_KEY_CODES: Record<string, number> = { Back: 4, Home: 3, Enter: 66 };
const DEFAULT_IDLE_TIMEOUT_MS = 10000;
/** iOS controls that bring up the keyboard when tapped. */
const IOS_TEXT_ENTRY = /^XCUIElementType(TextField|SecureTextField|TextView|SearchField)$/;
/** The longest wait for the iOS keyboard to come on screen after typing or tapping a text control. */
const KEYBOARD_MS = 3000;
const KEYBOARD_POLL_MS = 100;
export const DEFAULT_APPIUM_URL = 'http://127.0.0.1:4723';

export function mobileCapabilities(target: MobileTarget): Record<string, unknown> & { platformName: string } {
  for (const key of Object.keys(target.capabilities ?? {})) {
    if (RESERVED_CAPABILITIES.has(key) || !key.includes(':') || key === 'appium:options') {
      throw new Error(`Capability ${key} is managed by Plainwright or unsupported; use platform, device and app`);
    }
  }
  const ios = target.platform === 'ios';
  const platformCapabilities = ios
    ? { 'appium:bundleId': target.app, 'appium:shouldTerminateApp': false,
      'appium:shouldUseCompactResponses': false, 'appium:elementResponseAttributes': IOS_FOUND_ATTRIBUTES }
    : { 'appium:appPackage': target.app, 'appium:dontStopAppOnReset': true, 'appium:forceAppLaunch': false };
  return {
    ...target.capabilities,
    platformName: ios ? 'iOS' : 'Android',
    'appium:automationName': ios ? 'XCUITest' : 'UiAutomator2',
    'appium:udid': target.device,
    'appium:noReset': true,
    'appium:fullReset': false,
    'appium:autoLaunch': true,
    ...platformCapabilities,
  };
}

type FoundElement = {
  [ELEMENT_KEY]?: string;
  type?: string;
  enabled?: boolean;
  rect?: { width: number; height: number };
  'attribute/name'?: string | null;
  'attribute/label'?: string | null;
  'attribute/visible'?: boolean | string;
};

/** A lookup's `attribute/visible` is a boolean or "true"/"false"; anything else is unknown. */
function reportedVisible(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

const showsAnything = (node: MobileNode): boolean => node.visible || node.children.some(showsAnything);

type ExcludedAttributes = 'visible' | 'accessible' | 'visible,accessible';

/** A device through Appium (XCUITest or UiAutomator2), driven with WebdriverIO, imported on first use. */
export class AppiumAdapter implements MobileAdapter<MobileElement> {
  private driver?: MobileDriver;
  private target?: MobileTarget;
  /** Bumped on close: a handle from an earlier session never acts. */
  private generation = 0;
  /** The session's UiAutomator2 waitForIdleTimeout, restored after each early capture. */
  private idleTimeout?: number;
  /** A fast pick was hidden: the next target capture is exact. */
  private exactNext = false;

  /** `fastTargets`: iOS target captures skip XCUITest's `visible` attribute (see capture()). */
  constructor(private server = DEFAULT_APPIUM_URL, private timeout = 15000,
    private connect: ConnectMobile = async (options) => (await import('webdriverio')).remote(options), private fastTargets = false) {}

  private connectedDriver(): MobileDriver {
    if (!this.driver) throw new Error('call open first');
    return this.driver;
  }

  private get ios() { return this.target!.platform === 'ios'; }

  async open(raw: MobileTarget) {
    const target = MobileTargetSchema.parse(raw);
    const capabilities = mobileCapabilities(target);
    const url = new URL(this.server);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Appium server must be an HTTP(S) URL without credentials, query or fragment');
    }
    await this.close();
    try {
      const https = url.protocol === 'https:';
      this.driver = await this.connect({
        protocol: https ? 'https' : 'http',
        hostname: url.hostname,
        port: Number(url.port || (https ? 443 : 80)),
        path: url.pathname,
        capabilities,
        logLevel: 'silent',
        connectionRetryCount: 0,
        connectionRetryTimeout: this.timeout,
      });
      this.target = target;
      await this.driver.activateApp(target.app);
      return target;
    } catch (error) {
      try {
        await this.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Mobile open and session cleanup failed');
      }
      const driverName = target.platform === 'ios' ? 'xcuitest' : 'uiautomator2';
      throw new Error(`Cannot open mobile session. Start Appium with the ${driverName} driver, check device ${target.device} and installed app ${target.app}. ${error}`);
    }
  }

  /**
   * With `fastTargets`, an iOS capture for picking a target (any kind but region, whole screen) reads the source
   * without XCUITest's `visible` attribute, most of its cost, and judges visibility by bounds. That view also
   * shows covered elements, so resolve() confirms the pick's own `visible` before acting, and a hidden pick is
   * targeted again from an exact capture. Claims and regions always see the exact tree, read without
   * `accessible`, which only click candidates use. A spatial capture is exact: covered elements would be
   * measured as visible references.
   */
  async capture(kind: MobileKind, within?: MobileElement, { regionPick = false, spatial = false }: CaptureOptions = {}) {
    const driver = this.connectedDriver();
    const fast = this.fastTargets && this.ios && (kind !== 'region' || regionPick) && !within && !spatial;
    if (fast && !this.exactNext) {
      const source = await this.iosSource(driver, kind === 'click' ? 'visible' : 'visible,accessible');
      return this.frame(source, kind, undefined, true);
    }
    if (fast) this.exactNext = false;
    const source = this.ios && kind === 'region' ? await this.iosSource(driver, 'accessible') : await driver.getPageSource();
    return this.frame(source, kind, within, false, spatial);
  }

  preferExact() { this.exactNext = true; }

  get approximateTargets() { return this.fastTargets && this.target?.platform === 'ios'; }

  /**
   * Android only: the tree without UiAutomator's wait for an idle UI, which costs about half a second after an
   * action. Jev works on it while capture() waits, and the answer is kept only if the settled tree is the same.
   * Null on iOS: XCUITest already waits inside the action, and a quick read there was never faster.
   */
  async captureEarly(kind: MobileKind, within?: MobileElement, { spatial = false }: CaptureOptions = {}) {
    if (this.target?.platform !== 'android') return null;
    const driver = this.connectedDriver();
    this.idleTimeout ??= Number((await driver.getSettings())?.waitForIdleTimeout) || DEFAULT_IDLE_TIMEOUT_MS;
    await driver.updateSettings({ waitForIdleTimeout: 0 });
    let source: string;
    try {
      source = await driver.getPageSource();
    } finally {
      await driver.updateSettings({ waitForIdleTimeout: this.idleTimeout });
    }
    return this.frame(source, kind, within, false, spatial);
  }

  private async iosSource(driver: MobileDriver, excludedAttributes: ExcludedAttributes) {
    return String(await driver.executeScript('mobile: source', [{ format: 'xml', excludedAttributes }]));
  }

  /** Appium reports iOS frames in points and Android bounds in pixels. */
  private get coordinates() { return this.ios ? 'iOS screen points' : 'Android screen pixels'; }

  private frame(source: string, kind: MobileKind, within?: MobileElement, boundsVisibility = false, spatial = false) {
    const tree = parseMobileTree(source, { boundsVisibility });
    const roots = within ? [this.checkHandle(within, tree.roots)] : tree.roots;
    // A region picked from an approximate capture must show something in the exact tree. Not its own flag:
    // XCUITest often marks containers invisible while the controls inside them are visible.
    if (within?.approximate && !showsAnything(roots[0])) {
      this.exactNext = true;
      throw new HiddenTargetError('Region');
    }
    const state = { url: `mobile://${this.target!.platform}/${encodeURIComponent(this.target!.app)}`, title: this.target!.app };
    // An approximate region pick lists containers only: covered views would double the nodes past one Jev request.
    const frame = mobileFrame(roots, kind, state, this.generation, tree.truncated,
      { containersOnly: boundsVisibility && kind === 'region', ...(spatial ? { coordinates: this.coordinates } : {}) });
    if (!boundsVisibility) return frame;
    const elements = new Map([...frame.elements].map(([id, element]) => [id, { ...element, approximate: true }]));
    return { ...frame, elements, approximate: true };
  }

  private checkHandle(element: MobileElement, roots: MobileNode[]) {
    const node = findMobileNode(roots, element.path);
    if (element.generation !== this.generation || !node || nodeIdentity(node) !== element.identity) throw new Error(CHANGED);
    return node;
  }

  /**
   * Finds the target again and checks it is still the element Jev picked (same path, type and names), visible
   * and enabled. On iOS a tree read is slow, so the lookup's own response carries type, names, enabled, size and
   * `visible`: the whole check when the element names itself; one named only by its children is also compared
   * against a source read. Android reads the tree.
   */
  private async resolve(element: MobileElement): Promise<{ id: string; role: string }> {
    return this.ios ? this.resolveIos(element) : this.resolveAndroid(element);
  }

  private async lookUp(element: MobileElement) {
    const driver = this.connectedDriver();
    // WebdriverIO returns a missing element as an error object, not a rejection.
    const found = await (element.chain
      ? driver.findElement('-ios class chain', element.chain)
      : driver.findElement('xpath', element.path)) as FoundElement & { error?: string };
    const id = found[ELEMENT_KEY];
    if (!id) throw new Error(found.error === 'no such element' ? CHANGED : 'Appium returned no element handle');
    return { id, found };
  }

  private async resolveAndroid(element: MobileElement) {
    const node = this.checkHandle(element, parseMobileTree(await this.connectedDriver().getPageSource()).roots);
    if (!node.visible || !node.enabled) throw new Error(NOT_ACTIONABLE);
    return { id: (await this.lookUp(element)).id, role: node.role };
  }

  private async resolveIos(element: MobileElement) {
    const driver = this.connectedDriver();
    const { role, name, nativeName, label } = parseIdentity(element.identity);
    if (element.generation !== this.generation) throw new Error(CHANGED);
    const { id, found } = await this.lookUp(element);
    if (found.type === undefined) {
      // A server that ignores elementResponseAttributes. Size is not visibility: use the tree node's own `visible`;
      // a missing flag is not visible, so the next target capture is exact.
      const node = this.checkHandle(element, parseMobileTree(await this.iosSource(driver, 'accessible')).roots);
      if (node.attrs.visible === undefined || !node.visible) {
        this.exactNext = true;
        throw new HiddenTargetError();
      }
      if (!node.enabled) throw new Error(NOT_ACTIONABLE);
      return { id, role: node.role };
    }
    const namesItself = name !== '' && name === (label || nativeName);
    if (namesItself) {
      if (found.type !== role || (found['attribute/name'] ?? '') !== nativeName || (found['attribute/label'] ?? '') !== label) throw new Error(CHANGED);
    } else {
      this.checkHandle(element, parseMobileTree(await this.iosSource(driver, 'visible,accessible')).roots);
    }
    // "false" is covered. A missing flag does not confirm a pick from an approximate capture; an exact capture
    // already showed the element.
    const visible = reportedVisible(found['attribute/visible']);
    if (visible === false || (visible === undefined && element.approximate)) {
      this.exactNext = true;
      throw new HiddenTargetError();
    }
    if (!found.enabled || !(found.rect && found.rect.width > 0 && found.rect.height > 0)) throw new Error(NOT_ACTIONABLE);
    return { id, role };
  }

  async act(kind: MobileAction, element: MobileElement, value?: string) {
    const driver = this.connectedDriver();
    const { id, role } = await this.resolve(element);
    if (kind === 'fill') {
      // XCUITest sets picker wheels through the value endpoint: they cannot be cleared like text fields.
      if (!(this.ios && role === 'XCUIElementTypePickerWheel')) await driver.elementClear(id);
      await driver.elementSendKeys(id, value ?? '');
      if (this.ios) await this.keyboardShown();
    } else if (kind === 'check' || kind === 'uncheck') {
      const state = String(await driver.getElementAttribute(id, this.ios ? 'value' : 'checked'));
      if (!['true', 'false', '1', '0'].includes(state)) throw new Error('Control does not expose a boolean checked state');
      if (['true', '1'].includes(state) !== (kind === 'check')) await driver.elementClick(id);
    } else if (kind === 'longpress') {
      await driver.executeScript(`mobile: ${this.ios ? 'touchAndHold' : 'longClickGesture'}`, [{ elementId: id, duration: this.ios ? 1 : 1000 }]);
    } else if (kind === 'dblclick') {
      await driver.executeScript(`mobile: ${this.ios ? 'doubleTap' : 'doubleClickGesture'}`, [{ elementId: id }]);
    } else {
      await driver.elementClick(id);
      if (this.ios && IOS_TEXT_ENTRY.test(role)) await this.keyboardShown();
    }
  }

  /**
   * iOS 27 keeps the keyboard below the screen, `visible="false"`, for up to about 1.5 s after typing or a tap on a
   * text control has returned, and XCUITest does not wait for it. A capture in that time shows no keys, so the next
   * step could not target the keyboard (its return key, for example). This waits until the keyboard is visible or
   * absent (a hardware keyboard, a picker), at most KEYBOARD_MS. One lookup when there is nothing to wait for.
   */
  private async keyboardShown() {
    const driver = this.connectedDriver();
    const deadline = Date.now() + Math.min(KEYBOARD_MS, this.timeout);
    for (;;) {
      // The action already happened: a failed lookup ends the wait, and the next step meets the error if it lasts.
      const found = await driver.findElement('-ios class chain', '**/XCUIElementTypeKeyboard')
        .catch(() => ({})) as FoundElement & { error?: string };
      if (!found[ELEMENT_KEY] || reportedVisible(found['attribute/visible']) !== false || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, KEYBOARD_POLL_MS));
    }
  }

  async gesture(kind: 'swipe' | 'scroll', direction: Direction, element?: MobileElement) {
    const driver = this.connectedDriver();
    const elementId = element ? (await this.resolve(element)).id : undefined;
    if (this.ios) {
      await driver.executeScript(`mobile: ${kind}`, [{ direction, ...(elementId ? { elementId } : {}) }]);
      return;
    }
    let area: Record<string, unknown>;
    if (elementId) {
      area = { elementId };
    } else {
      // The middle 80% of the window.
      const rect = await driver.getWindowRect();
      area = { left: rect.x + Math.round(rect.width * .1), top: rect.y + Math.round(rect.height * .1),
        width: Math.round(rect.width * .8), height: Math.round(rect.height * .8) };
    }
    await driver.executeScript(`mobile: ${kind}Gesture`, [{ ...area, direction, percent: .75 }]);
  }

  async press(key: string) {
    const driver = this.connectedDriver();
    if (key === 'HideKeyboard') {
      await driver.hideKeyboard();
      return;
    }
    if (this.ios) {
      if (key !== 'Home') throw new Error(`${key} is unsupported on iOS; tap the visible navigation/keyboard control`);
      await driver.executeScript('mobile: pressButton', [{ name: 'home' }]);
      return;
    }
    const code = ANDROID_KEY_CODES[key];
    if (code === undefined) throw new Error(`Unsupported mobile key ${key}`);
    await driver.pressKeyCode(code);
  }

  async screenshot() {
    return Buffer.from(await this.connectedDriver().takeScreenshot(), 'base64');
  }

  async close() {
    const driver = this.driver;
    this.driver = undefined;
    this.target = undefined;
    this.idleTimeout = undefined;
    this.generation++;
    if (driver) await driver.deleteSession();
  }
}
