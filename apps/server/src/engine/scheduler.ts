// Auto-run scheduler (spec §7). Runs after every reconcile tick and after task events.
import { overlapsActive, PRIORITY_RANK, SLOT_STAGES } from '@t3-orchestra/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { boards, milestones, taskDeps, tasks, type TaskRow } from '../db/schema.ts';
import { childLog } from '../log.ts';
import { errorMessage } from '../util.ts';
import type { EngineContext } from './context.ts';
import { startTaskThread } from './runs.ts';

const log = childLog('scheduler');

export interface ScheduleDecision {
  boardId: string;
  slots: number;
  start: TaskRow[];
}

/** Pure-ish planning step: which tasks should start now. */
export function planStarts(ctx: EngineContext): ScheduleDecision[] {
  const s = ctx.settings.get();
  if (s.pauseAll || !ctx.health.healthy()) return [];
  const activeAll = ctx.db.select().from(tasks).where(inArray(tasks.stage, [...SLOT_STAGES])).all();
  let globalSlots = s.globalMaxParallel - activeAll.length;
  const decisions: ScheduleDecision[] = [];

  const autoBoards = ctx.db.select().from(boards).where(and(eq(boards.autoRun, true), isNull(boards.archivedAt))).all();
  for (const board of autoBoards) {
    if (globalSlots <= 0) break;
    const active = activeAll.filter((t) => t.boardId === board.id);
    const slots = Math.min(board.maxParallel - active.length, globalSlots);
    if (slots <= 0) continue;

    const ready = ctx.db.select().from(tasks).where(and(eq(tasks.boardId, board.id), eq(tasks.stage, 'ready'))).all();
    if (ready.length === 0) continue;
    const deps = ctx.db
      .select({ taskId: taskDeps.taskId, stage: tasks.stage })
      .from(taskDeps)
      .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
      .where(inArray(taskDeps.taskId, ready.map((t) => t.id)))
      .all();
    const depsDone = (id: string) => deps.filter((d) => d.taskId === id).every((d) => d.stage === 'done');

    // The "run next" task first, then milestones in order (tasks without one last), then priority, then the column order.
    const milestoneRank = new Map(
      ctx.db
        .select({ id: milestones.id, position: milestones.position })
        .from(milestones)
        .where(eq(milestones.boardId, board.id))
        .all()
        .map((m) => [m.id, m.position]),
    );
    const rank = (t: TaskRow) => (t.milestoneId ? (milestoneRank.get(t.milestoneId) ?? Infinity) : Infinity);
    const activeTouches = active.map((t) => t.touches);
    const candidates = ready
      .filter((t) => depsDone(t.id))
      .sort(
        (a, b) =>
          Number(b.runNext) - Number(a.runNext) ||
          rank(a) - rank(b) ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.position - b.position ||
          a.number - b.number,
      );
    const start: TaskRow[] = [];
    for (const t of candidates) {
      if (start.length >= slots) break;
      // Overlap is checked against running tasks and against tasks picked in this pass; "run next" skips it.
      if (board.avoidOverlap && !t.runNext && overlapsActive(t.touches, [...activeTouches, ...start.map((x) => x.touches)])) continue;
      start.push(t);
    }
    if (start.length) {
      decisions.push({ boardId: board.id, slots, start });
      globalSlots -= start.length;
    }
  }
  return decisions;
}

export class Scheduler {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly ctx: EngineContext) {}

  /** Runs one scheduling pass; calls during a pass coalesce into one more pass. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    for (const d of planStarts(this.ctx)) {
      for (const t of d.start) {
        try {
          log.info({ taskId: t.id, number: t.number }, 'auto-starting task');
          await startTaskThread(this.ctx, t.id, 'scheduler.start', 'scheduler');
        } catch (err) {
          log.warn({ taskId: t.id, err: errorMessage(err) }, 'auto-start failed');
        }
      }
    }
  }
}
