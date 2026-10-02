import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../core/results.js';

export type MobilePlatform = 'android' | 'ios';
export interface MobileDevice {
  platform: MobilePlatform;
  device: string;
  name: string;
  type: 'device' | 'emulator' | 'simulator';
  state: string;
  ready: boolean;
  runtime?: string;
}
export interface MobileApp { app: string; name?: string }
export interface DeviceListing {
  scope: 'local';
  devices: MobileDevice[];
  errors: { platform: MobilePlatform; detail: string }[];
}
export const AppListingSchema = z.object({
  platform: z.enum(['android', 'ios']),
  device: z.string().trim().min(1),
  query: z.string().default(''),
  include_system: z.boolean().default(true),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
export type AppListingOptions = z.infer<typeof AppListingSchema>;
export interface AppListing {
  scope: 'local';
  platform: MobilePlatform;
  device: string;
  apps: MobileApp[];
  total: number;
  offset: number;
  nextOffset: number | null;
}
export interface MobileDiscovery {
  listDevices(platform?: MobilePlatform): Promise<DeviceListing>;
  listApps(options: AppListingOptions): Promise<AppListing>;
}
export type DiscoveryCommand = (file: string, args: string[], input?: string) => Promise<string>;

/** No shell, bounded output and time; never touches an Appium session or an app's lifecycle. */
const runCommand: DiscoveryCommand = (file, args, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 10_000_000, windowsHide: true },
    (error, stdout, stderr) => {
      if (error) reject(new Error(`${file}: ${error.message.slice(0, 800)} ${stderr.slice(0, 800)}`.trim()));
      else resolve(stdout);
    });
  child.stdin?.on('error', () => {}); // a missing executable may close stdin before the input is written
  child.stdin?.end(input);
});

export function parseAdbDevices(output: string): MobileDevice[] {
  const lines = output.trim().split(/\r?\n/);
  const header = lines.findIndex(line => line.trim() === 'List of devices attached');
  if (header < 0) throw new Error('Unexpected adb devices output');
  return lines.slice(header + 1).filter(line => line.trim()).map(line => {
    const match = /^(\S+)\s+(no permissions|device|offline|unauthorized|recovery|sideload|bootloader)\b/.exec(line);
    if (!match) throw new Error('Unexpected adb device entry');
    const [, device, state] = match;
    return {
      platform: 'android',
      device,
      name: /\bmodel:(\S+)/.exec(line)?.[1].replaceAll('_', ' ') ?? device,
      type: device.startsWith('emulator-') ? 'emulator' : 'device',
      state,
      ready: state === 'device',
    };
  });
}

export function parseSimulators(output: string): MobileDevice[] {
  const parsed = z.object({ devices: z.record(z.string(), z.array(z.object({
    udid: z.string(), name: z.string(), state: z.string(), isAvailable: z.boolean(),
  }))) }).parse(JSON.parse(output));
  return Object.entries(parsed.devices).flatMap(([runtime, devices]) => !/\.iOS-/.test(runtime) ? [] :
    devices.filter((device) => device.isAvailable).map((device) => ({
      platform: 'ios' as const,
      device: device.udid,
      name: device.name,
      type: 'simulator' as const,
      state: device.state,
      ready: device.state === 'Booted',
      runtime,
    })));
}

export class LocalMobileDiscovery implements MobileDiscovery {
  constructor(private run: DiscoveryCommand = runCommand, private env: NodeJS.ProcessEnv = process.env,
    private host: NodeJS.Platform = process.platform, private home = homedir()) {}
  private adb() {
    const executable = this.host === 'win32' ? 'adb.exe' : 'adb';
    const sdk = this.env.ANDROID_HOME || this.env.ANDROID_SDK_ROOT;
    if (sdk) return join(sdk, 'platform-tools', executable);
    const conventional = this.host === 'darwin' ? join(this.home, 'Library', 'Android', 'sdk') :
      this.host === 'win32' && this.env.LOCALAPPDATA ? join(this.env.LOCALAPPDATA, 'Android', 'Sdk') :
        join(this.home, 'Android', 'Sdk');
    const path = join(conventional, 'platform-tools', executable);
    return existsSync(path) ? path : executable;
  }
  private async devices(platform: MobilePlatform) {
    if (platform === 'android') return parseAdbDevices(await this.run(this.adb(), ['devices', '-l']));
    if (this.host !== 'darwin') throw new Error('iOS Simulator discovery requires macOS and Xcode on the MCP host');
    return parseSimulators(await this.run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
  }
  async listDevices(platform?: MobilePlatform): Promise<DeviceListing> {
    const result: DeviceListing = { scope: 'local', devices: [], errors: [] };
    // A missing SDK is reported next to the devices the other platform found.
    for (const selected of platform ? [platform] : ['android', 'ios'] as const) {
      try {
        result.devices.push(...await this.devices(selected));
      } catch (error) {
        result.errors.push({ platform: selected, detail: errorMessage(error) });
      }
    }
    return result;
  }
  async listApps(raw: AppListingOptions): Promise<AppListing> {
    const options = AppListingSchema.parse(raw);
    const { platform, device, include_system, query, offset, limit } = options;
    const devices = await this.devices(platform);
    const selected = devices.find((listed) => listed.device === device);
    if (!selected) throw new Error(`Device ${device} is not listed on this MCP host. Use list_devices. iOS discovery supports simulators only; remote Appium devices and physical iPhones require explicit IDs for open.`);
    if (!selected.ready) throw new Error(`Device ${device} is ${selected.state}; boot/connect/authorize it before listing apps`);
    let apps: MobileApp[];
    if (platform === 'android') {
      const output = await this.run(this.adb(), ['-s', device, 'shell', 'pm', 'list', 'packages', ...(include_system ? [] : ['-3'])]);
      apps = output.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const match = /^package:(\S+)\s*$/.exec(line);
        if (!match) throw new Error('Unexpected Android package listing; check device access');
        return { app: match[1] };
      });
    } else {
      const plist = await this.run('xcrun', ['simctl', 'listapps', device]);
      const json = await this.run('plutil', ['-convert', 'json', '-o', '-', '-'], plist);
      const entries = z.record(z.string(), z.object({ CFBundleIdentifier: z.string().optional(),
        CFBundleDisplayName: z.string().optional(), CFBundleName: z.string().optional(), ApplicationType: z.string().optional(),
      })).parse(JSON.parse(json));
      apps = Object.entries(entries).filter(([, app]) => include_system || app.ApplicationType === 'User')
        .map(([id, app]) => ({ app: app.CFBundleIdentifier || id, name: app.CFBundleDisplayName || app.CFBundleName || id }));
    }
    const search = query.toLowerCase();
    apps = [...new Map(apps.map(app => [app.app, app])).values()]
      .filter(app => `${app.app}\n${app.name ?? ''}`.toLowerCase().includes(search))
      .sort((a, b) => a.app.localeCompare(b.app));
    return { scope: 'local', platform, device, apps: apps.slice(offset, offset + limit), total: apps.length,
      offset, nextOffset: offset + limit < apps.length ? offset + limit : null };
  }
}
