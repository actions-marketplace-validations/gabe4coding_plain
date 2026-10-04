// Shared disposable fixture installation for native smoke tests and example hooks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureApp = 'dev.plain.fixture';

// Returns cleanup only after a successful installation. Existing apps are never overwritten.
export function installMobileFixture(platform, device) {
  assert.ok(typeof device === 'string' && device.trim(), 'Set PLAIN_MOBILE_DEVICE');
  assert.ok(['ios', 'android'].includes(platform), 'Expected ios or android');
  return platform === 'ios' ? installIOS(device) : installAndroid(device);
}

function installAndroid(device) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const java = process.env.JAVA_HOME;
  assert.ok(sdk && java, 'Set ANDROID_HOME and JAVA_HOME');
  const tools = join(sdk, 'build-tools', process.env.PLAIN_ANDROID_BUILD_TOOLS ?? '36.0.0');
  const androidJar = join(sdk, 'platforms', 'android-36', 'android.jar');
  const adb = (...args) => execFileSync(join(sdk, 'platform-tools/adb'), ['-s', device, ...args], { encoding: 'utf8' });
  const app = fixtureApp;
  assert.equal(adb('get-state').trim(), 'device');
  assert.equal(adb('shell', 'pm', 'list', 'packages', app).trim(), '', 'Refusing to overwrite an existing fixture installation');
  const build = mkdtempSync(join(tmpdir(), 'plain-android-build-'));
  const run = (exe, args) => execFileSync(exe, args, { cwd: build, stdio: 'pipe' });
  try {
    mkdirSync(join(build, 'classes')); mkdirSync(join(build, 'dex'));
    writeFileSync(join(build, 'AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${app}">
      <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="36"/>
      <application android:label="Plain Fixture" android:debuggable="true" android:testOnly="true" android:supportsRtl="true" android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity android:name=".MobileAndroidFixture" android:exported="true"><intent-filter>
          <action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/>
        </intent-filter></activity>
      </application></manifest>`);
    run(join(java, 'bin/javac'), ['--release', '8', '-classpath', androidJar, '-d', 'classes', join(root, 'scripts/fixtures/MobileAndroidFixture.java')]);
    run(join(java, 'bin/jar'), ['cf', 'classes.jar', '-C', 'classes', '.']);
    run(join(tools, 'd8'), ['--lib', androidJar, '--min-api', '23', '--output', 'dex', 'classes.jar']);
    run(join(tools, 'aapt2'), ['link', '-I', androidJar, '--manifest', 'AndroidManifest.xml', '-o', 'unsigned.apk']);
    run('zip', ['-q', '-j', 'unsigned.apk', 'dex/classes.dex']);
    run(join(tools, 'zipalign'), ['-f', '4', 'unsigned.apk', 'aligned.apk']);
    run(join(java, 'bin/keytool'), ['-genkeypair', '-keystore', 'fixture.keystore', '-storepass', 'android', '-keypass', 'android', '-alias', 'fixture', '-dname', 'CN=Plain Test', '-keyalg', 'RSA', '-validity', '1']);
    run(join(tools, 'apksigner'), ['sign', '--ks', 'fixture.keystore', '--ks-pass', 'pass:android', '--out', 'fixture.apk', 'aligned.apk']);
    adb('install', '--no-incremental', '-t', join(build, 'fixture.apk'));
    return () => { adb('uninstall', app); };
  } finally { rmSync(build, { recursive: true, force: true }); }
}

function installIOS(device) {
  const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
  const app = fixtureApp;
  const devices = JSON.parse(simctl('list', 'devices', 'booted', '--json'));
  assert.ok(Object.values(devices.devices).flat().some(d => d.udid === device), 'The selected simulator must be booted');
  const apps = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: simctl('listapps', device), encoding: 'utf8',
  }));
  assert.ok(!apps[app], 'Refusing to overwrite an existing fixture installation');
  const build = mkdtempSync(join(tmpdir(), 'plain-ios-build-'));
  const run = (exe, args) => execFileSync(exe, args, { cwd: build, stdio: 'pipe' });
  try {
    const bundle = join(build, 'PlainFixture.app');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${app}</string>
      <key>CFBundleExecutable</key><string>PlainFixture</string>
      <key>CFBundleName</key><string>Plain Fixture</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>CFBundleShortVersionString</key><string>1.0</string>
      <key>MinimumOSVersion</key><string>16.0</string>
      <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
      <key>UILaunchScreen</key><dict/>
      <key>UIApplicationSceneManifest</key><dict>
        <key>UIApplicationSupportsMultipleScenes</key><false/>
        <key>UISceneConfigurations</key><dict>
          <key>UIWindowSceneSessionRoleApplication</key><array><dict>
            <key>UISceneConfigurationName</key><string>Fixture</string>
            <key>UISceneDelegateClassName</key><string>FixtureSceneDelegate</string>
          </dict></array>
        </dict>
      </dict>
      </dict></plist>`);
    const sdkPath = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    run('xcrun', ['--sdk', 'iphonesimulator', 'clang', '-target', `${arch}-apple-ios16.0-simulator`,
      '-isysroot', sdkPath, '-fobjc-arc', '-framework', 'UIKit', '-framework', 'Foundation',
      join(root, 'scripts/fixtures/MobileIOSFixture.m'), '-o', join(bundle, 'PlainFixture')]);
    run('codesign', ['--force', '--sign', '-', bundle]);
    simctl('install', device, bundle);
    return () => { simctl('uninstall', device, app); };
  } finally { rmSync(build, { recursive: true, force: true }); }
}

// Spatial evidence on a real device: Alpha comes first in the fixture's tree but is drawn on the right of Beta.
const spatialTarget = 'the left button of the Alpha and Beta pair';
const spatialClaim = 'The Beta button is left of the Alpha button';
const falseSpatialClaim = 'The Alpha button is left of the Beta button';
const measuredLeftOf = (layout, claim) => {
  const [, left, right] = /^The (\w+) button is left of the (\w+) button$/.exec(claim);
  return new RegExp(`"${left}" is left of [^\\n]*"${right}"`).test(layout ?? '');
};

/** Deterministic intelligence plus a route: a prompt that says "left" is spatial and must arrive with geometry. */
export function withSpatial(deterministic) {
  return {
    ask: async ({ groups }, questions) => ({ tokens: 1, answers: questions.map((_, i) => ({
      choice: groups[i].some((prompt) => /\bleft\b/.test(prompt)) ? 'spatial' : 'semantic', confidence: 1 })) }),
    pick: async (candidates, targets, page) => {
      if (!targets.includes(spatialTarget)) return deterministic.pick(candidates, targets, page);
      const pair = candidates.filter((c) => /^\S*Button "(Alpha|Beta)"/.test(c.desc));
      assert.equal(pair.length, 2, `Expected the Alpha and Beta buttons: ${JSON.stringify(candidates)}`);
      assert.ok(pair.every((c) => c.bounds) && page.layout && page.coordinates, 'A spatial pick carries bounds, a layout and coordinates');
      const left = pair.sort((a, b) => a.bounds.left - b.bounds.left)[0];
      return [{ id: left.id, probability: 1, probabilities: { [left.id]: 1 }, tokens: 1 }];
    },
    judge: async (state, claims) => (claims.every((claim) => [spatialClaim, falseSpatialClaim].includes(claim))
      ? { probabilities: claims.map((claim) => (measuredLeftOf(state.layout, claim) ? 1 : 0)), tokens: 1 }
      : deterministic.judge(state, claims)),
  };
}

/** A spatial tap, a true spatial claim, and a false one that must not pass. */
export async function checkSpatial(step, call) {
  await step({ tap: spatialTarget });
  assert.ok((await call('snapshot')).aria.includes('Chosen: Beta'), 'The spatial tap chose the visually left button');
  await step({ expect: spatialClaim });
  const [asked] = (await call('ask', { claims: [falseSpatialClaim] })).answers;
  assert.notEqual(asked.answer, 'yes', `A false spatial claim passed: ${JSON.stringify(asked)}`);
  console.log(`ask "${falseSpatialClaim}": ${asked.answer} (p=${asked.p})`);
}
