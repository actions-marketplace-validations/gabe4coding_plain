import { z } from 'zod';
import { parseStep, rejectCss, loadNativeSpec, type Step } from './spec.js';

export const ComputerTargetSchema = z.object({ app: z.string().trim().min(1).optional(), pid: z.number().int().positive().optional() })
  .refine((v) => (v.app !== undefined) !== (v.pid !== undefined), 'provide exactly one of app or pid');
const supported = new Set(['click', 'fill', 'hover', 'dblclick', 'rightclick', 'check', 'uncheck', 'scroll', 'press', 'drag', 'mouse', 'wait', 'expect']);
export function parseComputerStep(raw: unknown, where = 'computer', index = 0): Step {
  const step = parseStep(where, index, raw);
  if (!supported.has(step.kind)) throw new Error(`${step.kind} is browser-only; desktop supports ${[...supported].join(', ')}`);
  rejectCss(step, 'desktop');
  if (step.kind === 'scroll' && !/^(up|down):\s*\S/.test(step.target)) throw new Error('Desktop scroll syntax: "down: the results list" or "up: the editor"');
  return step;
}
export interface ComputerSpec {
  name: string;
  app: string;
  dir: string;
  hooks?: string;
  goal?: string;
  env: Record<string, unknown>;
  steps: Step[];
}
export function loadComputerSpec(file: string): ComputerSpec {
  return loadNativeSpec(file, z.object({
    name: z.string().min(1), app: z.string().min(1), hooks: z.string().min(1).optional(), goal: z.string().min(1).optional(),
    env: z.record(z.string(), z.unknown()).default({}), steps: z.array(z.unknown()).min(1),
  }).strict(), parseComputerStep);
}
