import type { Candidate } from '../core/automation.js';
import { ask, choiceChunks, isTooLong, MAX_CHOICE_OPTIONS, type Question } from './ask.js';
import { decide } from './decide.js';
import { boundsText, roundBounds } from '../core/layout.js';

/** At most four parallel requests per pick. Candidates are ordered so that a cut drops nav and footer links first. */
export const MAX_CANDIDATES = MAX_CHOICE_OPTIONS * 4;

export interface PickResult {
  id: number | null;
  /** Probability of the chosen option. */
  probability: number;
  /** TypeSafe Choice confidence; absent on the gateway. */
  confidence?: number;
  probabilities: Record<string, number>;
  /** The whole request's tokens on the first result, 0 on the others. */
  tokens: number;
}

/** What a pick knows about the page, plus the flow's goal when the spec or the MCP session has one. */
export interface PickPage {
  url: string;
  title: string;
  goal?: string;
  /**
   * Read-only layout on a spatial route: it shows references a target names that are not candidates. Every chunk
   * and the runoff receive it.
   */
  layout?: string;
  /** The coordinate space of candidate bounds; the browser's main viewport when absent. */
  coordinates?: string;
}

type AskChunk = (candidates: Candidate[], instructions: string[], page: PickPage) => Promise<PickResult[]>;

/**
 * One answer per instruction. Past MAX_CHOICE_OPTIONS, equal chunks are asked in parallel and merged. When two
 * or more chunks are each sure of a different element, no chunk saw the others' choice: one more question over
 * only those finalists settles it, as one question over all candidates would have.
 */
export async function pickElements(candidates: Candidate[], instructions: string[], page: PickPage,
  askChunk: AskChunk = pickChunk): Promise<PickResult[]> {
  if (candidates.length <= MAX_CHOICE_OPTIONS) return pickSplittingWhenTooLong(candidates, instructions, page, askChunk);
  const perChunk = await Promise.all(choiceChunks(candidates).map((chunk) => pickSplittingWhenTooLong(chunk, instructions, page, askChunk)));
  return Promise.all(mergePicks(perChunk).map(async (merged, i) => {
    const finalists = new Set(perChunk.map((results) => results[i])
      .filter((answer) => answer.id !== null && decide(score(answer), 'pick') === 'pass').map((answer) => answer.id));
    if (finalists.size < 2) return merged;
    const [runoff] = await pickSplittingWhenTooLong(candidates.filter((candidate) => finalists.has(candidate.id)),
      [instructions[i]], page, askChunk);
    return { ...runoff, tokens: merged.tokens + runoff.tokens };
  }));
}

const score = (result: PickResult) => result.confidence ?? result.probability;

/** Long descriptions can put even a short list over the token limit: then each half is asked, and merged. */
async function pickSplittingWhenTooLong(candidates: Candidate[], instructions: string[], page: PickPage,
  askChunk: AskChunk): Promise<PickResult[]> {
  try {
    return await askChunk(candidates, instructions, page);
  } catch (error) {
    if (!isTooLong(error) || candidates.length < 2) throw error;
    const half = Math.ceil(candidates.length / 2);
    const halves = [candidates.slice(0, half), candidates.slice(half)];
    return mergePicks(await Promise.all(halves.map((part) => pickSplittingWhenTooLong(part, instructions, page, askChunk))));
  }
}

/**
 * One Choice question per instruction, all in one request. The descriptions are in both `elements` and the
 * criteria on purpose: sending them only once saves tokens but lowers the pick probability.
 * `instructions` are a list in the state, plus `today`, so "the earliest day after today" has one answer.
 * `goal` is state only, never named in the question: the target's words still win when they disagree with it.
 */
async function pickChunk(candidates: Candidate[], instructions: string[], page: PickPage): Promise<PickResult[]> {
  const criteria: Record<string, string> = { none: 'No listed element matches the instruction' };
  const coordinates = page.coordinates ?? 'main viewport CSS pixels';
  for (const candidate of candidates) criteria[String(candidate.id)] = candidate.desc +
    (candidate.bounds ? ` bounds=${boundsText(candidate.bounds)} (${coordinates}; tree order is not visual order)` : '');

  const state = {
    url: page.url,
    title: page.title,
    today: new Date().toISOString().slice(0, 10),
    ...(page.goal ? { goal: page.goal } : {}),
    ...(page.layout ? { layout: page.layout } : {}),
    ...(candidates.some((candidate) => candidate.bounds) ? {
      geometry: `Bounds are rendered edges in ${coordinates}. x increases right and y increases down. Equal vertical bounds are neither above nor below each other. Use bounds for physical relations, not tree order. Missing required geometry cannot establish a spatial match.`,
    } : {}),
    instructions,
    // `editable` and `state` are for the pick cache only: Jev never sees them.
    elements: candidates.map(({ id, desc, frameIndex, bounds }) => ({ id, desc,
      ...(frameIndex === undefined ? {} : { frameIndex }), ...(bounds ? { bounds: roundBounds(bounds) } : {}) })),
  };
  const questions: Question[] = instructions.map((_, i) => ({
    kind: 'choice',
    instructions: `Which element does \`instructions[${i}]\` refer to? Pick \`none\` if no listed element matches.`,
    criteria,
  }));
  const { tokens, answers } = await ask(state, questions);

  return answers.map(({ choice: picked, probabilities, confidence }, i) => ({
    id: picked === 'none' ? null : Number(picked),
    probability: probabilities?.[picked!] ?? 0,
    confidence,
    probabilities: probabilities ?? {},
    tokens: i === 0 ? tokens : 0,
  }));
}

/**
 * Merges per-chunk answers into one result per instruction. Ids are unique across chunks, so the probability
 * maps combine; `none` comes from the winning chunk. When several chunks are each sure of a different element,
 * the score is split between them, so the pick stays below acceptance and the detail shows every guess; a split
 * from chunking is then settled by pickElements' runoff.
 */
export function mergePicks(perChunk: PickResult[][]): PickResult[] {
  const tokens = perChunk.reduce((sum, results) => sum + results[0].tokens, 0);
  return perChunk[0].map((_, i) => {
    const answers = perChunk.map((results) => results[i]);
    const found = answers.filter((answer) => answer.id !== null).sort((a, b) => score(b) - score(a));
    // All `none`: the least sure chunk has the most telling guesses for the detail line.
    const best = found[0] ?? [...answers].sort((a, b) => score(a) - score(b))[0];
    const probabilities: Record<string, number> = {};
    for (const answer of answers) {
      for (const [key, probability] of Object.entries(answer.probabilities)) if (key !== 'none') probabilities[key] = probability;
    }
    probabilities.none = best.probabilities.none ?? 0;
    const confidentChunks = Math.max(1, found.filter((answer) => decide(score(answer), 'pick') === 'pass').length);
    return {
      id: best.id,
      probability: best.probability / confidentChunks,
      confidence: best.confidence === undefined ? undefined : best.confidence / confidentChunks,
      probabilities,
      tokens: i === 0 ? tokens : 0,
    };
  });
}
