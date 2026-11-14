// Everything the engine modules share.
import type { ErrorCode } from '@t3-orchestra/shared';
import { eq } from 'drizzle-orm';
import type { Bus } from '../bus.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { boards, events, ideaBatches, ideas, insightMessages, tasks } from '../db/schema.ts';
import { boardView, getInsightChatRow, getPlanRow, ideaBatchView, ideaView, insightChatView, insightMessageView, planView, taskView } from '../db/views.ts';
import type { Notifier } from '../notify/notifier.ts';
import type { SettingsStore } from '../settings.ts';
import type { HealthMonitor } from '../t3/health.ts';
import type { T3Client } from '../t3/T3Client.ts';
import { nowIso } from '../util.ts';
import { backgroundLabel, type BackgroundWatch } from './background.ts';
import type { PromptStore } from './prompts.ts';

export interface EngineContext {
  db: Db;
  t3: T3Client;
  bus: Bus;
  settings: SettingsStore;
  notifier: Notifier;
  health: HealthMonitor;
  prompts: PromptStore;
  config: Config;
  /** Asks the scheduler to run soon (after a task event). Set by the engine. */
  kick: () => void;
  /** HTTP for marketing metric sources (tests swap in a fake). */
  fetch: typeof fetch;
  /** Runs whose ended turn waits on background work (filled by the reconciler). */
  background: BackgroundWatch;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type DbOrTx = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

export function addEvent(
  db: DbOrTx,
  e: { boardId: string; taskId?: string | null; planId?: string | null; runId?: string | null; type: string; payload?: Record<string, unknown> },
): void {
  db.insert(events)
    .values({
      boardId: e.boardId,
      taskId: e.taskId ?? null,
      planId: e.planId ?? null,
      runId: e.runId ?? null,
      type: e.type,
      payload: e.payload ?? {},
      createdAt: nowIso(),
    })
    .run();
}

export function viewCtx(ctx: EngineContext) {
  return {
    staleAfterMinutes: ctx.settings.get().staleAfterMinutes,
    backgroundOf: (runId: string) => ctx.background.workOf(runId).map(backgroundLabel),
  };
}

/** Pushes the task (and its board's counts) to SSE clients. */
export function emitTask(ctx: EngineContext, taskId: string): void {
  const v = taskView(ctx.db, taskId, viewCtx(ctx));
  if (!v) return;
  ctx.bus.emit('task', v);
  emitBoard(ctx, v.boardId);
}

export function emitBoard(ctx: EngineContext, boardId: string): void {
  const b = ctx.db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (b) ctx.bus.emit('board', boardView(ctx.db, b));
}

export function emitPlan(ctx: EngineContext, planId: string): void {
  const p = getPlanRow(ctx.db, planId);
  if (p) ctx.bus.emit('plan', planView(p));
}

/** Pushes an Insights chat's summary to SSE clients. */
export function emitInsightChat(ctx: EngineContext, chatId: string): void {
  const c = getInsightChatRow(ctx.db, chatId);
  if (c) ctx.bus.emit('insight_chat', insightChatView(ctx.db, c));
}

/** Pushes an Insights message and its chat's summary. */
export function emitInsightMessage(ctx: EngineContext, messageId: string): void {
  const m = ctx.db.select().from(insightMessages).where(eq(insightMessages.id, messageId)).get();
  if (!m) return;
  ctx.bus.emit('insight_message', insightMessageView(m));
  emitInsightChat(ctx, m.chatId);
}

/** Pushes an idea generation (status, idea count) to SSE clients. */
export function emitIdeaBatch(ctx: EngineContext, batchId: string): void {
  const b = ctx.db.select().from(ideaBatches).where(eq(ideaBatches.id, batchId)).get();
  if (b) ctx.bus.emit('idea_batch', ideaBatchView(ctx.db, b));
}

export function emitIdea(ctx: EngineContext, ideaId: string): void {
  const i = ctx.db.select().from(ideas).where(eq(ideas.id, ideaId)).get();
  if (i) ctx.bus.emit('idea', ideaView(ctx.db, i));
}

export function getTaskOrThrow(ctx: EngineContext, id: string) {
  const t = ctx.db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!t) throw new AppError('NOT_FOUND', `task ${id} not found`, 404);
  return t;
}

export function getBoardOrThrow(ctx: EngineContext, id: string) {
  const b = ctx.db.select().from(boards).where(eq(boards.id, id)).get();
  if (!b) throw new AppError('NOT_FOUND', `board ${id} not found`, 404);
  return b;
}
