import { interpolate } from '../core/spec.js';
import { parseMobileStep, validateMobileStep, mobileLabel, type MobileStep, type MobileSpec, type Direction } from './spec.js';
import { HiddenTargetError, type MobileAdapter, type MobileAction } from './adapter.js';
import type { MobileKind } from './tree.js';
import type { StepResult } from '../core/results.js';
import { NativeSession, runNativeSpec } from '../native/native.js';
import type { RunObserver, SpecInfo } from '../suite/types.js';

export class MobileSession<T = unknown> extends NativeSession<T, MobileKind, MobileStep, MobileAdapter<T>> {
  parse(raw: unknown) { return parseMobileStep(raw); }
  protected label(step: MobileStep) { return mobileLabel(step); }
  protected validate(step: MobileStep) { return validateMobileStep(step); }
  protected async act(step: MobileStep, name: string): Promise<StepResult> {
    if (step.kind === 'press') await this.timed('act', () => this.adapter.press(step.key));
    else if (step.kind === 'swipe') {
      let element: T | undefined;
      if (step.within) {
        const [r] = await this.find('region', [step.within]);
        if (r.element === null) return { step: name, status: 'inconclusive', detail: r.detail };
        element = r.element;
      }
      await this.timed('act', () => this.adapter.gesture('swipe', step.direction, element));
    } else if (step.kind !== 'expect' && step.kind !== 'wait') {
      const kind: MobileKind = step.kind === 'fill' ? 'fill' : step.kind === 'check' || step.kind === 'uncheck' ? 'check' :
        step.kind === 'scroll' ? 'scroll' : 'click';
      const target = step.kind === 'scroll' ? step.target.replace(/^(up|down|left|right):\s*/, '') : step.target;
      // An approximate capture (AppiumAdapter.capture) also lists covered elements. That lowers Jev's confidence
      // (Calendar sheet steps: 0.43-0.75 against 0.80-0.96 exact) but not its choice: on recorded Calendar trees
      // both captures picked the same element in 24 of 24 asks. So its pick is used when accepted and visible;
      // a rejected (a keyboard still sliding in can be missing) or covered pick is picked again from an exact one.
      for (let retargeted = false; ; retargeted = true) {
        const [r] = await this.find(kind, [target]);
        if (r.approximate && !retargeted && r.element === null) { this.retarget(); continue; }
        if (r.element === null) return { step: name, status: 'inconclusive', detail: r.detail };
        const element = r.element;
        try {
          if (step.kind === 'scroll') await this.timed('act', () => this.adapter.gesture('scroll', step.target.split(':')[0] as Direction, element));
          else await this.timed('act', () => this.adapter.act(step.kind as MobileAction, element, step.kind === 'fill' ? step.value : undefined));
          return { step: name, status: 'pass', detail: r.detail };
        } catch (error) {
          if (retargeted || !(error instanceof HiddenTargetError)) throw error;
          // Jev accepted a covered element over a visible one: the case the approximate capture assumes is rare
          // (Calendar: 0 of 24). Logged so other apps can check that assumption.
          if (r.approximate) console.error(`plainwright-mobile: accepted pick from an approximate capture was covered, picking again from the exact tree: ${target} ${r.detail}`);
          this.retarget();
        }
      }
    }
    return { step: name, status: 'pass' };
  }
}

export function runMobileSpec<T>(spec: MobileSpec, session: MobileSession<T>, observer?: RunObserver, info?: SpecInfo, specTimeout?: number) {
  return runNativeSpec(spec, session as MobileSession, async (vars) => {
    const { steps, ...target } = interpolate({ platform: spec.platform, device: spec.device, app: spec.app, capabilities: spec.capabilities, steps: spec.steps }, vars, spec.name);
    await session.adapter.open(target);
    session.noteActivity();
    return steps;
  }, observer, info, specTimeout);
}
