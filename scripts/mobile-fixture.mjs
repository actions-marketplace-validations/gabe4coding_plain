// Shared disposable fixture installation for native smoke tests and example hooks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureApp = 'dev.plainwright.fixture';

// Returns cleanup only after a successful installation. Existing apps are never overwritten.
export function installMobileFixture(platform, device) {
  assert.ok(typeof device === 'string' && device.trim(), 'Set PLAINWRIGHT_MOBILE_DEVICE');
  assert.ok(['ios', 'android'].includes(platform), 'Expected ios or android');
  return platform === 'ios' ? installIOS(device) : installAndroid(device);
}

function installAndroid(device) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const java = process.env.JAVA_HOME;
  assert.ok(sdk && java, 'Set ANDROID_HOME and JAVA_HOME');
  const tools = join(sdk, 'build-tools', process.env.PLAINWRIGHT_ANDROID_BUILD_TOOLS ?? '36.0.0');
  const androidJar = join(sdk, 'platforms', 'android-36', 'android.jar');
  const adb = (...args) => execFileSync(join(sdk, 'platform-tools/adb'), ['-s', device, ...args], { encoding: 'utf8' });
  const app = fixtureApp;
  assert.equal(adb('get-state').trim(), 'device');
  assert.equal(adb('shell', 'pm', 'list', 'packages', app).trim(), '', 'Refusing to overwrite an existing fixture installation');
  const build = mkdtempSync(join(tmpdir(), 'plainwright-android-build-'));
  const run = (exe, args) => execFileSync(exe, args, { cwd: build, stdio: 'pipe' });
  try {
    mkdirSync(join(build, 'classes')); mkdirSync(join(build, 'dex'));
    writeFileSync(join(build, 'AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${app}">
      <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="36"/>
      <application android:label="Plainwright Fixture" android:debuggable="true" android:testOnly="true" android:theme="@android:style/Theme.Material.Light.NoActionBar">
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
    run(join(java, 'bin/keytool'), ['-genkeypair', '-keystore', 'fixture.keystore', '-storepass', 'android', '-keypass', 'android', '-alias', 'fixture', '-dname', 'CN=Plainwright Test', '-keyalg', 'RSA', '-validity', '1']);
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
  const build = mkdtempSync(join(tmpdir(), 'plainwright-ios-build-'));
  const run = (exe, args) => execFileSync(exe, args, { cwd: build, stdio: 'pipe' });
  try {
    const bundle = join(build, 'PlainwrightFixture.app');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${app}</string>
      <key>CFBundleExecutable</key><string>PlainwrightFixture</string>
      <key>CFBundleName</key><string>Plainwright Fixture</string>
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
      join(root, 'scripts/fixtures/MobileIOSFixture.m'), '-o', join(bundle, 'PlainwrightFixture')]);
    run('codesign', ['--force', '--sign', '-', bundle]);
    simctl('install', device, bundle);
    return () => { simctl('uninstall', device, app); };
  } finally { rmSync(build, { recursive: true, force: true }); }
}
