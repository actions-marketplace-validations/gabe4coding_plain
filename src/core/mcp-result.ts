import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { decide } from '../jev/decide.js';

/**
 * `data` as structured content (an object, as MCP requires) and as text for older clients. `legacyText` replaces
 * the text where a tool always returned another shape (`apps`: a bare array).
 */
export function jsonResult(data: object, legacyText?: string): CallToolResult {
  const text = JSON.stringify(data);
  return {
    content: [{ type: 'text', text: legacyText ?? text }],
    // Parsed back so in-memory and stdio transports see the same JSON (no `undefined` fields).
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

export const ASK_DESCRIPTION = 'Ask Jev yes/no questions about the current state without acting: 1-16 atomic claims, judged in one call, ' +
  'each its own Noul question with its own probability. answer is yes at p >= 0.9, no at p <= 0.1, else unsure. Optional `within` ' +
  'judges one region only. Read-only: never recorded by save and never changes the session status (use expect for a test assertion). ' +
  'Use it to check hypotheses, e.g. after a failed or inconclusive step: ["An error message is shown", "The Submit button is disabled", ' +
  '"A dialog covers the form"]. It cannot explain in free text; ask one claim per possible cause.';
export const AskClaims = z.array(z.string().min(1)).min(1).max(16);

/** The `ask` tool's per-claim answers, with the state they were judged against summarized. */
export function askResult(claims: string[], probabilities: number[], state: { url: string; title: string; truncated: boolean }) {
  const answers = claims.map((claim, i) => {
    const decision = decide(probabilities[i], 'expect');
    const answer = decision === 'pass' ? 'yes' : decision === 'fail' ? 'no' : 'unsure';
    return { claim, p: Math.round(probabilities[i] * 1000) / 1000, answer };
  });
  const note = state.truncated ? { note: 'state truncated at 60k chars: a "no" may be content that was cut' } : {};
  return { answers, url: state.url, title: state.title, ...note };
}
