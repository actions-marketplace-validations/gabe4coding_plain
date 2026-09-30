import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AppiumAdapter, mobileCapabilities } from './mobile-adapter.js';
import { parseMobileTree, mobileFrame, findMobileNode, type MobileElement, type MobileKind } from './mobile-tree.js';

const android = `<?xml version="1.0"?><hierarchy rotation="0"><android.widget.FrameLayout enabled="true">
  <android.view.ViewGroup clickable="true" enabled="true"><android.widget.TextView text="Sign in &amp; continue" enabled="true"/></android.view.ViewGroup>
  <android.widget.EditText content-desc="Email" text="" enabled="true"/>
  <android.widget.Switch content-desc="Preview" checkable="true" checked="false" enabled="true"/>
  <android.widget.ScrollView content-desc="Results" scrollable="true" enabled="true"><android.widget.TextView text="First result"/></android.widget.ScrollView>
  <android.widget.Button text="Disabled" enabled="false"/>
  <android.widget.Button text="Hidden" displayed="false"/>
</android.widget.FrameLayout></hierarchy>`;
const ios = `<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Fixture" enabled="true" visible="true">
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Sign in &amp; continue" name="sign-in" enabled="true" visible="true"/>
  <XCUIElementTypeTextField type="XCUIElementTypeTextField" label="Email" value="" enabled="true" visible="true"/>
  <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" label="Preview" value="0" enabled="true" visible="true"/>
  <XCUIElementTypeScrollView type="XCUIElementTypeScrollView" label="Results" enabled="true" visible="true"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="First result" visible="true"/></XCUIElementTypeScrollView>
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Disabled" enabled="false" visible="true"/>
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Hidden" enabled="true" visible="false"/>
  <XCUIElementTypePickerWheel type="XCUIElementTypePickerWheel" value="11 o’clock" enabled="true" visible="true"/>
</XCUIElementTypeApplication></AppiumAUT>`;

for (const [platform, xml] of [['android', android], ['ios', ios]] as const) {
  test(`${platform} source preserves paths, decoded labels, grouping and actionable filters`, () => {
    const tree = parseMobileTree(xml);
    const frame = mobileFrame(tree.roots, 'click', { url: 'mobile://fixture', title: 'Fixture' }, 1);
    assert.match(frame.snapshot.aria, /Sign in & continue/);
    assert.ok(frame.candidates.some(c => c.desc.includes('Sign in & continue')));
    assert.ok(!frame.candidates.some(c => /Disabled|Hidden/.test(c.desc.split(' in ')[0])));
    const inputs = mobileFrame(tree.roots, 'fill', frame.snapshot, 1);
    assert.equal(inputs.candidates.length, platform === 'ios' ? 2 : 1);
    assert.equal(inputs.elements.get(0)?.path, platform === 'ios' ? '/*[1]/*[2]' : '/*[1]/*[1]/*[2]');
    assert.equal(mobileFrame(tree.roots, 'check', frame.snapshot, 1).candidates.length, 1);
    assert.equal(mobileFrame(tree.roots, 'scroll', frame.snapshot, 1).candidates.length, 1);
  });
}
test('source rejects malformed XML and entities; caps candidates and reports truncation', () => {
  assert.throws(() => parseMobileTree('<hierarchy>'), /invalid XML/);
  assert.throws(() => parseMobileTree('<!DOCTYPE foo><foo/>'), /DTD/);
  const tree = parseMobileTree(`<hierarchy>${'<android.widget.Button text="Row"/>'.repeat(1100)}</hierarchy>`);
  const frame = mobileFrame(tree.roots, 'click', { url: '', title: '' }, 1);
  assert.equal(frame.candidates.length, 1016);
  assert.equal(frame.snapshot.truncated, true);
});
test('password text does not leak through inherited container names', () => {
  for (const source of [
    '<hierarchy><android.view.ViewGroup clickable="true"><android.widget.EditText password="true" content-desc="Password" text="sensitive-value"/></android.view.ViewGroup></hierarchy>',
    '<AppiumAUT><XCUIElementTypeOther accessible="true"><XCUIElementTypeSecureTextField label="Password" value="sensitive-value"/></XCUIElementTypeOther></AppiumAUT>',
  ]) {
    const tree = parseMobileTree(source);
    const frame = mobileFrame(tree.roots, 'click', { url: '', title: '' }, 1);
    assert.doesNotMatch(JSON.stringify({ snapshot: frame.snapshot, candidates: frame.candidates }), /sensitive-value/);
  }
});
test('Android input values are preserved alongside accessibility labels without marking labels unchecked', () => {
  const tree = parseMobileTree('<hierarchy><android.widget.EditText content-desc="Message" text="hello" checked="false"/><android.widget.TextView text="Title" checked="false"/></hierarchy>');
  const frame = mobileFrame(tree.roots, 'fill', { url: '', title: '' }, 1);
  assert.match(frame.snapshot.aria, /android.widget.EditText "Message" value="hello"/);
  assert.doesNotMatch(frame.snapshot.aria, /checked=false/);
});
test('iOS visible controls survive invisible layout ancestors without exposing hidden controls', () => {
  const tree = parseMobileTree(`<AppiumAUT><XCUIElementTypeApplication visible="true">
    <XCUIElementTypeOther visible="false" label="Hidden layout">
      <XCUIElementTypeOther visible="false">
        <XCUIElementTypeTextField name="title-field" value="Title" visible="true" enabled="true"/>
        <XCUIElementTypeButton label="Choose date" visible="true" enabled="true"/>
        <XCUIElementTypeButton label="Behind the dialog" visible="false" enabled="true"/>
        <XCUIElementTypeTextField label="No explicit visibility"/>
      </XCUIElementTypeOther>
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication></AppiumAUT>`);
  const frame = mobileFrame(tree.roots, 'fill', { url: '', title: '' }, 1);
  assert.equal(frame.candidates.length, 1);
  assert.equal(frame.elements.get(0)?.path, '/*[1]/*[1]/*[1]/*[1]');
  assert.match(frame.snapshot.aria, /title-field.*value="Title"/);
  assert.match(frame.snapshot.aria, /Choose date/);
  assert.doesNotMatch(frame.snapshot.aria, /Hidden layout|Behind the dialog|No explicit visibility/);
  const clicks = mobileFrame(tree.roots, 'click', frame.snapshot, 1);
  assert.equal(clicks.candidates.length, 2);
});
test('Android visibility stays inherited even when a descendant reports displayed=true', () => {
  const tree = parseMobileTree('<hierarchy><android.view.ViewGroup displayed="false"><android.widget.EditText content-desc="Hidden input" displayed="true"/><android.widget.Button text="Hidden button" visible="true"/></android.view.ViewGroup></hierarchy>');
  const frame = mobileFrame(tree.roots, 'click', { url: '', title: '' }, 1);
  assert.equal(frame.candidates.length, 0);
  assert.doesNotMatch(frame.snapshot.aria, /Hidden input|Hidden button/);
});
test('mobile session capabilities pin platform, device, native context and preserve app data', () => {
  const target = { platform: 'ios' as const, device: 'udid', app: 'com.example.fixture' };
  assert.equal(mobileCapabilities(target)['appium:noReset'], true);
  for (const key of ['platformName', 'appium:udid', 'appium:fullReset', 'appium:options', 'appium:autoWebview', 'appium:app'])
    assert.throws(() => mobileCapabilities({ ...target, capabilities: { [key]: true } }), /managed/);
  assert.equal(mobileCapabilities({ ...target, capabilities: { 'appium:xcodeOrgId': 'TEAM' } })['appium:xcodeOrgId'], 'TEAM');
});

// Exercise the actual WebdriverIO transport against a local W3C/Appium server. No device or model key.
for (const platform of ['android', 'ios'] as const) {
  test(`${platform} Appium transport: actions, state, gestures, stale targets, and cleanup`, async () => {
    const requests: { method: string; path: string; body: Record<string, any> }[] = [];
    let source = platform === 'ios' ? ios : android;
    let checked = false;
    const server = createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const path = req.url!; requests.push({ method: req.method!, path, body });
      let value: unknown = null;
      if (path === '/wd/hub/session' && req.method === 'POST') value = { sessionId: 'fixture', capabilities: {
        platformName: platform === 'ios' ? 'iOS' : 'Android', 'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
      } };
      else if (path.endsWith('/source')) value = source;
      // iOS revalidates targets with a source read that leaves out the costly `visible` attribute.
      else if (path.endsWith('/execute/sync') && body.script === 'mobile: source') {
        assert.equal(platform, 'ios'); assert.equal(body.args[0].excludedAttributes, 'visible');
        value = source.replaceAll(/ visible="[^"]*"/g, '');
      }
      else if (path.endsWith('/element') && req.method === 'POST') {
        value = { 'element-6066-11e4-a52e-4f735466cecf': 'control' };
        // XCUITest answers with the attributes the session asked for (elementResponseAttributes).
        const node = platform === 'ios' ? findMobileNode(parseMobileTree(source).roots, body.value) : undefined;
        if (node) value = { ...value as object, type: node.role, enabled: node.enabled, rect: { x: 0, y: 0, width: 10, height: 10 },
          'attribute/name': node.attrs.name ?? null, 'attribute/label': node.attrs.label ?? null };
      }
      else if (/\/attribute\//.test(path)) value = platform === 'ios' ? (checked ? '1' : '0') : String(checked);
      else if (path.endsWith('/click')) checked = !checked;
      else if (path.endsWith('/window/rect')) value = { x: 0, y: 0, width: 400, height: 800 };
      else if (path.endsWith('/screenshot')) value = Buffer.from('png fixture').toString('base64');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const adapter = new AppiumAdapter(`http://127.0.0.1:${port}/wd/hub`, 1000);
    async function target(kind: MobileKind): Promise<MobileElement> {
      const frame = await adapter.capture(kind); return frame.elements.get(0)!;
    }
    try {
      await adapter.open({ platform, device: 'fixture-device', app: 'com.example.fixture' });
      const caps = requests.find(r => r.path === '/wd/hub/session')!.body.capabilities.alwaysMatch;
      assert.equal(caps['appium:udid'], 'fixture-device');
      assert.equal(caps['appium:noReset'], true);
      assert.equal(caps['appium:automationName'], platform === 'ios' ? 'XCUITest' : 'UiAutomator2');
      assert.ok(requests.some(r => r.path.endsWith('/appium/device/activate_app') && r.body.appId === 'com.example.fixture'));
      const early = await adapter.captureEarly('click');
      const settings = requests.filter(r => r.path.endsWith('/appium/settings'));
      if (platform === 'ios') { assert.equal(early, null); assert.equal(settings.length, 0, 'no quick read on iOS'); }
      else {
        assert.deepEqual(early?.candidates, (await adapter.capture('click')).candidates);
        // Read the session's idle timeout once, switch it off for one source read, then restore it.
        assert.deepEqual(settings.map(r => [r.method, r.body.settings?.waitForIdleTimeout]), [['GET', undefined], ['POST', 0], ['POST', 10000]]);
        const i = requests.findIndex(r => r.method === 'POST' && r.body.settings?.waitForIdleTimeout === 0);
        assert.ok(requests[i + 1].path.endsWith('/source'));
      }
      await adapter.act('fill', await target('fill'), 'hello');
      assert.equal(requests.find(r => r.path.endsWith('/element'))?.body.value,
        platform === 'ios' ? '/*[1]/*[2]' : '/*[1]/*[1]/*[2]');
      assert.ok(requests.some(r => r.path.endsWith('/value') && r.body.text === 'hello'));
      assert.ok(requests.some(r => r.path.endsWith('/clear')));
      const sourceReads = () => requests.filter(r => r.body.script === 'mobile: source').length;
      if (platform === 'ios') {
        // A self-named target is revalidated from the lookup's response alone.
        assert.equal(caps['appium:shouldUseCompactResponses'], false);
        assert.equal(sourceReads(), 0);
        const inputs = await adapter.capture('fill');
        const wheel = inputs.candidates.find(c => c.desc.includes('PickerWheel'))!;
        assert.match(wheel.desc, /11 o’clock/);
        await adapter.act('fill', inputs.elements.get(wheel.id)!, '14');
        assert.equal(requests.filter(r => r.path.endsWith('/clear')).length, 1, 'Picker wheels must not be cleared');
        assert.equal(sourceReads(), 1, 'a target named only by its children is revalidated against the tree');
        assert.equal(requests.filter(r => r.path.endsWith('/value')).at(-1)?.body.text, '14');
      }
      const control = await target('check');
      checked = false;
      await adapter.act('check', control); await adapter.act('check', control); await adapter.act('uncheck', control);
      assert.equal(requests.filter(r => r.path.endsWith('/click')).length, 2);
      await adapter.act('longpress', await target('click'));
      await adapter.act('dblclick', await target('click'));
      await adapter.gesture('scroll', 'down', await target('scroll'));
      await adapter.gesture('swipe', 'left');
      const commands = requests.filter(r => r.path.endsWith('/execute/sync')).map(r => r.body);
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'touchAndHold' : 'longClickGesture'}` && c.args[0].duration === (platform === 'ios' ? 1 : 1000)));
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'doubleTap' : 'doubleClickGesture'}`));
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'scroll' : 'scrollGesture'}` && c.args[0].direction === 'down' && c.args[0].elementId === 'control'));
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'swipe' : 'swipeGesture'}` && c.args[0].direction === 'left'));
      const scoped = await adapter.capture('region', await target('scroll'));
      assert.match(scoped.snapshot.aria, /First result/); assert.doesNotMatch(scoped.snapshot.aria, /Email/);
      assert.equal((await adapter.screenshot()).toString(), 'png fixture');
      await adapter.press('Home');
      if (platform === 'ios') await assert.rejects(adapter.press('Back'), /unsupported on iOS/);
      else { await adapter.press('Back'); assert.ok(requests.some(r => r.body.script === 'mobile: pressKey' && r.body.args[0].keycode === 4)); }
      const stale = await target('click');
      const before = requests.filter(r => r.path.endsWith('/click')).length;
      source = source.replaceAll('Sign in &amp; continue', 'Different control');
      await assert.rejects(adapter.act('tap', stale), /UI changed/);
      assert.equal(requests.filter(r => r.path.endsWith('/click')).length, before);
      await adapter.close();
      await assert.rejects(adapter.capture('region'), /call open first/);
      assert.equal(requests.filter(r => r.method === 'DELETE').length, 1);
      await adapter.open({ platform, device: 'fixture-device', app: 'com.example.fixture' });
      source = platform === 'ios' ? ios : android;
      await assert.rejects(adapter.act('tap', stale), /UI changed/);
    } finally { await adapter.close(); server.close(); server.closeAllConnections(); await once(server, 'close'); }
  });
}
