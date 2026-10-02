import { ask } from './ask.js';

/** One Noul question per claim, all in one request. */
export async function judge(state: unknown, claims: string[]): Promise<{ probabilities: number[]; tokens: number }> {
  const { tokens, answers } = await ask(state, claims.map((claim) => ({ kind: 'boolean', instructions: claim })));
  return { probabilities: answers.map((answer) => answer.probability ?? 0), tokens };
}
