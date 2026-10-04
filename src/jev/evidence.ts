import { ask, isTooLong } from './ask.js';

/** Routes observation, not execution: an uncertain route collects the richer evidence. */
export async function evidenceFor(prompts: string[], request = ask): Promise<{ spatial: boolean; tokens: number }> {
  const { spatial, tokens } = await evidenceForGroups([prompts], request);
  return { spatial: spatial[0], tokens };
}

/**
 * Independent routes for known prompt groups, answered in one request (one Choice per group). A token-limit
 * rejection bisects the groups: the answers keep group order, and `used` sees each request's tokens.
 */
export async function evidenceForGroups(groups: string[][], request = ask,
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
    const halves = await Promise.all([evidenceForGroups(groups.slice(0, middle), request, used),
      evidenceForGroups(groups.slice(middle), request, used)]);
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
