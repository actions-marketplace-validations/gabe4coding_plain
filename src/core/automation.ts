import { z } from 'zod';
import { pickElements, judge, decide, isTooLong, describeSnapshot, ask } from '../jev/jev.js';
import { dumpDebug, topGuesses } from './results.js';

// Shared perception boundary. Handles stay inside adapters; only descriptions reach Jev.
// `editable`: a text-entry field (browser only), whose `value=` the pick cache ignores; native candidates never set it.
// `state`: the element's UI state (browser only), for the pick cache's list hash; never sent to Jev.
export const CandidateSchema = z.object({ id: z.number(), desc: z.string(), frameIndex: z.number().optional(), editable: z.boolean().optional(),
  state: z.string().optional() });
export type Candidate = z.infer<typeof CandidateSchema>;
export const SnapshotSchema = z.object({ url: z.string(), title: z.string(), aria: z.string(), truncated: z.boolean() });
export type Snapshot = z.infer<typeof SnapshotSchema>;
/** One native capture: what Jev sees, plus the adapter's handle for each candidate id. */
export interface Frame<T> { snapshot: Snapshot; candidates: Candidate[]; elements: Map<number, T>;
  /** A cheaper view that may also list covered elements (AppiumAdapter.capture on iOS): picks from it are checked. */
  approximate?: boolean; }
/** A pick from an approximate frame is covered or off screen: the caller picks it again from an exact capture. */
export class HiddenTargetError extends Error {
  constructor(what = 'Mobile control') { super(`${what} is not visible (covered or off screen)`); this.name = 'HiddenTargetError'; }
}
export interface TargetAdapter<T> {
  candidates: Candidate[];
  state: { url: string; title: string; goal?: string };
  element(candidate: Candidate): T;
  /** Pick cache (src/pick-cache.ts): the candidate a stored pick strictly matches on this frame, or undefined. Pure. */
  cached?(target: string, index: number): Candidate | undefined;
}
export interface ResolvedTarget<T> {
  element: T | null;
  detail: string;
  tokens: number;
  usedJev: boolean;
  confidence?: number;
  /** What acceptance used: confidence when the provider returned one, else probability. */
  score?: number;
  /** Picked from an approximate frame. */
  approximate?: boolean;
  /** Replayed from the pick cache: no Jev call. */
  cached?: boolean;
  /** The accepted candidate (cached or picked), for the caller to record in the pick cache. */
  candidate?: Candidate;
}
// `ask` is the raw call `read` (src/read.ts) makes; tests inject it with the rest.
export type Intelligence = { pick: typeof pickElements; judge: typeof judge; describe?: typeof describeSnapshot; ask?: typeof ask };
export const intelligence: Intelligence = { pick: pickElements, judge, describe: describeSnapshot, ask };

export async function resolveTargets<T>(adapter: TargetAdapter<T>, targets: string[], ai = intelligence): Promise<ResolvedTarget<T>[]> {
  if (!adapter.candidates.length) return targets.map(() => ({ element: null, detail: 'no candidates', tokens: 0, usedJev: false }));
  // Cache hits act on the stored decision; only the misses go to Jev, in one request as before.
  const hits = targets.map((target, i) => adapter.cached?.(target, i));
  const asked = targets.filter((_, i) => !hits[i]);
  const picks = asked.length ? await ai.pick(adapter.candidates, asked, adapter.state) : [];
  let n = 0;
  return targets.map((target, i) => {
    const hit = hits[i];
    if (hit) return { element: adapter.element(hit), detail: `→ ${hit.desc}`, tokens: 0, usedJev: false, cached: true, candidate: hit };
    const first = n === 0;
    const pick = picks[n++];
    if (!pick) throw new Error('Jev returned fewer picks than targets');
    const { id, probability, confidence, probabilities, tokens } = pick;
    const candidate = adapter.candidates.find((c) => c.id === id);
    const accepted = candidate !== undefined && decide(confidence ?? probability, 'pick') === 'pass';
    const c = confidence === undefined ? '' : ` c=${confidence.toFixed(2)}`;
    const base = { tokens, usedJev: first, confidence, score: confidence ?? probability };
    if (accepted) return { ...base, element: adapter.element(candidate!), candidate, detail: `→ ${candidate!.desc} (p=${probability.toFixed(2)}${c})` };
    const file = dumpDebug('pick', { instruction: target, probabilities, confidence, candidates: adapter.candidates });
    return { ...base, element: null, detail: `${id === null ? 'no matching element' : 'low confidence or invalid candidate'}${c} — top: ${topGuesses(probabilities, adapter.candidates)} — candidates: ${file}` };
  });
}

/**
 * Ask Jev about an early observation while the settled one is still being taken, instead of settle →
 * observe → ask. The early answer is kept only when the settled observation is the same; otherwise the
 * settled one is asked, and the early answer is still awaited so `discard` accounts for its tokens.
 * `early` resolving to null (or throwing) means no early look: observe settled, then ask. `skip`: no
 * question is needed for this observation (the caller already knows the answer); result is then null.
 * The browser has its own variant (settledAsk in steps.ts), which can prove "unchanged" from a DOM
 * mutation clock without a second observation.
 */
export async function askSettled<F, R>(o: {
  early?: () => Promise<F | null>;
  settled: () => Promise<F>;
  same: (a: F, b: F) => boolean;
  ask: (frame: F) => Promise<R>;
  discard: (result: R) => void;
  skip?: (frame: F) => boolean;
  /** Wraps the wait for an answer, for phase timing. */
  waitAnswer?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<{ frame: F; result: R | null; reasked: boolean }> {
  const wait = o.waitAnswer ?? (<T>(fn: () => Promise<T>) => fn());
  const first = o.early ? await o.early().catch(() => null) : null;
  const answer = first !== null && !o.skip?.(first) ? o.ask(first) : null;
  answer?.catch(() => {}); // surfaces below only if this answer is the one used
  const frame = await o.settled();
  if (answer && o.same(first!, frame)) return { frame, result: await wait(() => answer), reasked: false };
  const stale = answer?.then(o.discard, () => {});
  if (o.skip?.(frame)) {
    await stale;
    return { frame, result: null, reasked: answer !== null };
  }
  const [result] = await wait(() => Promise.all([o.ask(frame), stale]));
  return { frame, result, reasked: answer !== null };
}

export async function judgeState(snap: Snapshot, claims: string[], events: string[] = [], ai = intelligence) {
  let aria = snap.aria;
  for (;;) {
    try {
      const result = await ai.judge({ url: snap.url, title: snap.title, aria, events }, claims);
      if (result.probabilities.length !== claims.length) throw new Error('Jev returned fewer judgments than claims');
      return result;
    } catch (err) {
      if (!isTooLong(err) || aria.length < 4000) throw err;
      aria = aria.slice(0, Math.floor(aria.length / 2));
      console.error(`plainwright: state too long for the model, aria cut to ${aria.length} chars — scope the expect with \`within\` for precision`);
    }
  }
}
