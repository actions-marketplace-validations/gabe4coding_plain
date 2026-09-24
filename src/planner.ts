import { ask as jevAsk, type Question, type AskAnswer } from './jev.js';

// Turns one spoken or typed sentence ("open Notes, then type milk and eggs in the body and press
// command S") into plan items. Jev never writes text: code proposes the options (where a new
// instruction may start, which action, which words of the sentence), Jev picks, and every argument
// is copied verbatim from what was said.

export type PlanItem =
  | { kind: 'open'; app: string }
  | { kind: 'step'; step: Record<string, unknown>; risky: boolean }
  | { kind: 'ask'; claim: string }
  | { kind: 'stop' }
  | { kind: 'unknown'; text: string; reason: string };
export type Ask = (state: unknown, questions: Question[]) => Promise<{ tokens: number; answers: AskAnswer[] }>;

// Sentence ends and sequencing words always start a new instruction. "and" and commas are ambiguous
// ("type milk and eggs" vs "... and press Enter"), so only those are asked.
const HARD_SPLIT = /(?:[.;!?](?=\s|$)|,?\s+(?:and\s+)?(?:then|after\s+that|next|finally)\b)\s*/i; // not the dot in tom@example.com
const SOFT_SPLIT = /,\s*(?:and\s+)?|\s+and\s+/gi;
const LEAD = /^(?:and\s+then|and|then|after\s+that|next|finally|please|now|ok(?:ay)?)[\s,]+/i;
const MAX_SPAN_WORDS = 14;

const ACTIONS: Record<string, string> = {
  open: 'Launch, open or switch to an application',
  click: 'Click, tap, select or push a control on screen',
  dblclick: 'Double-click something',
  rightclick: 'Right-click something',
  fill: 'Type, write, enter or put text into a field',
  press: 'Press a keyboard key or shortcut',
  scroll: 'Scroll a view up, down, left or right',
  ask: 'Ask a yes/no question about what is on screen, or check whether something is true',
  stop: 'End the session (stop, quit, goodbye)',
  other: 'Another action on the computer that is none of the above, such as deleting, saving or copying something',
  none: 'Not an instruction for the computer',
};

const KEYS: Record<string, string> = {
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  command: 'Meta', cmd: 'Meta', control: 'Control', ctrl: 'Control', option: 'Alt', alt: 'Alt', shift: 'Shift',
};

/** "command a" → "Meta+a", "enter" → "Enter". */
export function keysFrom(spoken: string): string {
  return spoken.toLowerCase().split(/[\s+-]+/).filter((w) => w && !['key', 'the', 'plus'].includes(w))
    .map((w) => KEYS[w] ?? (w.length === 1 ? w : w[0].toUpperCase() + w.slice(1))).join('+');
}

/** Every run of 1..14 consecutive words: the options an argument is picked from. */
export function spans(segment: string, limit = 250): string[] {
  const words = segment.split(/\s+/).map((w) => w.replace(/^["']+|[.,;!?"']+$/g, '')).filter(Boolean);
  const out = new Set<string>();
  for (let n = 1; n <= Math.min(words.length, MAX_SPAN_WORDS); n++)
    for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return [...out].slice(0, limit);
}

/** Hard split in code; the pieces, each with the soft boundaries Jev decides. */
export function candidates(text: string): { piece: string; cuts: [number, number][] }[] {
  return text.split(HARD_SPLIT).map((p) => p.replace(LEAD, '').replace(/^[\s,]+|[\s,]+$/g, '')).filter(Boolean)
    .map((piece) => ({ piece, cuts: [...piece.matchAll(SOFT_SPLIT)].filter((m) => m.index! > 0 && m.index! + m[0].length < piece.length)
      .map((m): [number, number] => [m.index!, m.index! + m[0].length]) }));
}

// Each ambiguous piece gets one Choice among its possible readings (every combination of its soft
// boundaries, rendered as numbered instructions): Jev compares whole readings, so "type salt | pepper
// in the search box" loses to "type salt and pepper in the search box" as a unit.
const MAX_SOFT_CUTS = 6; // 64 readings, under Choice's 255 options

export function readings(piece: string, cuts: [number, number][]): string[][] {
  const used = cuts.slice(0, MAX_SOFT_CUTS);
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << used.length; mask++) {
    const parts: string[] = [];
    let start = 0;
    used.forEach(([a, b], i) => { if (mask & (1 << i)) { parts.push(piece.slice(start, a)); start = b; } });
    parts.push(piece.slice(start));
    out.push(parts.map((p) => p.replace(LEAD, '').trim()).filter(Boolean));
  }
  return out;
}

async function split(text: string, ask: Ask): Promise<{ segments: string[]; tokens: number }> {
  const parts = candidates(text).map(({ piece, cuts }) => ({ piece, options: readings(piece, cuts) }));
  const ambiguous = parts.filter((p) => p.options.length > 1);
  if (!ambiguous.length) return { segments: parts.map((p) => p.piece), tokens: 0 };
  const { tokens, answers } = await ask({ utterance: text, pieces: ambiguous.map((p) => p.piece) }, ambiguous.map((p, i) => ({
    kind: 'choice',
    instructions: `\`pieces[${i}]\` is part of a spoken command for a computer. Which reading splits it into its separate ` +
      'actions correctly? Each action is one thing to do (open, click, type text into a field, press keys, scroll, ask); ' +
      'words that belong to the text to type or to a control\'s name stay together.',
    criteria: Object.fromEntries(p.options.map((r, j) => [`r${j}`, r.map((x, k) => `${k + 1}. ${x}`).join('  ')])),
  })));
  const chosen = new Map(ambiguous.map((p, i) => [p, p.options[Number((answers[i].choice ?? 'r0').slice(1))] ?? p.options[0]]));
  return { segments: parts.flatMap((p) => chosen.get(p) ?? [p.piece]), tokens };
}

const ARGS = {
  target: 'which words name the control or field to act on? For typing, the field typed into, not the text. Keep words like "the" and "button".',
  value: 'if it asks to type or write text, which words are exactly the text to type?',
  app: 'if it asks to open or switch to an application, which words name the application?',
  keys: 'if it asks to press keys, which words name the key or shortcut?',
} as const;

// One request for every segment: the action, speculative argument spans for every action it could be,
// the scroll direction and whether it is hard to undo. Code keeps only the answers the action uses.
async function route(segments: string[], ask: Ask): Promise<{ items: PlanItem[]; tokens: number }> {
  const questions: Question[] = [];
  const index: Record<string, number>[] = [];
  const options = segments.map((seg) => Object.fromEntries(spans(seg).map((sp, j) => [`s${j}`, sp])));
  segments.forEach((_, i) => {
    const at: Record<string, number> = {};
    const add = (key: string, q: Question) => { at[key] = questions.push(q) - 1; };
    add('action', { kind: 'choice', instructions: `What does \`segments[${i}]\` ask the computer to do?`, criteria: ACTIONS });
    for (const [key, what] of Object.entries(ARGS))
      add(key, { kind: 'choice', instructions: `In \`segments[${i}]\` (a spoken computer command), ${what} Answer with the exact words, or none.`,
        criteria: { ...options[i], none: 'No such words' } });
    add('dir', { kind: 'choice', instructions: `If \`segments[${i}]\` asks to scroll, in which direction?`,
      criteria: { up: 'Up', down: 'Down', left: 'Left', right: 'Right', none: 'Not a scroll' } });
    add('risky', { kind: 'boolean', instructions: `Would doing \`segments[${i}]\` send, publish, pay, buy, delete or otherwise do something hard to undo?` });
    index.push(at);
  });
  const { tokens, answers } = await ask({ segments }, questions);
  const items = segments.map((seg, i): PlanItem => {
    const a = (key: string) => answers[index[i][key]];
    // No confidence gate on spans: overlapping options ("the OK button", "OK button") split the
    // probability between equally good answers, so a low confidence is not a doubtful pick.
    const pick = (key: string) => {
      const { choice } = a(key);
      return choice === undefined || choice === 'none' ? undefined : options[i][choice];
    };
    const action = a('action');
    const kind = (action.confidence ?? 1) >= 0.5 ? action.choice : 'unsure';
    const risky = (a('risky').probability ?? 0) >= 0.5;
    const unknown = (reason: string): PlanItem => ({ kind: 'unknown', text: seg, reason });
    switch (kind) {
      case 'stop': return { kind: 'stop' };
      case 'open': { const app = pick('app')?.replace(/\s+app$/i, ''); return app ? { kind: 'open', app } : unknown('no application named'); }
      case 'ask': {
        const claim = seg.replace(/^(check|verify|see|tell me)\s+(if|whether|that)\s+/i, '');
        return { kind: 'ask', claim: claim !== seg || seg.endsWith('?') ? claim : `${seg}?` };
      }
      case 'click': case 'dblclick': case 'rightclick': {
        const target = pick('target');
        return target ? { kind: 'step', step: { [kind]: target }, risky } : unknown('no control named');
      }
      case 'fill': {
        const target = pick('target'), value = pick('value');
        return target && value ? { kind: 'step', step: { fill: { target, value } }, risky } : unknown('say the text and the field');
      }
      case 'press': { const k = pick('keys'); return k ? { kind: 'step', step: { press: keysFrom(k) }, risky } : unknown('no key named'); }
      case 'scroll': {
        const dir = a('dir').choice;
        return dir && dir !== 'none' ? { kind: 'step', step: { scroll: `${dir}: ${pick('target') ?? 'the window'}` }, risky: false } : unknown('no direction');
      }
      case 'other': return unknown('say which button or key does it');
      case 'unsure': return unknown('not sure what to do');
      default: return unknown('not an instruction');
    }
  });
  return { items, tokens };
}

/** Two Jev requests: where the sentence splits, then every piece's action and arguments. */
export async function plan(text: string, ask: Ask = jevAsk): Promise<{ items: PlanItem[]; tokens: number }> {
  const { segments, tokens: t1 } = await split(text.trim(), ask);
  if (!segments.length) return { items: [], tokens: t1 };
  const { items, tokens: t2 } = await route(segments, ask);
  return { items, tokens: t1 + t2 };
}
