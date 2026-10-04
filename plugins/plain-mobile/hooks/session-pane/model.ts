export type Status = 'pass' | 'fail' | 'inconclusive' | 'error' | 'skipped';
export type Engine = 'browser' | 'native';
export type Row = { label: string; status?: Status; tokens: number; detail?: string; dim?: true };
export type Failure = { step: unknown; status: Status; detail?: string; notes?: unknown; url?: string; changed?: unknown };
export type State = { target?: string; goal?: string; rows: Row[]; tokens: number; lastFailure?: Failure };
type Data = Record<string, unknown>;

/** Older rows are dropped, so a long session does not grow the pane without bound. */
export const MAX_ROWS = 200;
const STATUSES: readonly Status[] = ['pass', 'fail', 'inconclusive', 'error', 'skipped'];

export const emptyState = (): State => ({ rows: [], tokens: 0 });

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asStatus = (value: unknown): Status => (STATUSES.includes(value as Status) ? (value as Status) : 'error');
const capped = (rows: Row[]): Row[] => rows.slice(-MAX_ROWS);

/** The JSON object in an MCP result: its structured content, its first text block, or a JSON string. */
export function jsonOf(value: unknown): Data | null {
  if (typeof value === 'string') {
    try {
      return jsonOf(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return jsonOf(value.find((block) => block?.type === 'text')?.text);
  if (!value || typeof value !== 'object') return null;
  const record = value as Data;
  if (record.structuredContent !== undefined) return jsonOf(record.structuredContent);
  if (record.content !== undefined) return jsonOf(record.content);
  return record;
}

/** What a plain tool returned, as `next(e)` hands it to a `tool.call` hook; null when refused or failed. */
export function payload(outcome: unknown): Data | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const { deny, isError, result, text } = outcome as Data;
  if (deny !== undefined || isError) return null;
  if (result && typeof result === 'object' && (result as Data).isError) return null;
  return jsonOf(text) ?? jsonOf(result);
}

/** The words of a step's value: the string itself, or its target/claim field. */
function words(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(words).filter(Boolean).join('; ');
  if (value && typeof value === 'object') {
    const fields = value as Data;
    for (const key of ['target', 'that', 'url', 'to', 'key']) {
      const field = str(fields[key]);
      if (field) return field;
    }
    return words(Object.values(fields).find((field) => typeof field === 'string'));
  }
  return '';
}

/** `click "Save"` from `{ click: "Save" }`: the step kind, then the words naming its target or claim. */
export function stepLabel(step: unknown): string {
  if (!step || typeof step !== 'object') return 'step';
  const entry = Object.entries(step).find(([key]) => key !== 'optional');
  if (!entry) return 'step';
  const [kind, value] = entry;
  const text = words(value);
  return text ? `${kind} "${text}"` : kind;
}

type Outcome = Data & { step: unknown };

/** Adds one row per step outcome; a failing outcome (neither pass nor skipped) becomes the last failure. */
function withSteps(state: State, outcomes: Outcome[], batchChange?: unknown): State {
  let next = state;
  for (const outcome of outcomes) {
    const status = asStatus(outcome.status);
    const tokens = num(outcome.jevTokens);
    const detail = status === 'pass' ? undefined : str(outcome.detail);
    const row: Row = { label: stepLabel(outcome.step), status, tokens, ...(detail ? { detail } : {}) };
    next = {
      ...next,
      target: str(outcome.url) ?? next.target,
      tokens: next.tokens + tokens,
      rows: capped([...next.rows, row]),
      lastFailure: status === 'pass' || status === 'skipped' ? next.lastFailure : {
        step: outcome.step,
        status,
        detail: str(outcome.detail),
        notes: outcome.notes,
        url: str(outcome.url),
        changed: outcome.changed ?? batchChange,
      },
    };
  }
  return next;
}

/** Tools that read without acting: a dim row naming what they read. */
const READS: Record<string, (args: Data) => string | undefined> = {
  ask: (args) => (Array.isArray(args.claims) ? args.claims.join('; ') : undefined),
  read: (args) => str(args.question),
  find: (args) => str(args.target),
  snapshot: (args) => str(args.within),
};

/** The pane state after one plain call: the tool's short name, its arguments and its result JSON. */
export function apply(state: State, engine: Engine, tool: string, args: Data, data: Data): State {
  if (tool === 'open') {
    const target = str(data.url) ?? str(data.name) ?? str(data.app) ?? str(args.url) ?? str(args.app) ?? str(args.device) ?? state.target;
    if (engine === 'native') return { ...emptyState(), target, goal: str(args.goal) };
    const goto: Row = { label: `goto "${str(args.url) ?? target ?? ''}"`, status: 'pass', tokens: 0 };
    return { ...state, target, goal: str(args.goal) ?? state.goal, rows: capped([...state.rows, goto]) };
  }
  if (tool === 'step') return withSteps(state, [{ ...data, step: args.step }]);
  if (tool === 'batch') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const results = Array.isArray(data.results) ? (data.results as Data[]) : [];
    const stepAt = (index: unknown) => (typeof index === 'number' ? steps[index] : undefined);
    return withSteps(state, results.map((result) => ({ ...result, step: stepAt(result.index) })), data.changed);
  }
  const read = READS[tool];
  if (!read) return state;
  const tokens = num(data.jevTokens);
  const what = read(args);
  const row: Row = { label: what ? `${tool} "${what}"` : tool, tokens, dim: true };
  return { ...state, tokens: state.tokens + tokens, rows: capped([...state.rows, row]) };
}

/** Rows that are steps (reads are not), and how many of them passed. */
export function counts(state: State): { steps: number; passed: number } {
  const steps = state.rows.filter((row) => row.status !== undefined);
  return { steps: steps.length, passed: steps.filter((row) => row.status === 'pass').length };
}

/** A spec file name from the flow's goal: `read-the-discussion.yaml`. */
export function saveName(goal: string | undefined): string {
  const slug = (goal ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return `${slug || 'plain-session'}.yaml`;
}
