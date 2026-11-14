// Settles the T3 threads of Done tasks (setting `settleDoneThreads`), so finished work leaves
// T3's active sidebar. Each task is settled once: a `threads_settled` event marks it, so a thread
// the user brings back in T3 stays active.
import { threadStatusGroup } from '@t3-orchestra/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { events, runs, tasks, type BoardRow, type TaskRow } from '../db/schema.ts';
import { childLog } from '../log.ts';
import type { ThreadSummary } from '../t3/T3Client.ts';
import { errorMessage } from '../util.ts';
import { addEvent, emitTask, type EngineContext } from './context.ts';

const log = childLog('settle');

/** After a failed attempt, a task waits this long before the next one. */
const RETRY_MS = 5 * 60_000;

export class ThreadSettler {
  private readonly retryAt = new Map<string, number>();

  constructor(private readonly ctx: EngineContext) {}

  /** `summaries`: the board project's `thread list`, which says which threads are settled already. */
  async run(board: BoardRow, summaries: Map<string, ThreadSummary>): Promise<void> {
    const { ctx } = this;
    if (!ctx.settings.get().settleDoneThreads) return;
    const now = Date.now();
    const done = ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.boardId, board.id), eq(tasks.stage, 'done')))
      .all()
      .filter((t) => (this.retryAt.get(t.id) ?? 0) <= now);
    if (!done.length) return;
    const marked = new Set(
      ctx.db
        .select({ taskId: events.taskId })
        .from(events)
        .where(and(inArray(events.taskId, done.map((t) => t.id)), eq(events.type, 'threads_settled')))
        .all()
        .map((e) => e.taskId),
    );
    const due = done.filter((t) => !marked.has(t.id));
    if (!due.length) return;

    const plan = new Map<TaskRow, string[]>();
    for (const task of due) {
      const ids = this.threadIdsOf(task)
        .map((id) => summaries.get(id))
        .filter((s): s is ThreadSummary => s !== undefined && s.settled !== true);
      // Someone is still talking to the agent: wait until that turn ends.
      if (ids.some((s) => ['active', 'attention'].includes(threadStatusGroup(s)))) continue;
      plan.set(task, ids.map((s) => s.threadId));
    }
    if (!plan.size) return;
    const all = [...plan.values()].flat();

    let results;
    try {
      results = new Map((all.length ? await ctx.t3.settleThreads(all) : []).map((r) => [r.threadId, r]));
    } catch (err) {
      log.warn({ boardId: board.id, threads: all.length, err: errorMessage(err) }, 'could not settle threads; retrying later');
      for (const task of plan.keys()) this.retryAt.set(task.id, now + RETRY_MS);
      return;
    }

    for (const [task, ids] of plan) {
      // A thread that no longer exists has nothing left to settle.
      const failed = ids.map((id) => results.get(id)).filter((r) => r && !r.ok && !r.notFound);
      if (failed.length) {
        log.warn({ taskId: task.id, errors: failed.map((r) => r!.error) }, 'could not settle task threads; retrying later');
        this.retryAt.set(task.id, now + RETRY_MS);
        continue;
      }
      this.retryAt.delete(task.id);
      addEvent(ctx.db, { boardId: board.id, taskId: task.id, type: 'threads_settled', payload: { threads: ids.length } });
      emitTask(ctx, task.id);
    }
    const settled = [...results.values()].filter((r) => r.ok).length;
    if (settled) log.info({ boardId: board.id, threads: settled }, 'settled the threads of done tasks in T3');
  }

  /** The task thread (every attempt's) and its review threads. */
  private threadIdsOf(task: TaskRow): string[] {
    const fromRuns = this.ctx.db
      .select({ threadId: runs.threadId })
      .from(runs)
      .where(and(eq(runs.taskId, task.id), isNotNull(runs.threadId)))
      .all()
      .map((r) => r.threadId!);
    return [...new Set([task.threadId, ...fromRuns].filter((id): id is string => !!id))];
  }
}
