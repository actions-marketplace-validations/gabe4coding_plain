import { interpolate, type Step } from '../core/spec.js';
import { parseComputerStep, type ComputerSpec } from './spec.js';
import type { ComputerAdapter, ComputerKind } from './adapter.js';
import { label, type StepResult } from '../core/results.js';
import { NativeSession, runNativeSpec } from '../native/native.js';
import type { RunObserver, SpecInfo } from '../suite/types.js';

export class ComputerSession<T = unknown> extends NativeSession<T, ComputerKind, Step, ComputerAdapter<T>> {
  parse(raw: unknown) { return parseComputerStep(raw); }
  protected label(step: Step) { return label(step); }
  protected async act(step: Step, name: string): Promise<StepResult> {
    if (step.kind === 'press') await this.timed('act', () => this.adapter.press(step.key));
    else if (step.kind === 'mouse') await this.timed('act', () => this.adapter.mouse(step.x, step.y));
    else if (step.kind === 'drag') {
      const [source, target] = await this.find('click', [step.source, step.target]);
      if (source.element === null || target.element === null) return { step: name, status: 'inconclusive', detail: `${source.detail} → ${target.detail}` };
      const [from, to] = [source.element, target.element];
      await this.timed('act', () => this.adapter.drag(from, to));
    } else if (step.kind === 'goto' || step.kind === 'select' || step.kind === 'upload' || step.kind === 'expect' || step.kind === 'wait') {
      throw new Error(`${step.kind} is browser-only`);
    } else {
      const kind: ComputerKind = step.kind === 'fill' ? 'fill' : step.kind === 'check' || step.kind === 'uncheck' ? 'check' :
        step.kind === 'scroll' ? 'scroll' : step.kind === 'hover' ? 'hover' : 'click';
      const target = step.kind === 'scroll' ? step.target.replace(/^(up|down):\s*/, '') : step.target;
      const [r] = await this.find(kind, [target]);
      if (r.element === null) return { step: name, status: 'inconclusive', detail: r.detail };
      const element = r.element, action = step.kind;
      const value = step.kind === 'fill' ? step.value : step.kind === 'scroll' ? (step.target.startsWith('up:') ? '-3' : '3') : undefined;
      await this.timed('act', () => this.adapter.act(action, element, value));
      return { step: name, status: 'pass', detail: r.detail };
    }
    return { step: name, status: 'pass' };
  }
}

export function runComputerSpec<T>(spec: ComputerSpec, session: ComputerSession<T>, observer?: RunObserver, info?: SpecInfo, specTimeout?: number) {
  return runNativeSpec(spec, session as ComputerSession, async (vars) => {
    const resolved = interpolate({ app: spec.app, steps: spec.steps }, vars, spec.name);
    await session.adapter.open({ app: resolved.app }, true);
    return resolved.steps;
  }, observer, info, specTimeout);
}
