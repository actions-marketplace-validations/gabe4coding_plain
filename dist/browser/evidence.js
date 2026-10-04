import { intelligence } from '../core/automation.js';
import { evidenceRoutes, prepareRoutes, promptGroups, routeNeedsLayout } from '../core/evidence.js';
import { evidenceForGroups } from '../jev/evidence.js';
import { timed } from './context.js';
const routes = new WeakMap();
function sessionRoutes(ctx) {
    let cached = routes.get(ctx);
    if (!cached) {
        cached = evidenceRoutes();
        routes.set(ctx, cached);
    }
    return cached;
}
/** Queues the steps' descriptions. No model call until a step needs it. */
export function prepareEvidence(ctx, steps) {
    prepareRoutes(sessionRoutes(ctx), steps.flatMap(promptGroups));
}
export function needsLayout(ctx, prompts) {
    return routeNeedsLayout(sessionRoutes(ctx), prompts, (groups) => timed(ctx, 'jev', () => evidenceForGroups(groups, intelligence.ask, ctx.track)).then((result) => result.spatial));
}
