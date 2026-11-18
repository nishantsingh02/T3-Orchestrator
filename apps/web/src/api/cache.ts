// Helpers that write server pushes and mutation results straight into the query cache.
import type { QueryClient } from '@tanstack/react-query';
import type { BoardView, MilestoneView, PlanDetailView, PlanView, TaskDetailView, TaskView } from '@t3-orchestra/shared';
import { keys } from './keys';

function upsertById<T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/**
 * Fields whose change means the detail view (runs, findings, events, diff) is stale. Activity
 * counters (`activeRun.events`, `quietMinutes`, `lastActivityAt`) are deliberately left out so a
 * busy thread doesn't refetch the drawer every reconcile tick.
 */
function detailSignature(t: TaskView): string {
  return JSON.stringify([
    t.stage,
    t.stageReason,
    t.attention,
    t.activeRun?.id ?? null,
    t.activeRun?.status ?? null,
    t.fixRound,
    t.reviewRound,
    t.findings,
    t.design,
    t.diffStat,
    t.activitySinceReview,
    t.lastSummary,
    t.lastMessage,
    t.threadId,
    t.branch,
    t.prUrl,
    t.deps.map((d) => `${d.id}:${d.stage}`),
  ]);
}

/** Apply a TaskView (from SSE or a mutation) to the board list and the detail cache. */
export function applyTask(qc: QueryClient, task: TaskView, opts: { refreshDetail?: boolean } = {}): void {
  qc.setQueryData<TaskView[]>(keys.tasks(task.boardId), (old) => upsertById(old, task));

  let stale = opts.refreshDetail ?? false;
  qc.setQueryData<TaskDetailView>(keys.task(task.id), (old) => {
    if (!old) return old;
    if (detailSignature(old) !== detailSignature(task)) stale = true;
    return { ...old, ...task };
  });
  if (stale) {
    void qc.invalidateQueries({ queryKey: keys.task(task.id), exact: true });
    void qc.invalidateQueries({ queryKey: keys.diffPrefix(task.id) });
  }
}

export function removeTask(qc: QueryClient, ev: { id: string; boardId: string }): void {
  qc.setQueryData<TaskView[]>(keys.tasks(ev.boardId), (old) => old?.filter((t) => t.id !== ev.id));
  qc.removeQueries({ queryKey: keys.task(ev.id), exact: true });
  qc.removeQueries({ queryKey: keys.diffPrefix(ev.id) });
}

export function applyBoard(qc: QueryClient, board: BoardView): void {
  qc.setQueryData<BoardView[]>(keys.boards, (old) => {
    if (!old) return old;
    if (board.archivedAt) return old.filter((b) => b.id !== board.id);
    return upsertById(old, board);
  });
  qc.setQueryData(keys.board(board.id), board);
  qc.setQueryData(keys.board(board.slug), board);
}

export function applyMilestone(qc: QueryClient, m: MilestoneView): void {
  qc.setQueryData<MilestoneView[]>(keys.milestones(m.boardId), (old) =>
    upsertById(old, m)?.sort((a, b) => a.position - b.position || a.number - b.number),
  );
}

export function removeMilestone(qc: QueryClient, ev: { id: string; boardId: string }): void {
  qc.setQueryData<MilestoneView[]>(keys.milestones(ev.boardId), (old) => old?.filter((m) => m.id !== ev.id));
}

function planDetailSignature(p: PlanView): string {
  return JSON.stringify([p.status, p.currentVersion, p.error, p.threadId, p.attention, p.acceptedKeys]);
}

export function applyPlan(qc: QueryClient, plan: PlanView): void {
  qc.setQueryData<PlanView[]>(keys.plans(plan.boardId), (old) => {
    if (!old) return old;
    if (plan.status === 'discarded') return old.filter((p) => p.id !== plan.id);
    const exists = old.some((p) => p.id === plan.id);
    return exists ? old.map((p) => (p.id === plan.id ? plan : p)) : [plan, ...old];
  });
  let stale = false;
  qc.setQueryData<PlanDetailView>(keys.plan(plan.id), (old) => {
    if (!old) return old;
    if (planDetailSignature(old) !== planDetailSignature(plan)) stale = true;
    return { ...old, ...plan };
  });
  if (stale) void qc.invalidateQueries({ queryKey: keys.plan(plan.id), exact: true });
}

export function applyPlanDetail(qc: QueryClient, plan: PlanDetailView): void {
  qc.setQueryData(keys.plan(plan.id), plan);
  qc.setQueryData<PlanView[]>(keys.plans(plan.boardId), (old) =>
    old?.map((p) => {
      if (p.id !== plan.id) return p;
      const { versions: _v, proposals: _p, changedKeys: _c, addedKeys: _a, specRounds: _s, spec: _t, runs: _r, ...view } = plan;
      return view;
    }),
  );
}

/** All task lists currently in the cache (for the tab-title badge and notification links). */
export function cachedTaskLists(qc: QueryClient): Array<[string, TaskView[]]> {
  return qc
    .getQueriesData<TaskView[]>({ queryKey: keys.tasksPrefix })
    .filter((entry): entry is [readonly unknown[], TaskView[]] => Array.isArray(entry[1]))
    .map(([key, list]) => [String(key[1]), list]);
}
