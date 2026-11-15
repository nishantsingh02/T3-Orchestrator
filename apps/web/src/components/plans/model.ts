import type { PlanStatus, PlanView, TaskView } from '@t3-orchestra/shared';

/** Plan statuses that still need the planner or the user; the rest (accepted, discarded) are settled. */
export const OPEN_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set([
  'speccing',
  'spec_review',
  'planning',
  'needs_input',
  'ready',
  'refining',
  'failed',
]);

/** Plans waiting on the user: a question in T3, a spec to answer, or proposals to review. */
export const needsYou = (p: PlanView) => p.status === 'needs_input' || p.status === 'spec_review' || p.status === 'ready';

/** The planner is working on the plan (a spec round or tasks). */
export const plannerBusy = (p: PlanView) => p.status === 'speccing' || p.status === 'planning' || p.status === 'refining';

export function planTitle(plan: PlanView | undefined): string {
  return plan ? plan.title.replace(/^#+\s*/, '').trim() || `Plan ${plan.number}` : 'Plan';
}

/** Path of a plan inside the board's Plans view. */
export const planPath = (slug: string, planId: string) => `/b/${slug}/plans/${planId}`;

export interface PlanTasks {
  /** Tasks created when the plan was accepted. */
  planned: TaskView[];
  /** Follow-ups agents suggested from those tasks (and from their follow-ups). */
  followUps: TaskView[];
}

/**
 * The board's live tasks per plan (key null: tasks added by hand), discarded ones left out.
 * A follow-up belongs to the plan its chain of follow-ups started from, as in the Overview's scope.
 */
export function tasksByPlan(tasks: readonly TaskView[]): Map<string | null, PlanTasks> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rootOf = (t: TaskView): TaskView => {
    const seen = new Set<string>();
    let cur = t;
    while (cur.followUpOf && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = byId.get(cur.followUpOf);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  };
  const groups = new Map<string | null, PlanTasks>();
  for (const t of [...tasks].sort((a, b) => a.number - b.number)) {
    if (t.stage === 'discarded') continue;
    const planId = rootOf(t).planId;
    const g = groups.get(planId) ?? { planned: [], followUps: [] };
    (t.followUpOf ? g.followUps : g.planned).push(t);
    groups.set(planId, g);
  }
  return groups;
}
