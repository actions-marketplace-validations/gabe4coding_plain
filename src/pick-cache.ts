import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Candidate } from './automation.js';
import { dumpDebug, type StepResult } from './results.js';

/**
 * Pick cache (docs/running.md "Pick cache"): a target Jev picked in a passing run is replayed without a Jev
 * call while the page's whole candidate list is unchanged (values typed into text fields aside) and exactly
 * one candidate has the stored description. Jev decided once; code only reuses that decision on a strict
 * match. One sidecar per source file (`login.yaml` → `login.picks.json`), committed next to the specs.
 * Attempt > 0 never reads; a failed attempt evicts the entries it used.
 */
export const PICK_FILE_VERSION = 1;
/** Bump whenever describe() / candidates() (src/candidates.ts) or a native adapter's candidate desc changes.
 *  2: `value=` is ignored only on editable (text-entry) candidates; every entry carries the list hash. */
export const DESC_FORMAT = 2;

export type PicksMode = 'on' | 'read' | 'off';
export const PICKS_MODES: readonly PicksMode[] = ['on', 'read', 'off'];

/** Where a step was written: absolute file and index in it (set by the loaders, never by YAML or MCP).
 *  `templated`: the step as written holds a `${...}` placeholder, so its targets may carry data (a user name,
 *  a secret): the key stores a hash of the interpolated target instead of its text. */
export interface StepSource { file: string; index: number; templated?: boolean }
/** What identifies one pick: the step's source, its kind, the interpolated target and the flow's goal (plus the page, at lookup). */
export interface PickRef { at: StepSource; kind: string; target: string; goal?: string }
export interface PickEntry { desc: string; frame: string; page: string; list: string }
export interface PickState { url: string; title: string }

export const sidecarPath = (file: string): string => {
  const { dir, name } = path.parse(file);
  return path.join(dir, `${name}.picks.json`);
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** A templated step may carry data in its target, its page path and the picked element's text: the sidecar
 *  (committed) keeps only their sha256 then, and matching compares hashes. */
const hidden = (text: string, templated?: boolean): string => templated ? `sha256:${sha256(text)}` : text;
/** `[index, kind, target, goal, page]` as JSON; a templated step's target and page are replaced by their sha256. */
export const entryKey = (ref: PickRef, page: string): string =>
  JSON.stringify([ref.at.index, ref.kind, hidden(ref.target, ref.at.templated), ref.goal ?? '', hidden(page, ref.at.templated)]);

const VALUE = / value="(?:[^"\\]|\\.)*"/g;
/** The desc an entry compares: without `value="…"` on a text-entry field (a fill changes it, the element is
 *  the same). Every other value stays: a submit button or a native element is identified by it. */
export const normalizeDesc = (c: Candidate): string => (c.editable ? c.desc.replace(VALUE, '') : c.desc);
/** The iframe label candidates.ts prefixes, or '' for the main frame. */
export const frameOf = (desc: string): string => /^\[iframe ([^\]]*)\] /.exec(desc)?.[1] ?? '';
/** ` #n`: one of several identical descs, by DOM order; a list that changes makes it name another row. */
export const hasOrdinal = (desc: string): boolean => / #\d+(?= context: |$)/.test(desc);
export const listHash = (candidates: Candidate[]): string =>
  createHash('sha1').update(candidates.map(normalizeDesc).join('\n')).digest('hex');

/** origin + path; query and hash ignored. A desktop url carries the process id, which changes every launch: the app name stands in. */
export function pageOf(state: PickState): string {
  try {
    const url = new URL(state.url);
    if (url.protocol === 'desktop:') return `desktop://${state.title}`;
    return url.origin !== 'null' ? `${url.origin}${url.pathname}` : `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return state.url; }
}

/** The entry an accepted pick becomes, or null when it must never be stored. */
export function makeEntry(candidate: Candidate, candidates: Candidate[], state: PickState, templated?: boolean): PickEntry | null {
  if (hasOrdinal(candidate.desc)) return null;
  const desc = normalizeDesc(candidate);
  // Unique on this page, or the same page would already miss (two text fields that differ only by value).
  if (candidates.filter((c) => normalizeDesc(c) === desc).length !== 1) return null;
  return { desc: hidden(desc, templated), frame: hidden(frameOf(candidate.desc), templated), page: hidden(pageOf(state), templated),
    list: listHash(candidates) };
}

/** The one candidate a stored entry matches on this page, or undefined: same page, the same whole candidate
 *  list (a new row that fits the target better is a change), and exactly one equal desc in the same frame. */
export function match(entry: PickEntry, candidates: Candidate[], state: PickState, templated?: boolean): Candidate | undefined {
  if (hidden(pageOf(state), templated) !== entry.page || listHash(candidates) !== entry.list) return undefined;
  const found = candidates.filter((c) => hidden(normalizeDesc(c), templated) === entry.desc && hidden(frameOf(c.desc), templated) === entry.frame);
  return found.length === 1 ? found[0] : undefined;
}

const isEntry = (v: unknown): v is PickEntry => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return typeof e.desc === 'string' && typeof e.frame === 'string' && typeof e.page === 'string' && typeof e.list === 'string';
};

/** The entries of a sidecar's text, or null when it is unreadable or was written for another model or desc format. */
export function parseFile(text: string, model: string): Map<string, PickEntry> | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw === null || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  if (file.version !== PICK_FILE_VERSION || file.model !== model || file.desc !== DESC_FORMAT) return null;
  if (file.entries === null || typeof file.entries !== 'object' || Array.isArray(file.entries)) return null;
  const out = new Map<string, PickEntry>();
  for (const [key, value] of Object.entries(file.entries)) if (isEntry(value)) out.set(key, value);
  return out;
}

// Step index first (numerically), then the rest: the file reads in step order.
const indexIn = (key: string): number => {
  try { const v: unknown = JSON.parse(key); return Array.isArray(v) && typeof v[0] === 'number' ? v[0] : -1; } catch { return -1; }
};
const byKey = (a: string, b: string): number => {
  const [ia, ib] = [indexIn(a), indexIn(b)];
  return ia !== ib ? ia - ib : a < b ? -1 : a > b ? 1 : 0;
};

/** Deterministic sidecar text: keys sorted, 2-space JSON, trailing newline, no timestamps. */
export function formatFile(model: string, entries: Map<string, PickEntry>): string {
  const sorted: Record<string, PickEntry> = {};
  for (const key of [...entries.keys()].sort(byKey)) {
    const e = entries.get(key)!;
    sorted[key] = { desc: e.desc, frame: e.frame, page: e.page, list: e.list };
  }
  return JSON.stringify({ version: PICK_FILE_VERSION, model, desc: DESC_FORMAT, entries: sorted }, null, 2) + '\n';
}

export interface PickIO {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  remove(file: string): void;
}
export const fileIO: PickIO = {
  read: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } },
  write: (file, text) => fs.writeFileSync(file, text),
  remove: (file) => fs.rmSync(file, { force: true }),
};

interface Sidecar { entries: Map<string, PickEntry>; dirty: boolean }

/** One per run: every sidecar read once, changed in memory as attempts finish, written once by write(). */
export class PickStore {
  private files = new Map<string, Sidecar>();
  constructor(readonly mode: PicksMode, readonly model: string, private io: PickIO = fileIO) {}
  private sidecar(source: string): Sidecar {
    const file = sidecarPath(source);
    let car = this.files.get(file);
    if (!car) {
      const text = this.io.read(file);
      car = { entries: (text === undefined ? null : parseFile(text, this.model)) ?? new Map(), dirty: false };
      this.files.set(file, car);
    }
    return car;
  }
  get(ref: PickRef, page: string): PickEntry | undefined { return this.sidecar(ref.at.file).entries.get(entryKey(ref, page)); }
  set(ref: PickRef, page: string, entry: PickEntry | null): void {
    const car = this.sidecar(ref.at.file), key = entryKey(ref, page), old = car.entries.get(key);
    if (entry === null) { if (old) { car.entries.delete(key); car.dirty = true; } return; }
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    car.entries.set(key, entry); car.dirty = true;
  }
  /** A handle for one attempt of one spec. */
  attempt(attempt: number): PickAttempt { return new PickAttempt(this, this.mode !== 'off' && attempt === 0, this.mode !== 'off'); }
  /** Writes every changed sidecar (`on` only); a sidecar left with no entries is deleted. Returns the files
   *  written or deleted. Two processes writing the same sidecar: the last writer wins (sharded CI: `read`). */
  write(): string[] {
    if (this.mode !== 'on') return [];
    const done: string[] = [];
    for (const [file, car] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!car.dirty) continue;
      try {
        if (car.entries.size) this.io.write(file, formatFile(this.model, car.entries));
        else this.io.remove(file);
        done.push(file);
        car.dirty = false;
      } catch (error) { console.error(`plainwright: pick cache: ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return done;
  }
}

interface Used { ref: PickRef; page: string; entry: PickEntry }
interface Pending { ref: PickRef; page: string; entry: PickEntry | null }

/**
 * One attempt's view of the store. Lookups are pure (an early look may be discarded); the caller reports
 * the pick it kept with hit()/accept(). Per step: a step that does not pass stores nothing and evicts its
 * hits. finish(): a passing attempt commits its pending entries, a failing one evicts every hit it used.
 */
export class PickAttempt {
  private hits = new Map<string, Used>();
  private evict = new Map<string, Used>();
  private pending = new Map<string, Pending>();
  private stepHits = new Map<string, Used>();
  private stepPending = new Map<string, Pending>();
  private closed = false;
  constructor(private store: PickStore | null, readonly reads: boolean, private writes: boolean) {}
  /** The candidate a stored pick matches on this page, or undefined (a miss: Jev picks). */
  lookup(ref: PickRef, candidates: Candidate[], state: PickState): Candidate | undefined {
    if (!this.reads || this.closed || !this.store) return undefined;
    const entry = this.store.get(ref, pageOf(state));
    return entry && match(entry, candidates, state, ref.at.templated);
  }
  /** The step acted on a cached pick. */
  hit(ref: PickRef, state: PickState): void {
    const page = pageOf(state), entry = this.store?.get(ref, page);
    if (entry && !this.closed) this.stepHits.set(`${entryKey(ref, page)}\0${ref.at.file}`, { ref, page, entry });
  }
  /** Jev's accepted pick, stored if this step and this attempt pass (and the desc can be matched strictly). */
  accept(ref: PickRef, candidate: Candidate, candidates: Candidate[], state: PickState): void {
    if (!this.writes || this.closed) return;
    const page = pageOf(state);
    this.stepPending.set(`${entryKey(ref, page)}\0${ref.at.file}`, { ref, page, entry: makeEntry(candidate, candidates, state, ref.at.templated) });
  }
  /** Ends a step; returns a dump of the cached picks this attempt used when the step did not pass. */
  endStep(status: string): string | undefined {
    if (this.closed) return undefined;
    const passed = status === 'pass';
    for (const [k, v] of this.stepHits) (passed ? this.hits : this.evict).set(k, v);
    if (passed) for (const [k, v] of this.stepPending) this.pending.set(k, v);
    this.stepHits.clear(); this.stepPending.clear();
    if (passed) return undefined;
    const used = [...this.hits.values(), ...this.evict.values()];
    if (!used.length) return undefined;
    return dumpDebug('pick-cache', used.map(({ ref, page, entry }) => ({ sidecar: sidecarPath(ref.at.file), key: entryKey(ref, page), ...entry })));
  }
  /** Commits (passed) or evicts (failed); later calls on this handle do nothing. */
  finish(passed: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.store || !this.writes) return;
    const evicted = passed ? this.evict : new Map([...this.hits, ...this.evict, ...this.stepHits]);
    for (const { ref, page } of evicted.values()) this.store.set(ref, page, null);
    if (passed) for (const { ref, page, entry } of this.pending.values()) this.store.set(ref, page, entry);
  }
  /** Picks this attempt replayed from the cache so far. */
  get cachedPicks(): number { return this.hits.size + this.evict.size + this.stepHits.size; }
}

/** A handle that never reads or stores (MCP sessions, cache `off`). */
export const noPicks = (): PickAttempt => new PickAttempt(null, false, false);

/** A step that did not pass after its attempt used cached picks names them: `cache: <dump>.json` (the artifacts observer copies it). */
export function withCacheDump(result: StepResult, file: string | undefined): StepResult {
  return file ? { ...result, detail: `${result.detail ? `${result.detail} ` : ''}— cache: ${file}` } : result;
}
