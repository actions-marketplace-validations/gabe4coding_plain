import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AppListingSchema, LocalMobileDiscovery, parseAdbDevices, parseSimulators, type DiscoveryCommand } from './mobile-discovery.js';

const adb = `List of devices attached
emulator-5554 device product:sdk model:Pixel_7 transport_id:1
phone-serial unauthorized transport_id:2
192.0.2.1:5555 offline
usb-device no permissions (missing udev rules)
`;
const simulators = JSON.stringify({ devices: {
  'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
    { udid: 'booted-id', name: 'Test iPhone', state: 'Booted', isAvailable: true },
    { udid: 'shutdown-id', name: 'Test iPad', state: 'Shutdown', isAvailable: true },
    { udid: 'unavailable-id', name: 'Old iPhone', state: 'Shutdown', isAvailable: false },
  ],
  'com.apple.CoreSimulator.SimRuntime.tvOS-27-0': [
    { udid: 'tv-id', name: 'Apple TV', state: 'Booted', isAvailable: true },
  ],
} });

test('device parsers retain explicit IDs and unready states, exclude unavailable/non-iOS simulators', () => {
  const devices = parseAdbDevices(adb);
  assert.equal(devices[0].name, 'Pixel 7'); assert.equal(devices[0].type, 'emulator');
  assert.deepEqual(devices.map(d => d.ready), [true, false, false, false]);
  assert.equal(devices[2].device, '192.0.2.1:5555');
  assert.deepEqual(parseAdbDevices('List of devices attached\n'), []);
  assert.throws(() => parseAdbDevices('adb failed'), /Unexpected/);
  assert.deepEqual(parseSimulators(simulators).map(d => [d.device, d.ready]), [['booted-id', true], ['shutdown-id', false]]);
  assert.throws(() => parseSimulators('{}'));
});

test('discovery returns useful partial results and setup errors; platform filtering avoids other SDKs', async () => {
  const commands: string[] = [];
  const run: DiscoveryCommand = async (file, args) => {
    commands.push(file);
    if (file === 'xcrun') { assert.deepEqual(args, ['simctl', 'list', 'devices', 'available', '--json']); return simulators; }
    throw new Error('ADB not installed');
  };
  const discovery = new LocalMobileDiscovery(run, {}, 'darwin', '/missing-home');
  const result = await discovery.listDevices();
  assert.equal(result.scope, 'local'); assert.equal(result.devices.length, 2);
  assert.deepEqual(result.errors, [{ platform: 'android', detail: 'ADB not installed' }]);
  commands.length = 0;
  assert.equal((await discovery.listDevices('ios')).errors.length, 0);
  assert.deepEqual(commands, ['xcrun']);
  const linux = await new LocalMobileDiscovery(run, {}, 'linux').listDevices('ios');
  assert.match(linux.errors[0].detail, /macOS and Xcode/);
});

test('Android app discovery resolves SDK, passes exact device arguments, filters, deduplicates and paginates', async () => {
  const calls: string[][] = [];
  const run: DiscoveryCommand = async (file, args) => {
    assert.equal(file, join('/android-sdk', 'platform-tools', 'adb'));
    calls.push(args);
    if (args[0] === 'devices') return adb;
    assert.deepEqual(args, ['-s', 'emulator-5554', 'shell', 'pm', 'list', 'packages', '-3']);
    return 'package:com.example.z\npackage:com.example.a\npackage:com.example.a\npackage:org.other\n';
  };
  const discovery = new LocalMobileDiscovery(run, { ANDROID_HOME: '/android-sdk' }, 'linux');
  const options = AppListingSchema.parse({ platform: 'android', device: 'emulator-5554', query: 'EXAMPLE', include_system: false, limit: 1 });
  const first = await discovery.listApps(options);
  assert.deepEqual(first.apps, [{ app: 'com.example.a' }]);
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  const second = await discovery.listApps({ ...options, offset: first.nextOffset! });
  assert.deepEqual(second.apps, [{ app: 'com.example.z' }]); assert.equal(second.nextOffset, null);
  calls.length = 0;
  await assert.rejects(discovery.listApps({ ...options, device: 'phone-serial' }), /unauthorized/);
  await assert.rejects(discovery.listApps({ ...options, device: 'emulator-5554; echo wrong' }), /not listed/);
  assert.ok(calls.every(args => args[0] === 'devices'), 'Invalid devices must not reach a package command');
});

test('iOS app discovery converts plist, returns only app metadata, filters system apps and rejects shutdown IDs', async () => {
  const calls: string[][] = [];
  const run: DiscoveryCommand = async (file, args, input) => {
    calls.push(args);
    if (args[1] === 'list') return simulators;
    if (args[1] === 'listapps') { assert.deepEqual(args, ['simctl', 'listapps', 'booted-id']); return 'native plist'; }
    assert.equal(file, 'plutil'); assert.equal(input, 'native plist');
    assert.deepEqual(args, ['-convert', 'json', '-o', '-', '-']);
    return JSON.stringify({
      'com.example.fixture': { CFBundleIdentifier: 'com.example.fixture', CFBundleDisplayName: 'Preview Test', ApplicationType: 'User', DataContainer: '/private/data' },
      'com.apple.Preferences': { CFBundleName: 'Settings', ApplicationType: 'System' },
    });
  };
  const discovery = new LocalMobileDiscovery(run, {}, 'darwin');
  const options = AppListingSchema.parse({ platform: 'ios', device: 'booted-id' });
  assert.equal((await discovery.listApps(options)).total, 2);
  const userApps = await discovery.listApps({ ...options, include_system: false });
  assert.deepEqual(userApps.apps, [{ app: 'com.example.fixture', name: 'Preview Test' }]);
  assert.equal((await discovery.listApps({ ...options, query: 'SETTINGS' })).apps[0].app, 'com.apple.Preferences');
  calls.length = 0;
  await assert.rejects(discovery.listApps({ ...options, device: 'shutdown-id' }), /Shutdown/);
  await assert.rejects(discovery.listApps({ ...options, device: 'booted' }), /not listed/);
  assert.ok(calls.every(args => args[1] === 'list'));
});

test('app discovery surfaces malformed output and command failures rather than reporting empty success', async () => {
  const options = AppListingSchema.parse({ platform: 'android', device: 'emulator-5554' });
  const malformed: DiscoveryCommand = async (_file, args) => args[0] === 'devices' ? adb : 'Error: device unavailable';
  await assert.rejects(new LocalMobileDiscovery(malformed).listApps(options), /Unexpected Android package/);
  const failed: DiscoveryCommand = async (_file, args) => {
    if (args[0] === 'devices') return adb;
    throw new Error('Command timed out');
  };
  await assert.rejects(new LocalMobileDiscovery(failed).listApps(options), /timed out/);
  assert.throws(() => AppListingSchema.parse({ ...options, limit: 501 }));
  assert.throws(() => AppListingSchema.parse({ ...options, offset: -1 }));
});
