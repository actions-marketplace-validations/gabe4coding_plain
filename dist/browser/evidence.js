import { intelligence } from '../core/automation.js';
import { StepKind } from '../core/step-kind.js';
import { evidenceForGroups } from '../jev/evidence.js';
import { timed } from './context.js';
const routes = new WeakMap();
function sessionRoutes(ctx) {
    let cached = routes.get(ctx);
    if (!cached) {
        cached = { pending: new Map(), decided: new Map() };
        routes.set(ctx, cached);
    }
    return cached;
}
function prepareGroup(ctx, prompts) {
    if (!prompts.length)
        return;
    const cached = sessionRoutes(ctx);
    const key = JSON.stringify(prompts);
    if (!cached.decided.has(key))
        cached.pending.set(key, prompts);
}
/** Queue only descriptions, never entered values, files, keys or URLs. No model call until a step needs it. */
export function prepareEvidence(ctx, steps) {
    const targets = (prompts) => prepareGroup(ctx, prompts.filter((prompt) => !prompt.startsWith('css=')));
    for (const step of steps) {
        switch (step.kind) {
            case StepKind.goto:
            case StepKind.press:
            case StepKind.mouse:
                break;
            case StepKind.expect:
                prepareGroup(ctx, step.expectations);
                if (step.within)
                    targets([step.within]);
                break;
            case StepKind.wait:
                if (!step.condition.startsWith('css=')) {
                    prepareGroup(ctx, [step.condition]);
                    if (step.within)
                        targets([step.within]);
                }
                break;
            case StepKind.drag:
                targets([step.source, step.target]);
                break;
            default:
                targets([step.target]);
        }
    }
}
export async function needsLayout(ctx, prompts) {
    const cached = sessionRoutes(ctx);
    const key = JSON.stringify(prompts);
    const existing = cached.decided.get(key);
    if (existing)
        return existing;
    prepareGroup(ctx, prompts);
    const pending = [...cached.pending.entries()];
    cached.pending.clear();
    const batch = timed(ctx, 'jev', () => evidenceForGroups(pending.map(([, group]) => group), intelligence.ask, ctx.track))
        .then((result) => result.spatial);
    for (const [index, [groupKey, group]] of pending.entries()) {
        const route = batch.then((spatial) => spatial[index]).catch((error) => {
            cached.decided.delete(groupKey);
            cached.pending.set(groupKey, group);
            throw error;
        });
        // A later group may never execute after a failed step. Its rejected route still needs an observer.
        void route.catch(() => { });
        cached.decided.set(groupKey, route);
    }
    return cached.decided.get(key);
}
