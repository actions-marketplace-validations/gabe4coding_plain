import { intelligence } from '../core/automation.js';
import { evidenceRoutes, prepareRoutes, promptGroups, routeNeedsLayout, type EvidenceRoutes } from '../core/evidence.js';
import type { Step } from '../core/spec.js';
import { evidenceForGroups } from '../jev/evidence.js';
import { timed, type StepContext } from './context.js';

const routes = new WeakMap<StepContext, EvidenceRoutes>();

function sessionRoutes(ctx: StepContext): EvidenceRoutes {
  let cached = routes.get(ctx);
  if (!cached) {
    cached = evidenceRoutes();
    routes.set(ctx, cached);
  }
  return cached;
}

/** Queues the steps' descriptions. No model call until a step needs it. */
export function prepareEvidence(ctx: StepContext, steps: Step[]): void {
  prepareRoutes(sessionRoutes(ctx), steps.flatMap(promptGroups));
}

export function needsLayout(ctx: StepContext, prompts: string[]): Promise<boolean> {
  return routeNeedsLayout(sessionRoutes(ctx), prompts, (groups) =>
    timed(ctx, 'jev', () => evidenceForGroups(groups, intelligence.ask, ctx.track)).then((result) => result.spatial));
}
