import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import type { Artifact, CaptureTarget, Engine, RunObserver, SpecInfo, SuiteOptions } from './types.js';

interface Capture {
  dir: string;
  artifacts: Artifact[];
  dumps: { source: string; step: number }[];
  tracing?: BrowserContext['tracing'];
}

/** `engine` lets suite callers reject native tracing before opening a session. */
export function artifactsObserver(opts: SuiteOptions, engine?: Engine): RunObserver | null {
  const modes = opts.artifacts;
  if (!modes) return null;
  const checkEngine = (value: Engine): void => {
    if (value !== 'browser' && modes.trace !== 'off') throw new Error('--trace is browser-only; use --trace off for desktop or mobile artifacts');
  };
  if (engine) checkEngine(engine);
  const cwd = process.cwd();
  const root = path.resolve(cwd, modes.dir);
  const marker = path.join(root, '.plainwright-results');
  const dumpRoot = path.join(os.tmpdir(), 'plainwright');
  const captures = new WeakMap<CaptureTarget, Capture>();
  const folders = new Map<string, string>();
  const usedSlugs = new Set<string>();
  const usedAttempts = new Set<string>();
  let ready = false;
  let warned = false;
  let cdpNoted = false;
  const warn = (error: unknown): void => {
    if (warned) return;
    warned = true;
    console.error(`plainwright: artifacts: ${error instanceof Error ? error.message : String(error)}`);
  };
  const slugFor = (file: string): string => {
    const relative = path.relative(cwd, path.resolve(cwd, file));
    const existing = folders.get(relative);
    if (existing) return existing;
    // Reserve suffix space and stay below common filesystem component limits.
    const cleaned = relative.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 180);
    const base = !cleaned || cleaned === '.' || cleaned === '..' ? 'spec' : cleaned;
    let slug = base;
    // Case-insensitive: on APFS and NTFS `X/Login.yaml` and `x-login.yaml` would share one folder.
    for (let n = 2; usedSlugs.has(slug.toLowerCase()); n++) slug = `${base}-${n}`;
    usedSlugs.add(slug.toLowerCase());
    folders.set(relative, slug);
    return slug;
  };
  const captureFor = (info: SpecInfo): Capture => {
    const slug = slugFor(info.file);
    let dir = path.join(root, slug, `attempt-${info.attempt}`);
    // Repeated command-line paths can execute the same attempt concurrently too.
    for (let n = 2; usedAttempts.has(dir); n++) dir = path.join(root, `${slug}-duplicate-${n}`, `attempt-${info.attempt}`);
    usedAttempts.add(dir);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, artifacts: [], dumps: [] };
  };
  const write = async (capture: Capture, artifact: Artifact, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      capture.artifacts.push(artifact);
    } catch (error) {
      warn(error);
      // A failed capture may have left a partial file behind.
      try { fs.rmSync(artifact.path, { force: true }); } catch { /* best effort */ }
    }
  };
  return {
    async runStart(event) {
      ready = false;
      checkEngine(event.engine);
      folders.clear(); usedSlugs.clear(); usedAttempts.clear();
      warned = false; cdpNoted = false;
      // Never a folder that holds the project: the cwd or a parent of it, home, the filesystem root, or one with a spec in it.
      const inside = (child: string, parent: string): boolean => {
        const relative = path.relative(parent, child);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      };
      if (root === path.parse(root).root || root === os.homedir() || inside(cwd, root))
        throw new Error(`${root} cannot hold artifacts: it is the working folder, one of its parents, the home folder or the filesystem root`);
      const spec = event.specs.find(({ file }) => inside(path.resolve(cwd, file), root));
      if (spec) throw new Error(`${root} cannot hold artifacts: it contains the spec ${spec.file}`);
      if (fs.existsSync(root)) {
        const owned = fs.existsSync(marker) && fs.lstatSync(marker).isFile();
        if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()
          || (!owned && fs.readdirSync(root).length))
          throw new Error(`${root} exists and was not created by plainwright`);
        // Delete only what a run made: spec folders that hold nothing but attempt-N folders. Anything else stays.
        if (owned) for (const entry of fs.readdirSync(root)) {
          const folder = path.join(root, entry);
          const stat = fs.lstatSync(folder);
          if (!stat.isDirectory()) continue;
          const children = fs.readdirSync(folder);
          if (children.every((child) => /^attempt-\d+$/.test(child) && fs.lstatSync(path.join(folder, child)).isDirectory()))
            fs.rmSync(folder, { recursive: true, force: true });
        }
      } else fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(marker, 'plainwright results\n');
      for (const spec of event.specs) slugFor(spec.file);
      ready = true;
    },
    async sessionOpen(event) {
      if (!ready) return;
      let capture: Capture;
      try { capture = captureFor(event); }
      catch (error) { warn(error); return; }
      captures.set(event.target, capture);
      if (modes.trace === 'off' || event.target.engine !== 'browser') return;
      // Attached browsers must explicitly advertise CDP on their capture target.
      if (event.target.cdp) {
        if (!cdpNoted) {
          cdpNoted = true;
          console.error('plainwright: artifacts: tracing skipped for --cdp (attached browser tabs)');
        }
        return;
      }
      try {
        const tracing = event.target.page!().context().tracing;
        await tracing.start({ screenshots: true, snapshots: true, sources: false });
        capture.tracing = tracing;
      } catch (error) { warn(error); }
    },
    async stepEnd(event) {
      const capture = captures.get(event.target);
      if (!ready || !capture) return;
      // Any labelled dump: `state: <file>` (claims), `candidates: <file>` (picks), ...
      for (const match of (event.result.detail ?? '').matchAll(/\b[a-z]+:\s+(.+?\.json)(?=\s*(?:\||—|$))/g)) {
        const source = match[1];
        if (path.isAbsolute(source) && path.dirname(source) === dumpRoot)
          capture.dumps.push({ source, step: event.index });
      }
      const failed = ['fail', 'error', 'inconclusive'].includes(event.result.status);
      // `always` adds final.png at close; step shots stay failure-only (a shot per step costs time on every step).
      if (modes.screenshot !== 'off' && failed) {
        const file = path.join(capture.dir, `step-${event.index}-${event.result.status}.png`);
        await write(capture, { kind: 'screenshot', path: file, step: event.index }, () => event.target.screenshot(file));
      }
    },
    async sessionClose(event) {
      const capture = captures.get(event.target);
      if (!ready || !capture) return [];
      captures.delete(event.target);
      if (modes.screenshot === 'always') {
        const file = path.join(capture.dir, 'final.png');
        await write(capture, { kind: 'screenshot', path: file }, () => event.target.screenshot(file));
      }
      if (capture.tracing) {
        const tracing = capture.tracing;
        if (modes.trace === 'always' || event.status !== 'pass') {
          const file = path.join(capture.dir, 'trace.zip');
          await write(capture, { kind: 'trace', path: file }, () => tracing.stop({ path: file }));
        } else {
          try { await tracing.stop(); } catch (error) { warn(error); }
        }
      }
      const copied = new Set<string>();
      for (const { source, step } of capture.dumps) {
        const file = path.join(capture.dir, `step-${step}-${path.basename(source)}`);
        if (copied.has(file)) continue;
        copied.add(file);
        await write(capture, { kind: 'dump', path: file, step }, async () => { fs.copyFileSync(source, file); });
      }
      try {
        if (!fs.readdirSync(capture.dir).length) {
          fs.rmdirSync(capture.dir);
          const specDir = path.dirname(capture.dir);
          if (!fs.readdirSync(specDir).length) fs.rmdirSync(specDir);
        }
      } catch (error) { warn(error); }
      return capture.artifacts;
    },
  };
}
