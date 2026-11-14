// transition(): the ONLY writer of tasks.stage (spec §6.3).
import { resolveTransition, type Stage, type StageReason, type TaskEvent } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { boards, tasks, type TaskRow } from '../db/schema.ts';
import { childLog } from '../log.ts';
import { nowIso } from '../util.ts';
import { addEvent, emitTask, type DbOrTx, type EngineContext } from './context.ts';

const log = childLog('transition');

/** Task fields a transition may update alongside the stage (never `stage`/`stageReason` themselves). */
export type TaskPatch = Partial<Omit<TaskRow, 'id' | 'boardId' | 'number' | 'stage' | 'stageReason' | 'createdAt'>>;

export type TransitionResult =
  | { ok: true; task: TaskRow; from: Stage; to: Stage; reason: StageReason | null }
  | { ok: false; task: TaskRow | null; from: Stage | null; illegal: true };

export interface TransitionOptions {
  patch?: TaskPatch | ((task: TaskRow) => TaskPatch);
  runId?: string | null;
  actor?: 'user' | 'scheduler' | 'reconciler' | 'system';
  payload?: Record<string, unknown>;
  /** Extra writes that must commit atomically with the stage change. */
  also?: (tx: DbOrTx, task: TaskRow) => void;
}

/**
 * Applies `event` to the task inside one SQLite transaction. Illegal transitions are logged
 * as `illegal_transition` events and ignored (never thrown). Emits the task over SSE on success.
 */
export function transition(ctx: EngineContext, taskId: string, event: TaskEvent, o: TransitionOptions = {}): TransitionResult {
  const result = applyTransition(ctx.db, taskId, event, o);
  if (result.ok) {
    emitTask(ctx, taskId);
    if (result.to === 'done' || result.to === 'discarded') checkBoardDone(ctx, result.task.boardId);
    ctx.kick();
  } else {
    log.warn({ taskId, event: event.type, from: result.from }, 'illegal transition ignored');
  }
  return result;
}

/** "Board <name>: all tasks done" once every non-discarded task is done (spec §12). */
function checkBoardDone(ctx: EngineContext, boardId: string): void {
  const rows = ctx.db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.boardId, boardId)).all();
  const live = rows.filter((r) => r.stage !== 'discarded');
  if (live.length === 0 || live.some((r) => r.stage !== 'done')) return;
  const board = ctx.db.select({ name: boards.name }).from(boards).where(eq(boards.id, boardId)).get();
  ctx.notifier.notify({ type: 'board_done', boardId, dedupe: `done-${live.length}`, title: `Board ${board?.name ?? ''}: all tasks done 🎉`, body: `${live.length} tasks done` });
}

export function applyTransition(db: Db, taskId: string, event: TaskEvent, o: TransitionOptions = {}): TransitionResult {
  return db.transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return { ok: false as const, task: null, from: null, illegal: true as const };
    const target = resolveTransition(task.stage, event);
    if (!target) {
      addEvent(tx, {
        boardId: task.boardId,
        taskId,
        runId: o.runId,
        type: 'illegal_transition',
        payload: { event: event.type, from: task.stage, ...o.payload },
      });
      return { ok: false as const, task, from: task.stage, illegal: true as const };
    }
    const now = nowIso();
    const patch = typeof o.patch === 'function' ? o.patch(task) : (o.patch ?? {});
    const leavingActive = target.to !== 'implementing' && target.to !== 'ai_review';
    const update: Partial<TaskRow> = {
      ...patch,
      stage: target.to,
      stageReason: target.reason,
      updatedAt: now,
    };
    // Attention only lives on active stages; the reconciler re-derives it.
    if (leavingActive || target.to !== task.stage) update.attention = patch.attention ?? null;
    // "Run next" only means something while the task waits in Ready.
    if (target.to !== 'ready') update.runNext = false;
    if (target.to === 'implementing' && !task.startedAt) update.startedAt = now;
    if (target.to === 'done') update.completedAt = now;
    if (target.to === 'human_review' && task.stage !== 'human_review') update.activitySinceReview = false;
    // The code is about to change, so the last review's score no longer describes it.
    if (target.to === 'implementing') Object.assign(update, { reviewScore: null, reviewScoreReason: null });

    tx.update(tasks).set(update).where(eq(tasks.id, taskId)).run();
    addEvent(tx, {
      boardId: task.boardId,
      taskId,
      runId: o.runId,
      type: 'stage_changed',
      payload: { event: event.type, from: task.stage, to: target.to, reason: target.reason, actor: o.actor ?? 'system', ...o.payload },
    });
    const updated = { ...task, ...update } as TaskRow;
    o.also?.(tx, updated);
    return { ok: true as const, task: updated, from: task.stage, to: target.to, reason: target.reason };
  });
}
