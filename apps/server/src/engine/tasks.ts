// Manual tasks, follow-ups and edits (spec §5.9, §11.3 PATCH /api/tasks/:id).
import { findCycle, type CreateTaskBody, type PatchTaskBody } from '@t3-orchestra/shared';
import { and, eq, inArray, max, min, ne } from 'drizzle-orm';
import { boards, taskDeps, tasks, type TaskRow } from '../db/schema.ts';
import { firstLine, newId, nowIso } from '../util.ts';
import { addEvent, AppError, emitTask, getBoardOrThrow, getTaskOrThrow, type EngineContext } from './context.ts';
import { checkMilestone } from './milestones.ts';

function blankTask(boardId: string, number: number, position: number): TaskRow {
  const now = nowIso();
  return {
    id: newId(),
    boardId,
    number,
    planId: null,
    planKey: null,
    followUpOf: null,
    followUpText: null,
    milestoneId: null,
    dismissedFollowUps: [],
    title: '',
    description: '',
    acceptanceCriteria: [],
    category: 'feature',
    complexity: 'medium',
    priority: 'medium',
    touches: [],
    position,
    stage: 'backlog',
    stageReason: null,
    attention: null,
    threadId: null,
    threadLink: null,
    branch: null,
    worktreePath: null,
    attempt: 1,
    fixRound: 0,
    reviewRound: 0,
    reviewScore: null,
    reviewScoreReason: null,
    skipAiReview: false,
    runNext: false,
    providerOverride: null,
    modelOverride: null,
    lastResult: null,
    lastSummary: null,
    lastMessage: null,
    resultMissing: false,
    prUrl: null,
    lastThreadStatus: null,
    lastItemCount: null,
    lastActivityAt: null,
    diffStat: null,
    startedAt: null,
    completedAt: null,
    activitySinceReview: false,
    lastT3RunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Checks that `deps` are tasks of the board and that `taskId → deps` keeps the graph acyclic. */
function checkDeps(ctx: EngineContext, boardId: string, taskId: string, deps: string[]): void {
  if (deps.includes(taskId)) throw new AppError('DEP_CYCLE', 'a task cannot depend on itself');
  if (deps.length) {
    const found = ctx.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.boardId, boardId), inArray(tasks.id, deps))).all();
    if (found.length !== new Set(deps).size) throw new AppError('VALIDATION', 'dependencies must be tasks of the same board');
  }
  const boardTaskIds = ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.boardId, boardId)).all().map((t) => t.id);
  const edges = ctx.db.select().from(taskDeps).where(inArray(taskDeps.taskId, boardTaskIds.length ? boardTaskIds : [''])).all();
  const nodes = new Map<string, string[]>(boardTaskIds.map((id) => [id, []]));
  for (const e of edges) if (e.taskId !== taskId) nodes.get(e.taskId)?.push(e.dependsOnTaskId);
  nodes.set(taskId, deps);
  const cycle = findCycle([...nodes].map(([key, dependsOn]) => ({ key, dependsOn })));
  if (cycle) {
    const nums = ctx.db.select({ id: tasks.id, n: tasks.number }).from(tasks).where(inArray(tasks.id, cycle)).all();
    const byId = new Map(nums.map((r) => [r.id, `#${r.n}`]));
    throw new AppError('DEP_CYCLE', `dependency cycle: ${cycle.map((id) => byId.get(id) ?? 'new task').join(' → ')}`, 400, { cycle });
  }
}

export function createTask(ctx: EngineContext, boardId: string, body: CreateTaskBody, extra: Partial<TaskRow> = {}): TaskRow {
  getBoardOrThrow(ctx, boardId);
  const id = newId();
  checkDeps(ctx, boardId, id, body.dependsOn);
  checkMilestone(ctx, boardId, body.milestoneId);
  let row!: TaskRow;
  ctx.db.transaction((tx) => {
    const b = tx.select({ n: boards.nextTaskNumber }).from(boards).where(eq(boards.id, boardId)).get()!;
    const top = tx.select({ p: max(tasks.position) }).from(tasks).where(eq(tasks.boardId, boardId)).get();
    row = {
      ...blankTask(boardId, b.n, (top?.p ?? 0) + 1024),
      id,
      title: body.title,
      description: body.description,
      acceptanceCriteria: body.acceptanceCriteria,
      complexity: body.complexity,
      category: body.category,
      priority: body.priority,
      touches: body.touches,
      providerOverride: body.providerOverride,
      modelOverride: body.modelOverride,
      skipAiReview: body.skipAiReview,
      milestoneId: body.milestoneId,
      ...extra,
    };
    tx.insert(tasks).values(row).run();
    for (const d of new Set(body.dependsOn)) tx.insert(taskDeps).values({ taskId: id, dependsOnTaskId: d }).run();
    tx.update(boards).set({ nextTaskNumber: b.n + 1, updatedAt: nowIso() }).where(eq(boards.id, boardId)).run();
    addEvent(tx, { boardId, taskId: id, type: 'stage_changed', payload: { event: 'user.create', from: null, to: row.stage, actor: 'user' } });
  });
  emitTask(ctx, id);
  return row;
}

/**
 * "Add as task" on a follow-up suggestion (spec §9.3). Each suggestion becomes at most one live task.
 * It lands in Backlog unless `stage` says Ready (the Roadmap's suggestions inbox uses the board's acceptInto).
 */
export function createFollowUp(
  ctx: EngineContext,
  taskId: string,
  text: string,
  o: { milestoneId?: string | null; stage?: 'backlog' | 'ready' } = {},
): TaskRow {
  const parent = getTaskOrThrow(ctx, taskId);
  const suggestion = text.trim();
  const existing = ctx.db
    .select({ number: tasks.number })
    .from(tasks)
    .where(and(eq(tasks.followUpOf, parent.id), eq(tasks.followUpText, suggestion), ne(tasks.stage, 'discarded')))
    .get();
  if (existing) throw new AppError('ILLEGAL_TRANSITION', `this follow-up is already #${existing.number}`, 409);
  const title = firstLine(suggestion, 110) || 'Follow-up';
  return createTask(
    ctx,
    parent.boardId,
    {
      title,
      description: `${suggestion}\n\n_Follow-up suggested by the agent on #${parent.number} ${parent.title}._`,
      acceptanceCriteria: [],
      dependsOn: [],
      complexity: 'small',
      category: parent.category,
      priority: 'medium',
      touches: [],
      providerOverride: null,
      modelOverride: null,
      skipAiReview: false,
      milestoneId: o.milestoneId ?? null,
    },
    { followUpOf: parent.id, followUpText: suggestion, stage: o.stage ?? 'backlog' },
  );
}

const CONTENT_FIELDS = ['title', 'description', 'acceptanceCriteria', 'dependsOn', 'complexity', 'category', 'touches'] as const;

export function patchTask(ctx: EngineContext, taskId: string, body: PatchTaskBody): TaskRow {
  const task = getTaskOrThrow(ctx, taskId);
  if (task.stage === 'discarded') throw new AppError('ILLEGAL_TRANSITION', 'discarded tasks cannot be edited', 409);
  const editingContent = CONTENT_FIELDS.some((f) => body[f] !== undefined);
  // Content is only editable before the agent starts (or for Edit & retry on a failed task).
  // Removing a dependency is always allowed ("Remove dependency" on a blocked card).
  const onlyRemovesDeps =
    CONTENT_FIELDS.every((f) => f === 'dependsOn' || body[f] === undefined) &&
    body.dependsOn !== undefined &&
    body.dependsOn.every((d) => currentDeps(ctx, taskId).includes(d));
  if (editingContent && !['backlog', 'ready', 'failed'].includes(task.stage) && !onlyRemovesDeps) {
    throw new AppError('ILLEGAL_TRANSITION', `#${task.number} can only be edited in Backlog, Ready or Failed`, 409);
  }
  if (body.dependsOn) checkDeps(ctx, task.boardId, taskId, body.dependsOn);
  checkMilestone(ctx, task.boardId, body.milestoneId);
  if (body.runNext && task.stage !== 'ready') {
    throw new AppError('ILLEGAL_TRANSITION', `only Ready tasks can run next (#${task.number} is in ${task.stage})`, 409);
  }

  const { dependsOn, ...fields } = body;
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<TaskRow>;
  let unpinned: string[] = [];
  ctx.db.transaction((tx) => {
    if (body.runNext) {
      // One "run next" task per board, moved to the top of Ready so the column shows it first.
      unpinned = tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.boardId, task.boardId), eq(tasks.runNext, true), ne(tasks.id, taskId)))
        .all()
        .map((r) => r.id);
      if (unpinned.length) tx.update(tasks).set({ runNext: false, updatedAt: nowIso() }).where(inArray(tasks.id, unpinned)).run();
      if (body.position === undefined) {
        const top = tx
          .select({ p: min(tasks.position) })
          .from(tasks)
          .where(and(eq(tasks.boardId, task.boardId), eq(tasks.stage, 'ready'), ne(tasks.id, taskId)))
          .get()?.p;
        if (top != null && top <= task.position) set.position = top - 1024;
      }
    }
    if (Object.keys(set).length) tx.update(tasks).set({ ...set, updatedAt: nowIso() }).where(eq(tasks.id, taskId)).run();
    if (dependsOn) {
      tx.delete(taskDeps).where(eq(taskDeps.taskId, taskId)).run();
      for (const d of new Set(dependsOn)) tx.insert(taskDeps).values({ taskId, dependsOnTaskId: d }).run();
    }
    const changed = [...Object.keys(set), ...(dependsOn ? ['dependsOn'] : [])].filter((k) => k !== 'position');
    if (changed.length) addEvent(tx, { boardId: task.boardId, taskId, type: 'task_edited', payload: { fields: changed } });
  });
  emitTask(ctx, taskId);
  for (const id of unpinned) emitTask(ctx, id);
  if (
    dependsOn ||
    body.priority ||
    body.position !== undefined ||
    body.touches ||
    body.milestoneId !== undefined ||
    body.runNext !== undefined
  ) {
    ctx.kick();
  }
  return getTaskOrThrow(ctx, taskId);
}

function currentDeps(ctx: EngineContext, taskId: string): string[] {
  return ctx.db
    .select({ d: taskDeps.dependsOnTaskId })
    .from(taskDeps)
    .where(eq(taskDeps.taskId, taskId))
    .all()
    .map((r) => r.d);
}
