import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dumpDebug } from './results.js';
/**
 * Pick cache (docs/running.md "Pick cache"): a target Jev picked in a passing run is replayed without a Jev
 * call while the page still has exactly one candidate with the same description. Jev decided once; code
 * only reuses that decision on a strict match. One sidecar per source file (`login.yaml` → `login.picks.json`),
 * committed next to the specs. Attempt > 0 never reads; a failed attempt evicts the entries it used.
 */
export const PICK_FILE_VERSION = 1;
/** Bump whenever describe() / candidates() (src/candidates.ts) or a native adapter's candidate desc changes. */
export const DESC_FORMAT = 1;
export const PICKS_MODES = ['on', 'read', 'off'];
export const sidecarPath = (file) => {
    const { dir, name } = path.parse(file);
    return path.join(dir, `${name}.picks.json`);
};
export const entryKey = (ref) => `${ref.at.index}|${ref.kind}|${ref.target}|${ref.goal ?? ''}`;
/** The desc without `value="…"`: a fill changes it, the element stays the same. Browser values are raw, native ones JSON. */
export const normalizeDesc = (desc) => desc.replace(/ value="(?:[^"\\]|\\.)*"/g, '');
/** The iframe label candidates.ts prefixes, or '' for the main frame. */
export const frameOf = (desc) => /^\[iframe ([^\]]*)\] /.exec(desc)?.[1] ?? '';
/** ` #n`: one of several identical descs, by DOM order; a list that changes makes it name another row. */
export const hasOrdinal = (desc) => / #\d+(?= context: |$)/.test(desc);
export const hasContext = (desc) => desc.includes(' context: ');
export const listHash = (candidates) => createHash('sha1').update(candidates.map((c) => normalizeDesc(c.desc)).join('\n')).digest('hex');
/** origin + path; query and hash ignored. A desktop url carries the process id, which changes every launch: the app name stands in. */
export function pageOf(state) {
    try {
        const url = new URL(state.url);
        if (url.protocol === 'desktop:')
            return `desktop://${state.title}`;
        return url.origin !== 'null' ? `${url.origin}${url.pathname}` : `${url.protocol}//${url.host}${url.pathname}`;
    }
    catch {
        return state.url;
    }
}
/** The entry an accepted pick becomes, or null when it must never be stored. */
export function makeEntry(candidate, candidates, state) {
    if (hasOrdinal(candidate.desc))
        return null;
    const desc = normalizeDesc(candidate.desc);
    // Unique on this page, or the same page would already miss (two inputs that differ only by value).
    if (candidates.filter((c) => normalizeDesc(c.desc) === desc).length !== 1)
        return null;
    const entry = { desc, frame: frameOf(candidate.desc), page: pageOf(state) };
    if (!hasContext(candidate.desc))
        entry.list = listHash(candidates);
    return entry;
}
/** The one candidate a stored entry matches on this page, or undefined: same page, (same list,) exactly one equal desc. */
export function match(entry, candidates, state) {
    if (pageOf(state) !== entry.page)
        return undefined;
    if (entry.list !== undefined && listHash(candidates) !== entry.list)
        return undefined;
    const found = candidates.filter((c) => normalizeDesc(c.desc) === entry.desc && frameOf(c.desc) === entry.frame);
    return found.length === 1 ? found[0] : undefined;
}
const isEntry = (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v))
        return false;
    const e = v;
    return typeof e.desc === 'string' && typeof e.frame === 'string' && typeof e.page === 'string' && (e.list === undefined || typeof e.list === 'string');
};
/** The entries of a sidecar's text, or null when it is unreadable or was written for another model or desc format. */
export function parseFile(text, model) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (raw === null || typeof raw !== 'object')
        return null;
    const file = raw;
    if (file.version !== PICK_FILE_VERSION || file.model !== model || file.desc !== DESC_FORMAT)
        return null;
    if (file.entries === null || typeof file.entries !== 'object' || Array.isArray(file.entries))
        return null;
    const out = new Map();
    for (const [key, value] of Object.entries(file.entries))
        if (isEntry(value))
            out.set(key, value);
    return out;
}
// Step index first (numerically), then the rest: the file reads in step order.
const byKey = (a, b) => {
    const [ia, ib] = [parseInt(a, 10), parseInt(b, 10)];
    return ia !== ib ? ia - ib : a < b ? -1 : a > b ? 1 : 0;
};
/** Deterministic sidecar text: keys sorted, 2-space JSON, trailing newline, no timestamps. */
export function formatFile(model, entries) {
    const sorted = {};
    for (const key of [...entries.keys()].sort(byKey)) {
        const e = entries.get(key);
        sorted[key] = { desc: e.desc, frame: e.frame, page: e.page, ...(e.list === undefined ? {} : { list: e.list }) };
    }
    return JSON.stringify({ version: PICK_FILE_VERSION, model, desc: DESC_FORMAT, entries: sorted }, null, 2) + '\n';
}
export const fileIO = {
    read: (file) => { try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    } },
    write: (file, text) => fs.writeFileSync(file, text),
    remove: (file) => fs.rmSync(file, { force: true }),
};
/** One per run: every sidecar read once, changed in memory as attempts finish, written once by write(). */
export class PickStore {
    mode;
    model;
    io;
    files = new Map();
    constructor(mode, model, io = fileIO) {
        this.mode = mode;
        this.model = model;
        this.io = io;
    }
    sidecar(source) {
        const file = sidecarPath(source);
        let car = this.files.get(file);
        if (!car) {
            const text = this.io.read(file);
            car = { entries: (text === undefined ? null : parseFile(text, this.model)) ?? new Map(), dirty: false };
            this.files.set(file, car);
        }
        return car;
    }
    get(ref) { return this.sidecar(ref.at.file).entries.get(entryKey(ref)); }
    set(ref, entry) {
        const car = this.sidecar(ref.at.file), key = entryKey(ref), old = car.entries.get(key);
        if (entry === null) {
            if (old) {
                car.entries.delete(key);
                car.dirty = true;
            }
            return;
        }
        if (old && JSON.stringify(old) === JSON.stringify(entry))
            return;
        car.entries.set(key, entry);
        car.dirty = true;
    }
    /** A handle for one attempt of one spec. */
    attempt(attempt) { return new PickAttempt(this, this.mode !== 'off' && attempt === 0, this.mode !== 'off'); }
    /** Writes every changed sidecar (`on` only); a sidecar left with no entries is deleted. Returns the files written or deleted. */
    write() {
        if (this.mode !== 'on')
            return [];
        const done = [];
        for (const [file, car] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
            if (!car.dirty)
                continue;
            try {
                if (car.entries.size)
                    this.io.write(file, formatFile(this.model, car.entries));
                else
                    this.io.remove(file);
                done.push(file);
                car.dirty = false;
            }
            catch (error) {
                console.error(`plainwright: pick cache: ${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return done;
    }
}
/**
 * One attempt's view of the store. Lookups are pure (an early look may be discarded); the caller reports
 * the pick it kept with hit()/accept(). Per step: a step that does not pass stores nothing and evicts its
 * hits. finish(): a passing attempt commits its pending entries, a failing one evicts every hit it used.
 */
export class PickAttempt {
    store;
    reads;
    writes;
    hits = new Map();
    evict = new Map();
    pending = new Map();
    stepHits = new Map();
    stepPending = new Map();
    closed = false;
    constructor(store, reads, writes) {
        this.store = store;
        this.reads = reads;
        this.writes = writes;
    }
    /** The candidate a stored pick matches on this page, or undefined (a miss: Jev picks). */
    lookup(ref, candidates, state) {
        if (!this.reads || this.closed || !this.store)
            return undefined;
        const entry = this.store.get(ref);
        return entry && match(entry, candidates, state);
    }
    /** The step acted on a cached pick. */
    hit(ref) {
        const entry = this.store?.get(ref);
        if (entry && !this.closed)
            this.stepHits.set(entryKey(ref) + '\0' + ref.at.file, { ref, entry });
    }
    /** Jev's accepted pick, stored if this step and this attempt pass (and the desc can be matched strictly). */
    accept(ref, candidate, candidates, state) {
        if (!this.writes || this.closed)
            return;
        this.stepPending.set(entryKey(ref) + '\0' + ref.at.file, { ref, entry: makeEntry(candidate, candidates, state) });
    }
    /** Ends a step; returns a dump of the cached picks this attempt used when the step did not pass. */
    endStep(status) {
        if (this.closed)
            return undefined;
        const passed = status === 'pass';
        for (const [k, v] of this.stepHits)
            (passed ? this.hits : this.evict).set(k, v);
        if (passed)
            for (const [k, v] of this.stepPending)
                this.pending.set(k, v);
        this.stepHits.clear();
        this.stepPending.clear();
        if (passed)
            return undefined;
        const used = [...this.hits.values(), ...this.evict.values()];
        if (!used.length)
            return undefined;
        return dumpDebug('pick-cache', used.map(({ ref, entry }) => ({ sidecar: sidecarPath(ref.at.file), key: entryKey(ref), ...entry })));
    }
    /** Commits (passed) or evicts (failed); later calls on this handle do nothing. */
    finish(passed) {
        if (this.closed)
            return;
        this.closed = true;
        if (!this.store || !this.writes)
            return;
        const evicted = passed ? this.evict : new Map([...this.hits, ...this.evict, ...this.stepHits]);
        for (const { ref } of evicted.values())
            this.store.set(ref, null);
        if (passed)
            for (const { ref, entry } of this.pending.values())
                this.store.set(ref, entry);
    }
    /** Picks this attempt replayed from the cache so far. */
    get cachedPicks() { return this.hits.size + this.evict.size + this.stepHits.size; }
}
/** A handle that never reads or stores (MCP sessions, cache `off`). */
export const noPicks = () => new PickAttempt(null, false, false);
/** A step that did not pass after its attempt used cached picks names them: `cache: <dump>.json` (the artifacts observer copies it). */
export function withCacheDump(result, file) {
    return file ? { ...result, detail: `${result.detail ? `${result.detail} ` : ''}— cache: ${file}` } : result;
}
