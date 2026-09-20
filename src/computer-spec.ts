import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { parseStep, resolveEnvBlock, type Step } from './spec.js';

export const ComputerTargetSchema = z.object({ app: z.string().trim().min(1).optional(), pid: z.number().int().positive().optional() })
  .refine((v) => (v.app !== undefined) !== (v.pid !== undefined), 'provide exactly one of app or pid');
const supported = new Set(['click', 'fill', 'hover', 'dblclick', 'rightclick', 'check', 'uncheck', 'scroll', 'press', 'drag', 'mouse', 'wait', 'expect']);
export function parseComputerStep(raw: unknown, where = 'computer', index = 0): Step {
  const step = parseStep(where, index, raw);
  if (!supported.has(step.kind)) throw new Error(`${step.kind} is browser-only; desktop supports ${[...supported].join(', ')}`);
  const targets = ['target', 'source', 'within', 'condition'].flatMap((key) => key in step ? [String((step as unknown as Record<string, unknown>)[key])] : []);
  if (targets.some((v) => v.startsWith('css='))) throw new Error('css= is browser-only; describe a desktop accessibility element');
  if (step.kind === 'scroll' && !/^(up|down):\s*\S/.test(step.target)) throw new Error('Desktop scroll syntax: "down: the results list" or "up: the editor"');
  return step;
}
export interface ComputerSpec {
  name: string;
  app: string;
  dir: string;
  hooks?: string;
  env: Record<string, unknown>;
  steps: Step[];
}
export function loadComputerSpec(file: string): ComputerSpec {
  const raw = z.object({
    name: z.string().min(1), app: z.string().min(1), hooks: z.string().min(1).optional(),
    env: z.record(z.string(), z.unknown()).default({}), steps: z.array(z.unknown()).min(1),
  }).strict().parse(parse(readFileSync(file, 'utf8')));
  return { ...raw, dir: dirname(resolve(file)), hooks: raw.hooks ? resolve(dirname(file), raw.hooks) : undefined,
    env: resolveEnvBlock(file, 'env', raw.env), steps: raw.steps.map((s, i) => parseComputerStep(s, file, i)) };
}
