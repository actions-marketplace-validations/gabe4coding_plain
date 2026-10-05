---
title: Runnable mobile examples
description: Run the four mobile example specs on an Android emulator or an iOS simulator, and adapt them for your own app.
---

# Runnable mobile examples

This folder has four mobile specs. Run all commands from the repository root.

| Spec | App | What it does | Cleanup |
|---|---|---|---|
| [android.yaml](android.yaml) | The plain fixture app | Text entry, keyboard, switches, tap, long press, scroll, swipe | The hook uninstalls the fixture. |
| [ios.yaml](ios.yaml) | The plain fixture app | The same steps on an iOS simulator | The hook uninstalls the fixture. |
| [android-contacts.yaml](android-contacts.yaml) | Google Contacts | Creates and checks the contact Alex Example | None. Each run adds a contact. |
| [ios-calendar.yaml](ios-calendar.yaml) | Apple Calendar | Creates an event and finds it with Search | None. Each run adds an event. |

For Appium, device IDs and the mobile steps, read [Mobile use](../../docs/mobile-use.mdx#setup).

## Common setup

1. Install Node 22 or later. The examples use the fixture scripts of the repository. Thus run them from a clone:
   run `npm ci` and `npm run build` in the repository folder.
2. Install Appium and the driver for your platform. Install the driver before you start the server.
3. Boot the emulator or the simulator, and start Appium.
4. Put `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` in `~/.config/plain/.env`. Read [Getting started](../../docs/getting-started.mdx).
5. Set `PLAIN_MOBILE_DEVICE` to the ID of your emulator or simulator.

Do not put the API key or a personal device ID in the YAML. The specs read the device from `PLAIN_MOBILE_DEVICE`.

Appium listens on `http://127.0.0.1:4723` by default. If your server uses another address, set
`PLAIN_APPIUM_URL` or add `--server http://127.0.0.1:4725` to the command.

A passing run writes a lock file next to the spec, for example `examples/mobile/android.lock.json`.
The next run replays the recorded elements, and its step details show `(replayed)`.
If you do not want these files in the checkout, add `--mode judge` to the command and delete the file.
Read [Run modes](../../docs/running.mdx#run-modes).

## Fixture examples

`android.yaml` and `ios.yaml` use [a setup and teardown hook](../hooks/mobile-fixture.mjs).
The hook builds the offline fixture app `dev.plain.fixture` and installs it on the device.
After the run, pass or fail, the hook uninstalls the app. You need no app project.
The hook does not start the emulator, the simulator or Appium.

The hook stops if `dev.plain.fixture` is already installed. This can occur after a run that was stopped before
its teardown. Uninstall the app, then run again:

```sh
adb -s emulator-5554 uninstall dev.plain.fixture
xcrun simctl uninstall "$PLAIN_MOBILE_DEVICE" dev.plain.fixture
```

### Android

Prepare the Android host:

- Install Android SDK Platform 36, Build-Tools 36.0.0 and Platform-Tools.
- Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to the SDK folder and `JAVA_HOME` to the JDK folder.
- Make sure that `zip` is on your `PATH`. You do not need Gradle.
- Boot an emulator and start Appium with the UiAutomator2 driver.

```sh
"$ANDROID_HOME/platform-tools/adb" devices -l
PLAIN_MOBILE_DEVICE=emulator-5554 \
  node bin/plain-mobile.mjs --timeout 60000 examples/mobile/android.yaml
```

Replace `emulator-5554` with the serial of your device. To use another installed Build-Tools version, set
`PLAIN_ANDROID_BUILD_TOOLS` (for example `35.0.0`). The fixture still uses SDK Platform 36.

### iOS Simulator

Prepare the macOS host:

- Install Xcode and an iOS 16 or later simulator runtime.
- Open Xcode one time to complete its first-launch setup.
- Make sure that `xcode-select -p` shows a folder in Xcode.
- Boot an iPhone simulator and start Appium with the XCUITest driver.

The fixture works only on a simulator. You do not need an Apple developer account.

```sh
xcrun simctl list devices booted
export PLAIN_MOBILE_DEVICE='replace-with-your-booted-simulator-udid'
node bin/plain-mobile.mjs --timeout 240000 examples/mobile/ios.yaml
```

The first session builds WebDriverAgent, so the command uses a long timeout. The spec taps the Done key of the
keyboard, because `press: HideKeyboard` does not work with every iPhone keyboard.

### Results

The command prints one JSON line for the spec, with `status: "pass"` and 12 steps that pass. Then it exits with code `0`.
Each run installs a new copy of the fixture.

To use a fixture spec with your own app:

1. Copy the spec and change `app` to your package name or bundle ID.
2. Remove the `hooks` line. The hook works only with the fixture.
3. In the Android spec, remove `appium:appActivity: .MobileAndroidFixture`. Add the capabilities that your app needs.
4. Keep `device: "${env.device}"` and the `env` block, so that your device ID stays out of the file.
5. Change the steps to match the controls of your app.

These specs test native UIKit and Android controls. They do not test physical iPhones or React Native apps.

## Recorded app flows

`android-contacts.yaml` and `ios-calendar.yaml` were recorded on installed apps. They need a specific start screen.
They have no cleanup, and the data that they create stays on the device. Use a test device and remove the data
after you test. Run them with the same command as the fixture examples.

plain does not restart an app that is open. A run starts on the screen that the last run left.

### Google Contacts on Android

[android-contacts.yaml](android-contacts.yaml) creates the contact Alex Example and checks the saved details.

Before the first run:

- Install Google Contacts (`com.google.android.contacts`) on the device.
- Complete the onboarding and accept the permissions.
- Set the device language to English and open the contact list.

The spec expects that the phone field starts with `+1`. Its first two steps are optional: "Navigate up" leaves the
contact page that the last run left, and "Discard" closes a form that a stopped run left open. Each run adds one
more Alex Example contact.

### Apple Calendar on iOS

[ios-calendar.yaml](ios-calendar.yaml) creates an event on the 15th day of the next month, and then finds it with Search.

Before the first run:

- Use an iOS simulator with the English (UK) locale. The day and month names must match British English.

Calendar opens on the last screen that it showed. Thus the last steps of the spec close the event and Search, and
tap Today: the next run starts on the main view. The first steps are optional: they close an event, Search or an
unsaved event that a stopped run left open. You can run the spec again and again with no manual steps.

The hook [ios-calendar.mjs](../hooks/ios-calendar.mjs) makes the test data for each run:

- `title`: an event title that is different for each run, for example `Weekly planning k3x9q`.
- `day`: the name of the day button in the date picker, for example `Thursday, 15 October`.
- `date`: the date for the claims, for example `15 October 2026`.

The spec adds the event, opens the date picker, goes to the next month and taps the day. It checks the title and the
date, saves the event, searches for the title and checks the event in the results.
The hook does no cleanup. Each run adds one event, but the title is unique, so events from earlier runs never match the search.
