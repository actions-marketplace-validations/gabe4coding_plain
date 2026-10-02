import { ask, choiceChunks, isTooLong, MAX_CHOICE_OPTIONS } from './ask.js';
import { decide } from './decide.js';
/** At most four parallel requests per pick. Candidates are ordered so that a cut drops nav and footer links first. */
export const MAX_CANDIDATES = MAX_CHOICE_OPTIONS * 4;
/** One answer per instruction. Past MAX_CHOICE_OPTIONS, equal chunks are asked in parallel and merged. */
export async function pickElements(candidates, instructions, page, askChunk = pickChunk) {
    if (candidates.length <= MAX_CHOICE_OPTIONS)
        return pickSplittingWhenTooLong(candidates, instructions, page, askChunk);
    return mergePicks(await Promise.all(choiceChunks(candidates).map((chunk) => pickSplittingWhenTooLong(chunk, instructions, page, askChunk))));
}
/** Long descriptions can put even a short list over the token limit: then each half is asked, and merged. */
async function pickSplittingWhenTooLong(candidates, instructions, page, askChunk) {
    try {
        return await askChunk(candidates, instructions, page);
    }
    catch (error) {
        if (!isTooLong(error) || candidates.length < 2)
            throw error;
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
async function pickChunk(candidates, instructions, page) {
    const criteria = { none: 'No listed element matches the instruction' };
    for (const candidate of candidates)
        criteria[String(candidate.id)] = candidate.desc;
    const state = {
        url: page.url,
        title: page.title,
        today: new Date().toISOString().slice(0, 10),
        ...(page.goal ? { goal: page.goal } : {}),
        instructions,
        // `editable` and `state` are for the pick cache only: Jev never sees them.
        elements: candidates.map(({ id, desc, frameIndex }) => (frameIndex === undefined ? { id, desc } : { id, desc, frameIndex })),
    };
    const questions = instructions.map((_, i) => ({
        kind: 'choice',
        instructions: `Which element does \`instructions[${i}]\` refer to? Pick \`none\` if no listed element matches.`,
        criteria,
    }));
    const { tokens, answers } = await ask(state, questions);
    return answers.map(({ choice: picked, probabilities, confidence }, i) => ({
        id: picked === 'none' ? null : Number(picked),
        probability: probabilities?.[picked] ?? 0,
        confidence,
        probabilities: probabilities ?? {},
        tokens: i === 0 ? tokens : 0,
    }));
}
/**
 * Merges per-chunk answers into one result per instruction. Ids are unique across chunks, so the probability
 * maps combine; `none` comes from the winning chunk. When several chunks are each sure of a different element,
 * the score is split between them, as one question over all candidates would have done: the pick then stays
 * below acceptance and the detail shows every guess.
 */
export function mergePicks(perChunk) {
    const score = (result) => result.confidence ?? result.probability;
    const tokens = perChunk.reduce((sum, results) => sum + results[0].tokens, 0);
    return perChunk[0].map((_, i) => {
        const answers = perChunk.map((results) => results[i]);
        const found = answers.filter((answer) => answer.id !== null).sort((a, b) => score(b) - score(a));
        // All `none`: the least sure chunk has the most telling guesses for the detail line.
        const best = found[0] ?? [...answers].sort((a, b) => score(a) - score(b))[0];
        const probabilities = {};
        for (const answer of answers) {
            for (const [key, probability] of Object.entries(answer.probabilities))
                if (key !== 'none')
                    probabilities[key] = probability;
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
