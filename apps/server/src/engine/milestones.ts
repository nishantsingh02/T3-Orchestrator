// Milestones (a board's phases, M1, M2…) and the inbox of agent follow-up suggestions.
import {
  ImplementResult,
  type AddSuggestionsBody,
  type CreateMilestoneBody,
  type DismissSuggestionsBody,
  type PatchMilestoneBody,
  type SuggestionRef,
  type SuggestionView,
} from '@t3-orchestra/shared';
import { and, asc, eq, isNotNull, max, ne } from 'drizzle-orm';
import { boards, milestones, tasks, type MilestoneRow, type TaskRow } from '../db/schema.ts';
import { milestoneView } from '../db/views.ts';
import { newId, nowIso } from '../util.ts';
import { addEvent, AppError, emitTask, getBoardOrThrow, type DbOrTx, type EngineContext } from './context.ts';
import { createFollowUp } from './tasks.ts';

export function listMilestones(db: DbOrTx, boardId: string): MilestoneRow[] {
  return db.select().from(milestones).where(eq(milestones.boardId, boardId)).orderBy(asc(milestones.position), asc(milestones.number)).all();
}

function getMilestoneOrThrow(ctx: EngineContext, id: string): MilestoneRow {
  const m = ctx.db.select().from(milestones).where(eq(milestones.id, id)).get();
  if (!m) throw new AppError('NOT_FOUND', `milestone ${id} not found`, 404);
  return m;
}

/** Throws unless `milestoneId` is null/undefined or a milestone of the board. */
export function checkMilestone(ctx: EngineContext, boardId: string, milestoneId: string | null | undefined): void {
  if (!milestoneId) return;
  const m = ctx.db.select({ boardId: milestones.boardId }).from(milestones).where(eq(milestones.id, milestoneId)).get();
  if (m?.boardId !== boardId) throw new AppError('VALIDATION', 'the milestone must belong to the same board');
}

/** Inserts a milestone after the board's last one (inside the caller's transaction). */
export function insertMilestone(tx: DbOrTx, boardId: string, body: { title: string; goal: string; planId?: string | null }): MilestoneRow {
  const b = tx.select({ n: boards.nextMilestoneNumber }).from(boards).where(eq(boards.id, boardId)).get()!;
  const top = tx.select({ p: max(milestones.position) }).from(milestones).where(eq(milestones.boardId, boardId)).get();
  const now = nowIso();
  const row: MilestoneRow = {
    id: newId(),
    boardId,
    number: b.n,
    title: body.title.trim(),
    goal: body.goal.trim(),
    position: (top?.p ?? 0) + 1024,
    planId: body.planId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(milestones).values(row).run();
  tx.update(boards).set({ nextMilestoneNumber: b.n + 1, updatedAt: now }).where(eq(boards.id, boardId)).run();
  addEvent(tx, { boardId, type: 'milestone_created', payload: { id: row.id, number: row.number, title: row.title, planId: row.planId } });
  return row;
}

export function emitMilestone(ctx: EngineContext, id: string): void {
  const m = ctx.db.select().from(milestones).where(eq(milestones.id, id)).get();
  if (m) ctx.bus.emit('milestone', milestoneView(m));
}

export function createMilestone(ctx: EngineContext, boardId: string, body: CreateMilestoneBody): MilestoneRow {
  getBoardOrThrow(ctx, boardId);
  const row = ctx.db.transaction((tx) => insertMilestone(tx, boardId, body));
  emitMilestone(ctx, row.id);
  return row;
}

export function patchMilestone(ctx: EngineContext, id: string, body: PatchMilestoneBody): MilestoneRow {
  const m = getMilestoneOrThrow(ctx, id);
  const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<MilestoneRow>;
  if (Object.keys(set).length) {
    ctx.db.update(milestones).set({ ...set, updatedAt: nowIso() }).where(eq(milestones.id, id)).run();
    // Order changes which tasks auto-run picks first.
    if (body.position !== undefined) ctx.kick();
  }
  emitMilestone(ctx, id);
  return getMilestoneOrThrow(ctx, m.id);
}

/** Deletes the milestone; its tasks stay, without a milestone. */
export function deleteMilestone(ctx: EngineContext, id: string): void {
  const m = getMilestoneOrThrow(ctx, id);
  const affected = ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.milestoneId, id)).all();
  ctx.db.transaction((tx) => {
    tx.update(tasks).set({ milestoneId: null, updatedAt: nowIso() }).where(eq(tasks.milestoneId, id)).run();
    tx.delete(milestones).where(eq(milestones.id, id)).run();
    addEvent(tx, { boardId: m.boardId, type: 'milestone_deleted', payload: { id, number: m.number, title: m.title, tasks: affected.length } });
  });
  ctx.bus.emit('milestone_removed', { id, boardId: m.boardId });
  for (const t of affected) emitTask(ctx, t.id);
  ctx.kick();
}

// ---- suggestions inbox -------------------------------------------------------------

function followUpsOf(t: TaskRow): string[] {
  const parsed = ImplementResult.safeParse(t.lastResult);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.followUps.map((f) => f.trim()).filter(Boolean))];
}

/** Follow-ups the agents suggested that are not added as a live task and not dismissed, newest task first. */
export function boardSuggestions(ctx: EngineContext, boardId: string): SuggestionView[] {
  const rows = ctx.db.select().from(tasks).where(and(eq(tasks.boardId, boardId), ne(tasks.stage, 'discarded'))).all();
  const added = new Set(
    ctx.db
      .select({ of: tasks.followUpOf, text: tasks.followUpText })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), ne(tasks.stage, 'discarded'), isNotNull(tasks.followUpOf)))
      .all()
      .map((r) => `${r.of}\n${r.text?.trim()}`),
  );
  const out: SuggestionView[] = [];
  for (const t of rows.sort((a, b) => b.number - a.number)) {
    const dismissed = new Set(t.dismissedFollowUps);
    for (const text of followUpsOf(t)) {
      if (dismissed.has(text) || added.has(`${t.id}\n${text}`)) continue;
      out.push({ taskId: t.id, taskNumber: t.number, taskTitle: t.title, taskStage: t.stage, milestoneId: t.milestoneId, text });
    }
  }
  return out;
}

function groupByTask(items: readonly SuggestionRef[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of items) out.set(i.taskId, [...(out.get(i.taskId) ?? []), i.text.trim()]);
  return out;
}

function boardTasksOrThrow(ctx: EngineContext, boardId: string, ids: Iterable<string>): TaskRow[] {
  return [...ids].map((id) => {
    const t = ctx.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (t?.boardId !== boardId) throw new AppError('VALIDATION', 'suggestions must come from tasks of this board');
    return t;
  });
}

/** Adds suggestions as tasks (into the milestone, landing where accepted plan tasks land). Already-added ones are skipped. */
export function addSuggestions(ctx: EngineContext, boardId: string, body: AddSuggestionsBody): TaskRow[] {
  const board = getBoardOrThrow(ctx, boardId);
  checkMilestone(ctx, boardId, body.milestoneId);
  const byTask = groupByTask(body.items);
  boardTasksOrThrow(ctx, boardId, byTask.keys());
  const created: TaskRow[] = [];
  for (const [taskId, texts] of byTask) {
    for (const text of texts) {
      try {
        created.push(createFollowUp(ctx, taskId, text, { milestoneId: body.milestoneId, stage: board.acceptInto }));
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'ILLEGAL_TRANSITION')) throw err;
      }
    }
  }
  if (created.length) ctx.kick();
  return created;
}

export function dismissSuggestions(ctx: EngineContext, boardId: string, body: DismissSuggestionsBody): void {
  const byTask = groupByTask(body.items);
  const rows = boardTasksOrThrow(ctx, boardId, byTask.keys());
  ctx.db.transaction((tx) => {
    for (const t of rows) {
      const texts = byTask.get(t.id)!;
      const next = body.undo
        ? t.dismissedFollowUps.filter((x) => !texts.includes(x))
        : [...new Set([...t.dismissedFollowUps, ...texts])];
      tx.update(tasks).set({ dismissedFollowUps: next }).where(eq(tasks.id, t.id)).run();
    }
    addEvent(tx, { boardId, type: body.undo ? 'suggestions_restored' : 'suggestions_dismissed', payload: { count: body.items.length } });
  });
}
