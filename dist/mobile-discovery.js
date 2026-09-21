import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
export const AppListingSchema = z.object({
    platform: z.enum(['android', 'ios']), device: z.string().trim().min(1),
    query: z.string().default(''), include_system: z.boolean().default(true),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100),
});
// No shell interpolation, bounded output/time, and no Appium session or app lifecycle changes.
const runCommand = (file, args, input) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 10_000_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error)
            reject(new Error(`${file}: ${error.message.slice(0, 800)} ${stderr.slice(0, 800)}`.trim()));
        else
            resolve(stdout);
    });
    child.stdin?.on('error', () => { }); // A missing executable may close stdin before input is written.
    child.stdin?.end(input);
});
export function parseAdbDevices(output) {
    const lines = output.trim().split(/\r?\n/);
    const header = lines.findIndex(line => line.trim() === 'List of devices attached');
    if (header < 0)
        throw new Error('Unexpected adb devices output');
    return lines.slice(header + 1).filter(line => line.trim()).map(line => {
        const match = /^(\S+)\s+(no permissions|device|offline|unauthorized|recovery|sideload|bootloader)\b/.exec(line);
        if (!match)
            throw new Error('Unexpected adb device entry');
        const [, device, state] = match;
        return { platform: 'android', device, name: /\bmodel:(\S+)/.exec(line)?.[1].replaceAll('_', ' ') ?? device,
            type: device.startsWith('emulator-') ? 'emulator' : 'device', state, ready: state === 'device' };
    });
}
export function parseSimulators(output) {
    const parsed = z.object({ devices: z.record(z.string(), z.array(z.object({
            udid: z.string(), name: z.string(), state: z.string(), isAvailable: z.boolean(),
        }))) }).parse(JSON.parse(output));
    return Object.entries(parsed.devices).flatMap(([runtime, devices]) => /\.iOS-/.test(runtime) ? devices.filter(d => d.isAvailable).map(d => ({
        platform: 'ios', device: d.udid, name: d.name, type: 'simulator',
        state: d.state, ready: d.state === 'Booted', runtime,
    })) : []);
}
export class LocalMobileDiscovery {
    run;
    env;
    host;
    home;
    constructor(run = runCommand, env = process.env, host = process.platform, home = homedir()) {
        this.run = run;
        this.env = env;
        this.host = host;
        this.home = home;
    }
    adb() {
        const executable = this.host === 'win32' ? 'adb.exe' : 'adb';
        const sdk = this.env.ANDROID_HOME || this.env.ANDROID_SDK_ROOT;
        if (sdk)
            return join(sdk, 'platform-tools', executable);
        const conventional = this.host === 'darwin' ? join(this.home, 'Library', 'Android', 'sdk') :
            this.host === 'win32' && this.env.LOCALAPPDATA ? join(this.env.LOCALAPPDATA, 'Android', 'Sdk') :
                join(this.home, 'Android', 'Sdk');
        const path = join(conventional, 'platform-tools', executable);
        return existsSync(path) ? path : executable;
    }
    async devices(platform) {
        if (platform === 'android')
            return parseAdbDevices(await this.run(this.adb(), ['devices', '-l']));
        if (this.host !== 'darwin')
            throw new Error('iOS Simulator discovery requires macOS and Xcode on the MCP host');
        return parseSimulators(await this.run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
    }
    async listDevices(platform) {
        const result = { scope: 'local', devices: [], errors: [] };
        // Keep a missing SDK visible while returning devices found by the other platform.
        for (const selected of platform ? [platform] : ['android', 'ios']) {
            try {
                result.devices.push(...await this.devices(selected));
            }
            catch (error) {
                result.errors.push({ platform: selected, detail: error instanceof Error ? error.message : String(error) });
            }
        }
        return result;
    }
    async listApps(raw) {
        const options = AppListingSchema.parse(raw);
        const { platform, device, include_system, query, offset, limit } = options;
        const devices = await this.devices(platform);
        const selected = devices.find(d => d.device === device);
        if (!selected)
            throw new Error(`Device ${device} is not listed on this MCP host. Use list_devices. iOS discovery supports simulators only; remote Appium devices and physical iPhones require explicit IDs for open.`);
        if (!selected.ready)
            throw new Error(`Device ${device} is ${selected.state}; boot/connect/authorize it before listing apps`);
        let apps;
        if (platform === 'android') {
            const output = await this.run(this.adb(), ['-s', device, 'shell', 'pm', 'list', 'packages', ...(include_system ? [] : ['-3'])]);
            apps = output.split(/\r?\n/).filter(line => line.trim()).map(line => {
                const match = /^package:(\S+)\s*$/.exec(line);
                if (!match)
                    throw new Error('Unexpected Android package listing; check device access');
                return { app: match[1] };
            });
        }
        else {
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
