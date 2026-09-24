import { interpolate } from './spec.js';
import { parseMobileStep, validateMobileStep, mobileLabel } from './mobile-spec.js';
import { NativeSession, runNativeSpec } from './native.js';
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
            const [r] = await this.find(kind, [target]);
            if (r.element === null)
                return { step: name, status: 'inconclusive', detail: r.detail };
            const element = r.element;
            if (step.kind === 'scroll')
                await this.timed('act', () => this.adapter.gesture('scroll', step.target.split(':')[0], element));
            else
                await this.timed('act', () => this.adapter.act(step.kind, element, step.kind === 'fill' ? step.value : undefined));
            return { step: name, status: 'pass', detail: r.detail };
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
