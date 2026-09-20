import { z } from 'zod';
import { pickElements, judge, decide, isTooLong } from './jev.js';
import { dumpDebug, topGuesses } from './results.js';
// Shared perception boundary. Handles stay inside adapters; only descriptions reach Jev.
export const CandidateSchema = z.object({ id: z.number(), desc: z.string(), frameIndex: z.number().optional() });
export const SnapshotSchema = z.object({ url: z.string(), title: z.string(), aria: z.string(), truncated: z.boolean() });
export const intelligence = { pick: pickElements, judge };
export async function resolveTargets(adapter, targets, ai = intelligence) {
    if (!adapter.candidates.length)
        return targets.map(() => ({ element: null, detail: 'no candidates', tokens: 0, usedJev: false }));
    const picks = await ai.pick(adapter.candidates, targets, adapter.state);
    return targets.map((target, i) => {
        const pick = picks[i];
        if (!pick)
            throw new Error('Jev returned fewer picks than targets');
        const { id, probability, confidence, probabilities, tokens } = pick;
        const candidate = adapter.candidates.find((c) => c.id === id);
        const accepted = candidate !== undefined && decide(confidence ?? probability, 'pick') === 'pass';
        const c = confidence === undefined ? '' : ` c=${confidence.toFixed(2)}`;
        const base = { tokens, usedJev: i === 0, confidence };
        if (accepted)
            return { ...base, element: adapter.element(candidate), detail: `→ ${candidate.desc} (p=${probability.toFixed(2)}${c})` };
        const file = dumpDebug('pick', { instruction: target, probabilities, confidence, candidates: adapter.candidates });
        return { ...base, element: null, detail: `${id === null ? 'no matching element' : 'low confidence or invalid candidate'}${c} — top: ${topGuesses(probabilities, adapter.candidates)} — candidates: ${file}` };
    });
}
export async function judgeState(snap, claims, events = [], ai = intelligence) {
    let aria = snap.aria;
    for (;;) {
        try {
            const result = await ai.judge({ url: snap.url, title: snap.title, aria, events }, claims);
            if (result.probabilities.length !== claims.length)
                throw new Error('Jev returned fewer judgments than claims');
            return result;
        }
        catch (err) {
            if (!isTooLong(err) || aria.length < 4000)
                throw err;
            aria = aria.slice(0, Math.floor(aria.length / 2));
            console.error(`plainwright: state too long for the model, aria cut to ${aria.length} chars — scope the expect with \`within\` for precision`);
        }
    }
}
