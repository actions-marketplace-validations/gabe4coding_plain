# Runnable mobile examples

[android.yaml](android.yaml) and [ios.yaml](ios.yaml) exercise text entry, keyboard dismissal,
idempotent switch checks, tap, assertions, long press, scrolling and swipe through real Jev.
Run the commands below from the repository root.

Both use [a setup/teardown hook](../hooks/mobile-fixture.mjs) to build and temporarily install
the repository's offline native fixture (`dev.plainwright.fixture`). The hook refuses to
overwrite an existing installation and uninstalls its app after a successful or failed run.
No separate app project or manual fixture installation is needed. The simulator/emulator and
Appium must already be running; the hook does not start them.

## Common setup

- Node 22+ and npm. `bin/plainwright-mobile.mjs` installs the npm dependencies on first run.
- Appium with the appropriate platform driver installed before starting the server.
- `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, configured in the environment, repository `.env`,
  or `~/.config/plainwright/.env`. Never put a key in YAML.

See [the mobile setup guide](../../docs/mobile-use.md#setup) for installation details.
The server defaults to `http://127.0.0.1:4723`. Set `PLAINWRIGHT_APPIUM_URL` or pass
`--server http://127.0.0.1:4725` if yours uses another port.

## Android

Install Android SDK Platform 36, Build-Tools 36.0.0 and Platform-Tools. Set `ANDROID_HOME` (or
`ANDROID_SDK_ROOT`) and `JAVA_HOME` to the installed SDK/JDK. Boot an emulator and start Appium
with its UiAutomator2 driver. Gradle is not needed.

```sh
"$ANDROID_HOME/platform-tools/adb" devices -l
PLAINWRIGHT_MOBILE_DEVICE=emulator-5554 \
  node bin/plainwright-mobile.mjs --timeout 60000 examples/mobile/android.yaml
```

Replace `emulator-5554` with your device's actual serial. `PLAINWRIGHT_ANDROID_BUILD_TOOLS`
can select a different installed build-tools version; the fixture still uses SDK Platform 36.

## iOS Simulator

On macOS, install Xcode and an iOS Simulator runtime, complete Xcode's first-launch setup,
and select Xcode's developer directory. Boot an iPhone simulator and start Appium with its
XCUITest driver. This fixture is simulator-only and requires no Apple developer account.

```sh
xcrun simctl list devices booted
export PLAINWRIGHT_MOBILE_DEVICE='replace-with-your-booted-simulator-udid'
node bin/plainwright-mobile.mjs --timeout 240000 examples/mobile/ios.yaml
```

The longer timeout allows the first WebDriverAgent build. The YAML taps the keyboard's Done
key because generic keyboard dismissal is not supported by every iPhone keyboard.

## Results and editing

Each command prints one JSON result, with `status: "pass"` and 12 passing steps on success,
and exits 0. Each new run installs a fresh fixture. Copy or edit the YAML to try other supported
actions. Keep the device environment reference so personal simulator IDs stay out of the repo.

For your own app, replace `app`, remove the fixture hook and supply any required launch
capabilities. These examples validate native UIKit/Android controls; they do not by themselves
verify physical iPhones or React Native-specific behavior.

## Recorded app flows

[android-contacts.yaml](android-contacts.yaml) creates and verifies an Alex Example contact in
Google Contacts. Install that app first, finish onboarding and permissions, and start on its
contact list in English. The recording assumes the phone field initially contains `+1`.

[ios-calendar.yaml](ios-calendar.yaml) creates and verifies a Weekly planning event in Apple
Calendar. It is a recording with specific starting conditions: English UI, Calendar's main
view, September 2026 in the date picker, and a new event defaulting to 11:00–12:00. The recording
selects 22 September but does not set the time. Prepare those defaults or adapt the date/time
steps for your device; the assertion before Save checks the expected appointment.

Run either file with the same CLI and `PLAINWRIGHT_MOBILE_DEVICE` configuration shown above.
These two recordings use installed apps and preserve created data, with no fixture hook or
automatic cleanup. Use dedicated test data and remove the sample contact/event after testing;
replaying can create duplicates. Use `android.yaml` and `ios.yaml` for repeatable smoke tests.
