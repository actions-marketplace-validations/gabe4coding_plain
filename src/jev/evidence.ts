import { ask, isTooLong } from './ask.js';

/** Routes observation, not execution: an uncertain route collects the richer evidence. */
export async function evidenceFor(prompts: string[], request = ask): Promise<{ spatial: boolean; tokens: number }> {
  const { spatial, tokens } = await evidenceForGroups([prompts], request);
  return { spatial: spatial[0], tokens };
}

/**
 * Words that can name a physical relation. A prompt in plain ASCII English without any of them cannot request
 * layout, so its route needs no model call. Any doubt (another language, a cue word inside a quoted name) still
 * asks Jev: the list only removes requests whose answer is certain.
 */
const SPATIAL_CUE = new RegExp(`\\b(${[
  'left', 'right', 'above', 'below', 'top', 'bottom', 'upper', 'lower', 'beside', 'between', 'near', 'nearest',
  'nearby', 'next', 'adjacent', 'close', 'closer', 'closest', 'far', 'farther', 'farthest', 'further', 'under',
  'underneath', 'beneath', 'over', 'overlaps?', 'overlapping', 'cover(s|ed|ing)?', 'behind', 'front', 'corners?',
  'edges?', 'sides?', 'cent(er|re|ral)', 'middle', 'align(ed|ment)?', 'first', 'last', 'second', 'third', 'before',
  'after', 'previous', 'preceding', 'following', 'columns?', 'rows?', 'horizontal(ly)?', 'vertical(ly)?', 'east',
  'west', 'north', 'south', '\\w+most', 'higher', 'highest', 'lowest', 'position(ed)?', 'order', 'around', 'beyond',
  'across', 'opposite', 'surrounding', 'end', 'start', 'beginning', 'visual(ly)?',
].join('|')})\\b`, 'i');
const ENGLISH = /\b(the|a|an|is|are|shows?|says|with|of|and|button|field|link|heading|text|message)\b/i;

/** True when the prompt may need rendered geometry and Jev must route it. */
export function maySpatial(prompt: string): boolean {
  return !/^[\x20-\x7e]*$/.test(prompt) || !ENGLISH.test(prompt) || SPATIAL_CUE.test(prompt);
}

/**
 * Independent routes for known prompt groups. Groups without any spatial cue (maySpatial) are semantic without a
 * request; the others are answered in one request (one Choice per group). A token-limit rejection bisects the
 * groups: the answers keep group order, and `used` sees each request's tokens.
 */
export async function evidenceForGroups(groups: string[][], request = ask,
  used?: (tokens: number) => void): Promise<{ spatial: boolean[]; tokens: number }> {
  const asked = groups.filter((group) => group.some(maySpatial));
  if (asked.length === groups.length) return askRoutes(groups, request, used);
  const { spatial, tokens } = await askRoutes(asked, request, used);
  let next = 0;
  return { spatial: groups.map((group) => group.some(maySpatial) ? spatial[next++] : false), tokens };
}

async function askRoutes(groups: string[][], request: typeof ask,
  used?: (tokens: number) => void): Promise<{ spatial: boolean[]; tokens: number }> {
  if (!groups.length) return { spatial: [], tokens: 0 };
  let response;
  try {
    response = await request({ groups }, groups.map((_, index) => ({
      kind: 'choice',
      instructions: `Which observation is required only by the prompts in groups[${index}]? Ignore the other groups. Spatial evidence is required only for physical layout. Lists, feeds, tables and sequences can have earlier, later, first or last items without requesting rendered positions. Words inside names or quoted text do not request layout.`,
      criteria: {
        semantic: 'Text, roles, control state, named groups, values, counts or sequence order suffice: for example, Post 3 or a later post, the first row, the last list item. No physical layout is required.',
        spatial: 'Physical layout is essential: an element left/right of another, above/below, topmost/bottommost, beside, between, nearest/farthest, alignment, overlap or explicit visual order.',
      },
    })));
  } catch (error) {
    if (!isTooLong(error) || groups.length === 1) throw error;
    const middle = Math.ceil(groups.length / 2);
    const halves = await Promise.all([askRoutes(groups.slice(0, middle), request, used),
      askRoutes(groups.slice(middle), request, used)]);
    return { spatial: halves.flatMap((half) => half.spatial), tokens: halves.reduce((sum, half) => sum + half.tokens, 0) };
  }
  const { answers, tokens } = response;
  used?.(tokens);
  const spatial = groups.map((_, index) => {
    const answer = answers[index];
    if (!answer) throw new Error(`Jev returned no evidence route for group ${index}`);
    const score = answer.confidence ?? answer.probabilities?.semantic ?? 0;
    return answer.choice !== 'semantic' || score < 0.9;
  });
  return { spatial, tokens };
}
