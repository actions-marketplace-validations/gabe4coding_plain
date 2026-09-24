import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StepKind } from './step-kind.js';
export const StatusSchema = z.enum(['pass', 'fail', 'inconclusive', 'error', 'skipped']);
export const StepResultSchema = z.object({
    step: z.string(),
    status: StatusSchema,
    detail: z.string().optional(),
    ms: z.record(z.string(), z.number()).optional(),
});
/** Adds the elapsed ms of `fn` into ms[phase]; phases accumulate across calls within one step. */
export async function timedInto(ms, phase, fn) {
    const start = Date.now();
    try {
        return await fn();
    }
    finally {
        ms[phase] = (ms[phase] ?? 0) + (Date.now() - start);
    }
}
// Formats a step's `ms` phase timings for --timing output, e.g. "total=3985 settle=512 jev=1830" —
// `total` first (if present), then the rest in insertion order, only phases actually recorded.
export function formatMs(ms) {
    const keys = Object.keys(ms);
    const ordered = keys.includes('total') ? ['total', ...keys.filter((k) => k !== 'total')] : keys;
    return ordered.map((k) => `${k}=${ms[k]}`).join(' ');
}
export function label(step) {
    switch (step.kind) {
        case StepKind.goto:
            return `goto ${step.url}`;
        case StepKind.fill:
            return `fill "${step.target}"`;
        case StepKind.click:
            return `click "${step.target}"`;
        case StepKind.hover:
            return `hover "${step.target}"`;
        case StepKind.dblclick:
            return `dblclick "${step.target}"`;
        case StepKind.rightclick:
            return `rightclick "${step.target}"`;
        case StepKind.select:
            return `select "${step.value}" in "${step.target}"`;
        case StepKind.check:
            return `check "${step.target}"`;
        case StepKind.uncheck:
            return `uncheck "${step.target}"`;
        case StepKind.upload:
            return `upload ${step.files.length} file(s) to "${step.target}"`;
        case StepKind.scroll:
            return `scroll "${step.target}"`;
        case StepKind.wait:
            return `wait "${step.condition}"`;
        case StepKind.press:
            return `press ${step.key}`;
        case StepKind.drag:
            return `drag "${step.source}" to "${step.target}"`;
        case StepKind.mouse:
            return `mouse to (${step.x}, ${step.y})`;
        case StepKind.expect: {
            const claim = step.expectations.length > 1 ? step.expectations.join(' | ') : step.expectations[0];
            return step.within ? `expect "${claim}" within "${step.within}"` : `expect "${claim}"`;
        }
    }
}
let dumpSeq = 0;
/** Dump debug data to a temp file for a rejection/timeout/fail detail line, and return its path. */
export function dumpDebug(kind, data) {
    const dir = path.join(os.tmpdir(), 'plainwright');
    fs.mkdirSync(dir, { recursive: true });
    // pid + a per-process counter: concurrent specs must not overwrite each other's dump.
    const file = path.join(dir, `${Date.now()}-${process.pid}-${++dumpSeq}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}
/** Top 3 candidates by probability, formatted for a pick-rejection detail line. */
export function topGuesses(probabilities, candidates) {
    return Object.entries(probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, p]) => `${k === 'none' ? 'none' : candidates.find((c) => String(c.id) === k)?.desc} (p=${p.toFixed(2)})`)
        .join(' | ');
}
