import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Candidate } from './automation.js';
import type { StepSource } from './spec.js';
import { dumpDebug, errorMessage, type StepResult } from './results.js';

/*
 * Pick cache (docs/running.mdx "Pick cache"): a high-confidence pick in a passing run is replayed without a Jev
 * call while the page's whole candidate list is unchanged (typed text aside) and exactly one candidate has the stored
 * description. Jev decided once; code only reuses that decision on a strict match. One sidecar per source file
 * (`login.yaml` → `login.picks.json`), committed next to the specs. A retry never reads; a failed attempt
 * evicts the entries it used.
 */
export const PICK_FILE_VERSION = 2;
/** Reusing a decision across runs needs more certainty than acting once (0.5). */
const PICK_CACHE_ACCEPT_AT = 0.9;
/**
 * Bump whenever a candidate description changes (src/browser/candidates.ts or a native adapter).
 * 2: `value=` is ignored only on editable candidates; every entry has the list hash.
 * 3: the list hash also covers each element's UI state (checked, selected, pressed, expanded, disabled).
 * 4: a labelable control's description carries its `<label>` text (`label="…"`).
 * 5: spatial candidates and reference elements carry rendered geometry in the list hash.
 */
export const DESC_FORMAT = 5;

export const PICKS_MODES = ['on', 'read', 'off'] as const;
export type PicksMode = typeof PICKS_MODES[number];

/** What identifies one pick, together with the page: the step's source and kind, the interpolated target, the goal. */
export interface PickRef { at: StepSource; kind: string; target: string; goal?: string }
export interface PickEntry { desc: string; frame: string; page: string; list: string }
export interface PickState { url: string; title: string; layout?: string }

export const sidecarPath = (file: string): string => {
  const { dir, name } = path.parse(file);
  return path.join(dir, `${name}.picks.json`);
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** A templated step may carry data in its target, page and picked element: the committed sidecar keeps only hashes. */
const hashIfTemplated = (text: string, templated?: boolean): string => templated ? `sha256:${sha256(text)}` : text;
/** `[index, kind, target, goal, page]` as JSON. */
export const entryKey = (ref: PickRef, page: string): string =>
  JSON.stringify([ref.at.index, ref.kind, hashIfTemplated(ref.target, ref.at.templated), ref.goal ?? '', hashIfTemplated(page, ref.at.templated)]);

const VALUE = / value="(?:[^"\\]|\\.)*"/g;
/**
 * The description an entry compares: without `value="…"` on a text-entry field, since a fill changes it. Every
 * other value stays: it names a submit button or a native element.
 */
export const normalizeDesc = (c: Candidate): string => (c.editable ? c.desc.replace(VALUE, '') : c.desc);
/** The iframe label a candidate description starts with, or '' for the main frame. */
const frameOf = (desc: string): string => /^\[iframe ([^\]]*)\] /.exec(desc)?.[1] ?? '';
/** ` #n`: one of several identical descriptions, by DOM order. When the list changes it names another row. */
const hasOrdinal = (desc: string): boolean => / #\d+(?= context: |$)/.test(desc);
/** Candidate identity, state and bounds, plus spatial references when requested. */
export const listHash = (candidates: Candidate[], layout?: string): string =>
  createHash('sha1').update(candidates.map((c) => `${normalizeDesc(c)}${c.state ? `\u0000${c.state}` : ''}` +
    (c.bounds ? `\u0000${JSON.stringify(c.bounds)}` : '')).join('\n') +
    (layout === undefined ? '' : `\u0000layout\u0000${layout}`)).digest('hex');

/** Origin and path; query and hash ignored. A desktop URL holds the process id, so the app name stands in. */
export function pageOf(state: PickState): string {
  try {
    const url = new URL(state.url);
    if (url.protocol === 'desktop:') return `desktop://${state.title}`;
    return url.origin !== 'null' ? `${url.origin}${url.pathname}` : `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return state.url; }
}

/** The entry an accepted pick becomes, or null when it must never be stored. */
export function makeEntry(candidate: Candidate, candidates: Candidate[], state: PickState, score: number, templated?: boolean): PickEntry | null {
  if (!Number.isFinite(score) || score < PICK_CACHE_ACCEPT_AT || score > 1) return null;
  if (hasOrdinal(candidate.desc)) return null;
  const desc = normalizeDesc(candidate);
  // Unique on this page, or the same page would already miss (two text fields that differ only by value).
  if (candidates.filter((c) => normalizeDesc(c) === desc).length !== 1) return null;
  return { desc: hashIfTemplated(desc, templated), frame: hashIfTemplated(frameOf(candidate.desc), templated), page: hashIfTemplated(pageOf(state), templated),
    list: listHash(candidates, state.layout) };
}

/** The one candidate a stored entry matches on this page, or undefined: same page, the same whole candidate
 *  list (a new row that fits the target better is a change), and exactly one equal desc in the same frame. */
export function matchEntry(entry: PickEntry, candidates: Candidate[], state: PickState, templated?: boolean): Candidate | undefined {
  if (hashIfTemplated(pageOf(state), templated) !== entry.page || listHash(candidates, state.layout) !== entry.list) return undefined;
  const found = candidates.filter((c) => hashIfTemplated(normalizeDesc(c), templated) === entry.desc && hashIfTemplated(frameOf(c.desc), templated) === entry.frame);
  return found.length === 1 ? found[0] : undefined;
}

const isEntry = (value: unknown): value is PickEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.desc === 'string' && typeof entry.frame === 'string' && typeof entry.page === 'string' && typeof entry.list === 'string';
};

/** The entries of a sidecar, or null when it is unreadable or was written for another model or description format. */
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

const stepIndexOf = (key: string): number => {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'number' ? parsed[0] : -1;
  } catch {
    return -1;
  }
};
/** By step index, then by key: the file reads in step order. */
const byStepThenKey = (a: string, b: string): number => {
  const [indexA, indexB] = [stepIndexOf(a), stepIndexOf(b)];
  return indexA !== indexB ? indexA - indexB : a < b ? -1 : a > b ? 1 : 0;
};

/** Deterministic sidecar text: keys sorted, 2-space JSON, trailing newline, no timestamps. */
export function formatFile(model: string, entries: Map<string, PickEntry>): string {
  const sorted: Record<string, PickEntry> = {};
  for (const key of [...entries.keys()].sort(byStepThenKey)) {
    const entry = entries.get(key)!;
    sorted[key] = { desc: entry.desc, frame: entry.frame, page: entry.page, list: entry.list };
  }
  return JSON.stringify({ version: PICK_FILE_VERSION, model, desc: DESC_FORMAT, entries: sorted }, null, 2) + '\n';
}

export interface PickIO {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  remove(file: string): void;
}
const fileIO: PickIO = {
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
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
    let sidecar = this.files.get(file);
    if (!sidecar) {
      const text = this.io.read(file);
      sidecar = { entries: (text === undefined ? null : parseFile(text, this.model)) ?? new Map(), dirty: false };
      this.files.set(file, sidecar);
    }
    return sidecar;
  }

  get(ref: PickRef, page: string): PickEntry | undefined {
    return this.sidecar(ref.at.file).entries.get(entryKey(ref, page));
  }

  /** Stores `entry`, or evicts the key when it is null. */
  set(ref: PickRef, page: string, entry: PickEntry | null): void {
    const sidecar = this.sidecar(ref.at.file);
    const key = entryKey(ref, page);
    const old = sidecar.entries.get(key);
    if (entry === null) {
      if (old) {
        sidecar.entries.delete(key);
        sidecar.dirty = true;
      }
      return;
    }
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    sidecar.entries.set(key, entry);
    sidecar.dirty = true;
  }

  /**
   * A handle for one attempt of one spec. `on` reads, adds and evicts; `read` only reads, but a pick that failed
   * is not reused later in the run (evicted in memory, never on disk); `off` does nothing.
   */
  attempt(attempt: number): PickAttempt {
    return new PickAttempt(this, this.mode !== 'off' && attempt === 0, this.mode === 'on', this.mode !== 'off');
  }

  /**
   * Writes every changed sidecar (`on` only) and deletes the ones left empty; returns those files. Two processes
   * writing the same sidecar: the last one wins (use `read` for sharded CI).
   */
  write(): string[] {
    if (this.mode !== 'on') return [];
    const done: string[] = [];
    for (const [file, sidecar] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!sidecar.dirty) continue;
      try {
        if (sidecar.entries.size) this.io.write(file, formatFile(this.model, sidecar.entries));
        else this.io.remove(file);
        done.push(file);
        sidecar.dirty = false;
      } catch (error) {
        console.error(`plainwright: pick cache: ${file}: ${errorMessage(error)}`);
      }
    }
    return done;
  }
}

interface UsedPick { ref: PickRef; page: string; entry: PickEntry }
interface PendingPick { ref: PickRef; page: string; entry: PickEntry | null }
/** Entry keys repeat across sidecars, so the source file is part of an attempt's key. */
const usedKey = (ref: PickRef, page: string) => `${entryKey(ref, page)}\0${ref.at.file}`;

/**
 * One attempt's view of the store. Lookups are pure, because an early look may be discarded; the caller reports
 * the pick it kept with hit() or accept(). A step that does not pass stores nothing and evicts its hits.
 * finish(): a passing attempt commits its new entries, a failing one evicts every hit it used.
 */
export class PickAttempt {
  /** Cached picks used by steps that passed. */
  private passedHits = new Map<string, UsedPick>();
  /** Cached picks used by steps that did not pass: always evicted. */
  private failedHits = new Map<string, UsedPick>();
  /** New picks of passed steps, stored if the attempt passes. */
  private pending = new Map<string, PendingPick>();
  private currentStepHits = new Map<string, UsedPick>();
  private currentStepPending = new Map<string, PendingPick>();
  private closed = false;

  constructor(private store: PickStore, readonly reads: boolean, private writes: boolean, private evicts: boolean) {}

  /** The candidate a stored pick matches on this page, or undefined (a miss: Jev picks). */
  lookup(ref: PickRef, candidates: Candidate[], state: PickState): Candidate | undefined {
    if (!this.reads || this.closed) return undefined;
    const entry = this.store.get(ref, pageOf(state));
    return entry && matchEntry(entry, candidates, state, ref.at.templated);
  }

  /** The step acted on a cached pick. */
  hit(ref: PickRef, state: PickState): void {
    const page = pageOf(state);
    const entry = this.store.get(ref, page);
    if (entry && !this.closed) this.currentStepHits.set(usedKey(ref, page), { ref, page, entry });
  }

  /** Jev's high-confidence pick, stored if this step and this attempt pass and its description matches strictly. */
  accept(ref: PickRef, candidate: Candidate, candidates: Candidate[], state: PickState, score: number): void {
    if (!this.writes || this.closed) return;
    const page = pageOf(state);
    this.currentStepPending.set(usedKey(ref, page), { ref, page, entry: makeEntry(candidate, candidates, state, score, ref.at.templated) });
  }

  /** Ends a step; returns a dump of the cached picks this attempt used when the step did not pass. */
  endStep(status: string): string | undefined {
    if (this.closed) return undefined;
    const passed = status === 'pass';
    for (const [key, used] of this.currentStepHits) (passed ? this.passedHits : this.failedHits).set(key, used);
    if (passed) for (const [key, pending] of this.currentStepPending) this.pending.set(key, pending);
    this.currentStepHits.clear();
    this.currentStepPending.clear();
    if (passed) return undefined;
    const used = [...this.passedHits.values(), ...this.failedHits.values()];
    if (!used.length) return undefined;
    return dumpDebug('pick-cache', used.map(({ ref, page, entry }) => ({ sidecar: sidecarPath(ref.at.file), key: entryKey(ref, page), ...entry })));
  }

  /** Commits (passed) or evicts (failed); later calls on this handle do nothing. */
  finish(passed: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const evicted = passed ? this.failedHits : new Map([...this.passedHits, ...this.failedHits, ...this.currentStepHits]);
    if (this.evicts) for (const { ref, page } of evicted.values()) this.store.set(ref, page, null);
    if (this.writes && passed) for (const { ref, page, entry } of this.pending.values()) this.store.set(ref, page, entry);
  }

  get cachedPicks(): number { return this.passedHits.size + this.failedHits.size + this.currentStepHits.size; }
}

/** A failed step names the cached picks its attempt used: `cache: <dump>.json`, which the artifacts observer copies. */
export function withCacheDump(result: StepResult, file: string | undefined): StepResult {
  return file ? { ...result, detail: `${result.detail ? `${result.detail} ` : ''}— cache: ${file}` } : result;
}
