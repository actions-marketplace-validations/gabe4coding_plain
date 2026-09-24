import { z } from 'zod';
import { decide } from './jev.js';
// MCP 2025-11-25 requires an object for structuredContent. Keep the text copy for
// older clients; apps supplies its historical bare-array text representation.
export function jsonResult(data, legacyText) {
    const text = JSON.stringify(data);
    return {
        content: [{ type: 'text', text: legacyText ?? text }],
        // Apply the same JSON normalization on in-memory and stdio transports (e.g. undefined).
        structuredContent: JSON.parse(text),
    };
}
export const ASK_DESCRIPTION = 'Ask Jev yes/no questions about the current state without acting: 1-16 atomic claims, judged in one call, ' +
    'each its own Noul question with its own probability. answer is yes at p >= 0.9, no at p <= 0.1, else unsure. Optional `within` ' +
    'judges one region only. Read-only: never recorded by save and never changes the session status (use expect for a test assertion). ' +
    'Use it to check hypotheses, e.g. after a failed or inconclusive step: ["An error message is shown", "The Submit button is disabled", ' +
    '"A dialog covers the form"]. It cannot explain in free text; ask one claim per possible cause.';
export const AskClaims = z.array(z.string().min(1)).min(1).max(16);
/** The `ask` tool's per-claim answers, with the state they were judged against summarized. */
export function askResult(claims, probabilities, state) {
    const answers = claims.map((claim, i) => {
        const d = decide(probabilities[i], 'expect');
        return { claim, p: Math.round(probabilities[i] * 1000) / 1000, answer: d === 'pass' ? 'yes' : d === 'fail' ? 'no' : 'unsure' };
    });
    return { answers, url: state.url, title: state.title, ...(state.truncated ? { note: 'state truncated at 60k chars: a "no" may be content that was cut' } : {}) };
}
