import { ask } from './ask.js';
/** One Noul question per claim, all in one request. */
export async function judge(state, claims) {
    const { tokens, answers } = await ask(state, claims.map((claim) => ({ kind: 'boolean', instructions: claim })));
    return { probabilities: answers.map((answer) => answer.probability ?? 0), tokens };
}
