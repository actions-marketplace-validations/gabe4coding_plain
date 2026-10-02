import { z } from 'zod';
import { parseStep, rejectCss, loadNativeSpec, TagsSchema, type LoadOptions, type Step } from './spec.js';
import { label } from './results.js';
import type { StepSource } from './pick-cache.js';

const text = z.string().trim().min(1);
export const MobileTargetSchema = z.object({
  platform: z.enum(['ios', 'android']),
  device: text, // Explicit UDID/ADB serial; never silently choose another device.
  app: text, // Installed bundle ID / package name, not a binary to install.
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type MobileTarget = z.infer<typeof MobileTargetSchema>;
export const DirectionSchema = z.enum(['up', 'down', 'left', 'right']);
export type Direction = z.infer<typeof DirectionSchema>;
type SharedMobileStep = Extract<Step, { kind: 'click' | 'fill' | 'dblclick' | 'check' | 'uncheck' | 'scroll' | 'press' | 'wait' | 'expect' }>;
export type MobileStep = SharedMobileStep |
  { kind: 'tap'; target: string; optional?: boolean; origin?: string; at?: StepSource } |
  { kind: 'longpress'; target: string; optional?: boolean; origin?: string; at?: StepSource } |
  { kind: 'swipe'; direction: Direction; within?: string; optional?: boolean; origin?: string; at?: StepSource };
const supported = new Set(['click', 'fill', 'dblclick', 'check', 'uncheck', 'scroll', 'press', 'wait', 'expect']);

export function validateMobileStep(step: MobileStep, allowPlaceholders = false): MobileStep {
  rejectCss(step, 'mobile');
  if (step.kind === 'scroll' && !(allowPlaceholders && step.target.includes('${')) && !/^(up|down|left|right):\s*\S/.test(step.target))
    throw new Error('Mobile scroll syntax: "down: the results list" (up, left and right also supported)');
  if (step.kind === 'press' && !(allowPlaceholders && step.key.includes('${')) && !['Back', 'Home', 'Enter', 'HideKeyboard'].includes(step.key))
    throw new Error('Mobile press supports Back (Android only), Home, Enter (Android only), or HideKeyboard');
  return step;
}

export function parseMobileStep(raw: unknown, where = 'mobile', index = 0): MobileStep {
  const obj = z.record(z.string(), z.unknown()).parse(raw);
  const keys = Object.keys(obj).filter(k => k !== 'optional');
  if (keys.length !== 1) throw new Error(`${where}: step ${index} must have exactly one action key`);
  const kind = keys[0];
  const optional = obj.optional === true;
  if (kind === 'tap' || kind === 'longpress') return validateMobileStep({ kind, target: text.parse(obj[kind]), optional });
  if (kind === 'swipe') {
    const value = typeof obj.swipe === 'string' ? { direction: obj.swipe } : obj.swipe;
    return validateMobileStep({ kind, ...z.object({ direction: DirectionSchema, within: text.optional() }).strict().parse(value), optional });
  }
  if (!supported.has(kind)) throw new Error(`${kind} is not supported on mobile; use tap, click, fill, dblclick, longpress, check, uncheck, scroll, swipe, press, wait or expect`);
  return validateMobileStep(parseStep(where, index, raw) as SharedMobileStep, true);
}

export function mobileLabel(step: MobileStep): string {
  if (step.kind === 'tap' || step.kind === 'longpress') return `${step.origin ? `${step.origin} › ` : ''}${step.kind} ${JSON.stringify(step.target)}`;
  if (step.kind === 'swipe') return `${step.origin ? `${step.origin} › ` : ''}swipe ${step.direction}${step.within ? ` within ${JSON.stringify(step.within)}` : ''}`;
  return label(step);
}

export interface MobileSpec extends MobileTarget {
  name: string;
  dir: string;
  hooks?: string;
  goal?: string;
  env: Record<string, unknown>;
  tags?: string[];
  timeout?: number;
  steps: MobileStep[];
}
export function loadMobileSpec(file: string, opts?: LoadOptions): MobileSpec {
  return loadNativeSpec(file, MobileTargetSchema.extend({
    name: text, hooks: text.optional(), goal: text.optional(), env: z.record(z.string(), z.unknown()).default({}), steps: z.array(z.unknown()).min(1),
    tags: TagsSchema, timeout: z.number().int().positive().optional(),
  }), parseMobileStep, opts);
}
