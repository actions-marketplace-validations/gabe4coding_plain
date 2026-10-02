import { interpolate } from '../core/interpolate.js';
import { NativeSession } from '../native/session.js';
import { runNativeSpec } from '../native/run-spec.js';
import { parseMobileStep, validateMobileStep, mobileLabel } from './spec.js';
import { HiddenTargetError } from '../core/automation.js';
const SCROLL_DIRECTION = /^(up|down|left|right):\s*/;
/** The candidates a mobile step picks from. */
function candidateKind(kind) {
    if (kind === 'fill')
        return 'fill';
    if (kind === 'check' || kind === 'uncheck')
        return 'check';
    if (kind === 'scroll')
        return 'scroll';
    return 'click';
}
export class MobileSession extends NativeSession {
    parse(raw) { return parseMobileStep(raw); }
    label(step) { return mobileLabel(step); }
    validate(step) { return validateMobileStep(step); }
    async act(step, stepLabel) {
        if (step.kind === 'press') {
            await this.timed('act', () => this.adapter.press(step.key));
            return { step: stepLabel, status: 'pass' };
        }
        if (step.kind === 'swipe') {
            let element;
            if (step.within) {
                const [region] = await this.find('region', [step.within]);
                if (region.element === null)
                    return { step: stepLabel, status: 'inconclusive', detail: region.detail };
                element = region.element;
            }
            await this.timed('act', () => this.adapter.gesture('swipe', step.direction, element));
            return { step: stepLabel, status: 'pass' };
        }
        if (step.kind === 'expect' || step.kind === 'wait')
            return { step: stepLabel, status: 'pass' };
        const target = step.kind === 'scroll' ? step.target.replace(SCROLL_DIRECTION, '') : step.target;
        // An approximate capture also lists covered elements. That lowers Jev's confidence but not its choice, so its
        // pick is used when accepted and visible; a rejected or covered pick is picked again from an exact capture.
        for (let retargeted = false;; retargeted = true) {
            const [resolved] = await this.find(candidateKind(step.kind), [target]);
            if (resolved.approximate && !retargeted && resolved.element === null) {
                this.retarget();
                continue;
            }
            if (resolved.element === null)
                return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
            const element = resolved.element;
            try {
                if (step.kind === 'scroll') {
                    const direction = step.target.split(':')[0];
                    await this.timed('act', () => this.adapter.gesture('scroll', direction, element));
                }
                else {
                    const value = step.kind === 'fill' ? step.value : undefined;
                    await this.timed('act', () => this.adapter.act(step.kind, element, value));
                }
                return { step: stepLabel, status: 'pass', detail: resolved.detail };
            }
            catch (error) {
                if (retargeted || !(error instanceof HiddenTargetError))
                    throw error;
                // Jev accepted a covered element over a visible one. Logged: the approximate capture assumes this is rare.
                if (resolved.approximate) {
                    console.error(`plainwright-mobile: accepted pick from an approximate capture was covered, picking again from the exact tree: ${target} ${resolved.detail}`);
                }
                this.retarget();
            }
        }
    }
}
export function runMobileSpec(spec, session, observer, info, specTimeout) {
    return runNativeSpec(spec, session, async (vars) => {
        const target = { platform: spec.platform, device: spec.device, app: spec.app, capabilities: spec.capabilities };
        const { steps, ...resolvedTarget } = interpolate({ ...target, steps: spec.steps }, vars, spec.name);
        await session.adapter.open(resolvedTarget);
        session.noteActivity();
        return steps;
    }, observer, info, specTimeout);
}
