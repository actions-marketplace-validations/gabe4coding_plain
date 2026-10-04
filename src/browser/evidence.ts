import { intelligence } from '../core/automation.js';
import { evidenceRoutes, prepareRoutes, promptGroups, routeNeedsLayout, type EvidenceRoutes } from '../core/evidence.js';
import type { Step } from '../core/spec.js';
import { evidenceForGroups } from '../jev/evidence.js';
import { timed, type StepContext } from './context.js';

/** One route cache per session: a prompt group is classified once per spec run or MCP session. */
const routes = new WeakMap<StepContext, EvidenceRoutes>();

function sessionRoutes(ctx: StepContext): EvidenceRoutes {
  let cached = routes.get(ctx);
  if (!cached) {
    cached = evidenceRoutes();
    routes.set(ctx, cached);
  }
  return cached;
}

/** `scroll: bottom`, `top`, and the ways an agent writes them ("the bottom of the page", "page end"). */
export function scrollEdge(target: string): 'top' | 'bottom' | null {
  const match = /^(?:the )?(?:page )?(top|bottom|end)(?: of the page)?$/i.exec(target.trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'top' ? 'top' : 'bottom';
}

/**
 * Queues the steps' descriptions. No model call until a step needs it. Pass interpolated steps: the route is about
 * the words Jev sees. A scroll to the page's edge describes no element, so it has no route.
 */
export function prepareEvidence(ctx: StepContext, steps: Step[]): void {
  prepareRoutes(sessionRoutes(ctx), steps.filter((step) => !(step.kind === 'scroll' && scrollEdge(step.target)))
    .flatMap(promptGroups));
}

export function needsLayout(ctx: StepContext, prompts: string[]): Promise<boolean> {
  return routeNeedsLayout(sessionRoutes(ctx), prompts, (groups) =>
    timed(ctx, 'jev', () => evidenceForGroups(groups, intelligence.ask, ctx.track)).then((result) => result.spatial));
}
