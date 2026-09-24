import { z } from 'zod';
import { parseStep, rejectCss, loadNativeSpec } from './spec.js';
import { label } from './results.js';
const text = z.string().trim().min(1);
export const MobileTargetSchema = z.object({
    platform: z.enum(['ios', 'android']),
    device: text, // Explicit UDID/ADB serial; never silently choose another device.
    app: text, // Installed bundle ID / package name, not a binary to install.
    capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const DirectionSchema = z.enum(['up', 'down', 'left', 'right']);
const supported = new Set(['click', 'fill', 'dblclick', 'check', 'uncheck', 'scroll', 'press', 'wait', 'expect']);
export function validateMobileStep(step, allowPlaceholders = false) {
    rejectCss(step, 'mobile');
    if (step.kind === 'scroll' && !(allowPlaceholders && step.target.includes('${')) && !/^(up|down|left|right):\s*\S/.test(step.target))
        throw new Error('Mobile scroll syntax: "down: the results list" (up, left and right also supported)');
    if (step.kind === 'press' && !(allowPlaceholders && step.key.includes('${')) && !['Back', 'Home', 'Enter', 'HideKeyboard'].includes(step.key))
        throw new Error('Mobile press supports Back (Android only), Home, Enter (Android only), or HideKeyboard');
    return step;
}
export function parseMobileStep(raw, where = 'mobile', index = 0) {
    const obj = z.record(z.string(), z.unknown()).parse(raw);
    const keys = Object.keys(obj).filter(k => k !== 'optional');
    if (keys.length !== 1)
        throw new Error(`${where}: step ${index} must have exactly one action key`);
    const kind = keys[0];
    const optional = obj.optional === true;
    if (kind === 'tap' || kind === 'longpress')
        return validateMobileStep({ kind, target: text.parse(obj[kind]), optional });
    if (kind === 'swipe') {
        const value = typeof obj.swipe === 'string' ? { direction: obj.swipe } : obj.swipe;
        return validateMobileStep({ kind, ...z.object({ direction: DirectionSchema, within: text.optional() }).strict().parse(value), optional });
    }
    if (!supported.has(kind))
        throw new Error(`${kind} is not supported on mobile; use tap, click, fill, dblclick, longpress, check, uncheck, scroll, swipe, press, wait or expect`);
    return validateMobileStep(parseStep(where, index, raw), true);
}
export function mobileLabel(step) {
    if (step.kind === 'tap' || step.kind === 'longpress')
        return `${step.kind} ${JSON.stringify(step.target)}`;
    if (step.kind === 'swipe')
        return `swipe ${step.direction}${step.within ? ` within ${JSON.stringify(step.within)}` : ''}`;
    return label(step);
}
export function loadMobileSpec(file) {
    return loadNativeSpec(file, MobileTargetSchema.extend({
        name: text, hooks: text.optional(), env: z.record(z.string(), z.unknown()).default({}), steps: z.array(z.unknown()).min(1),
    }), parseMobileStep);
}
