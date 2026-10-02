import { z } from 'zod';
import { parseStep, rejectCss, loadNativeSpec, TagsSchema, type LoadOptions, type Step } from '../core/spec.js';

export const ComputerTargetSchema = z.object({ app: z.string().trim().min(1).optional(), pid: z.number().int().positive().optional() })
  .refine((target) => (target.app !== undefined) !== (target.pid !== undefined), 'provide exactly one of app or pid');

const SUPPORTED = new Set(['click', 'fill', 'hover', 'dblclick', 'rightclick', 'check', 'uncheck', 'scroll', 'press', 'drag', 'mouse', 'wait', 'expect']);

export interface ComputerSpec {
  name: string;
  app: string;
  dir: string;
  hooks?: string;
  goal?: string;
  env: Record<string, unknown>;
  tags?: string[];
  timeout?: number;
  steps: Step[];
}

const ComputerSpecSchema = z.object({
  name: z.string().min(1),
  app: z.string().min(1),
  hooks: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  env: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(z.unknown()).min(1),
  tags: TagsSchema,
  timeout: z.number().int().positive().optional(),
}).strict();

export function parseComputerStep(raw: unknown, where = 'computer', index = 0): Step {
  const step = parseStep(where, index, raw);
  if (!SUPPORTED.has(step.kind)) throw new Error(`${step.kind} is browser-only; desktop supports ${[...SUPPORTED].join(', ')}`);
  rejectCss(step, 'desktop');
  if (step.kind === 'scroll' && !/^(up|down):\s*\S/.test(step.target)) throw new Error('Desktop scroll syntax: "down: the results list" or "up: the editor"');
  return step;
}

export function loadComputerSpec(file: string, opts?: LoadOptions): ComputerSpec {
  return loadNativeSpec(file, ComputerSpecSchema, parseComputerStep, opts);
}
