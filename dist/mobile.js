import { interpolate } from './spec.js';
import { parseMobileStep, validateMobileStep, mobileLabel } from './mobile-spec.js';
import { HiddenTargetError } from './mobile-adapter.js';
import { NativeSession, runNativeSpec } from './native.js';
// Calendar's sheet steps scored 0.81-0.95 from exact captures and 0.43-0.75 from approximate ones,
// every other step 0.95-1.00 from both: below this, the exact capture decides.
const SURE_APPROXIMATE_PICK = 0.9;
export class MobileSession extends NativeSession {
    parse(raw) { return parseMobileStep(raw); }
    label(step) { return mobileLabel(step); }
    validate(step) { return validateMobileStep(step); }
    async act(step, name) {
        if (step.kind === 'press')
            await this.timed('act', () => this.adapter.press(step.key));
        else if (step.kind === 'swipe') {
            let element;
            if (step.within) {
                const [r] = await this.find('region', [step.within]);
                if (r.element === null)
                    return { step: name, status: 'inconclusive', detail: r.detail };
                element = r.element;
            }
            await this.timed('act', () => this.adapter.gesture('swipe', step.direction, element));
        }
        else if (step.kind !== 'expect' && step.kind !== 'wait') {
            const kind = step.kind === 'fill' ? 'fill' : step.kind === 'check' || step.kind === 'uncheck' ? 'check' :
                step.kind === 'scroll' ? 'scroll' : 'click';
            const target = step.kind === 'scroll' ? step.target.replace(/^(up|down|left|right):\s*/, '') : step.target;
            // An approximate capture (AppiumAdapter.capture) also lists covered elements, which blurs Jev's view.
            // Its pick is used only when sure and visible; otherwise the target is picked once more from an exact one.
            for (let retargeted = false;; retargeted = true) {
                const [r] = await this.find(kind, [target]);
                const retry = () => { this.ms.retargeted = 1; this.adapter.preferExact?.(); };
                if (r.approximate && !retargeted && !((r.score ?? 0) >= SURE_APPROXIMATE_PICK)) {
                    retry();
                    continue;
                }
                if (r.element === null)
                    return { step: name, status: 'inconclusive', detail: r.detail };
                const element = r.element;
                try {
                    if (step.kind === 'scroll')
                        await this.timed('act', () => this.adapter.gesture('scroll', step.target.split(':')[0], element));
                    else
                        await this.timed('act', () => this.adapter.act(step.kind, element, step.kind === 'fill' ? step.value : undefined));
                    return { step: name, status: 'pass', detail: r.detail };
                }
                catch (error) {
                    if (retargeted || !(error instanceof HiddenTargetError))
                        throw error;
                    retry();
                }
            }
        }
        return { step: name, status: 'pass' };
    }
}
export function runMobileSpec(spec, session) {
    return runNativeSpec(spec, session, async (vars) => {
        const { steps, ...target } = interpolate({ platform: spec.platform, device: spec.device, app: spec.app, capabilities: spec.capabilities, steps: spec.steps }, vars, spec.name);
        await session.adapter.open(target);
        session.noteActivity();
        return steps;
    });
}
