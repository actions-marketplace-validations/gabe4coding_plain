import { z } from 'zod';
import { parseStep, rejectCss, loadNativeSpec, TagsSchema } from '../core/spec.js';
import { label } from '../core/results.js';
const nonEmptyText = z.string().trim().min(1);
export const MobileTargetSchema = z.object({
    platform: z.enum(['ios', 'android']),
    /** An explicit UDID or ADB serial: another device is never chosen silently. */
    device: nonEmptyText,
    /** An installed bundle ID or package name, not a binary to install. */
    app: nonEmptyText,
    capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict();
const DirectionSchema = z.enum(['up', 'down', 'left', 'right']);
const SHARED_KINDS = new Set(['click', 'fill', 'dblclick', 'check', 'uncheck', 'scroll', 'press', 'wait', 'expect']);
const KEYS = ['Back', 'Home', 'Enter', 'HideKeyboard'];
const MobileSpecSchema = MobileTargetSchema.extend({
    name: nonEmptyText,
    hooks: nonEmptyText.optional(),
    goal: nonEmptyText.optional(),
    env: z.record(z.string(), z.unknown()).default({}),
    steps: z.array(z.unknown()).min(1),
    tags: TagsSchema,
    timeout: z.number().int().positive().optional(),
});
export function loadMobileSpec(file, opts) {
    return loadNativeSpec(file, MobileSpecSchema, parseMobileStep, opts);
}
/** `allowPlaceholders`: a `${...}` in a scroll target or a key is checked only after interpolation. */
export function validateMobileStep(step, allowPlaceholders = false) {
    rejectCss(step, 'mobile');
    const templated = (value) => allowPlaceholders && value.includes('${');
    if (step.kind === 'scroll' && !templated(step.target) && !/^(up|down|left|right):\s*\S/.test(step.target)) {
        throw new Error('Mobile scroll syntax: "down: the results list" (up, left and right also supported)');
    }
    if (step.kind === 'press' && !templated(step.key) && !KEYS.includes(step.key)) {
        throw new Error('Mobile press supports Back (Android only), Home, Enter (Android only), or HideKeyboard');
    }
    return step;
}
export function parseMobileStep(raw, where = 'mobile', index = 0) {
    const mapping = z.record(z.string(), z.unknown()).parse(raw);
    const keys = Object.keys(mapping).filter((key) => key !== 'optional');
    if (keys.length !== 1)
        throw new Error(`${where}: step ${index} must have exactly one action key`);
    const kind = keys[0];
    const optional = mapping.optional === true;
    if (kind === 'tap' || kind === 'longpress')
        return validateMobileStep({ kind, target: nonEmptyText.parse(mapping[kind]), optional });
    if (kind === 'swipe') {
        const value = typeof mapping.swipe === 'string' ? { direction: mapping.swipe } : mapping.swipe;
        const swipe = z.object({ direction: DirectionSchema, within: nonEmptyText.optional() }).strict().parse(value);
        return validateMobileStep({ kind, ...swipe, optional });
    }
    if (!SHARED_KINDS.has(kind)) {
        throw new Error(`${kind} is not supported on mobile; use tap, click, fill, dblclick, longpress, check, uncheck, scroll, swipe, press, wait or expect`);
    }
    return validateMobileStep(parseStep(where, index, raw), true);
}
export function mobileLabel(step) {
    const origin = 'origin' in step && step.origin ? `${step.origin} › ` : '';
    if (step.kind === 'tap' || step.kind === 'longpress')
        return `${origin}${step.kind} ${JSON.stringify(step.target)}`;
    if (step.kind === 'swipe')
        return `${origin}swipe ${step.direction}${step.within ? ` within ${JSON.stringify(step.within)}` : ''}`;
    return label(step);
}
